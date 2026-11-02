#!/usr/bin/env node
/**
 * PAID live check: real Gemini Live voice calls against the running app (fixture NammaOps data).
 * Each question is a Windows-TTS WAV fed to Chrome as a fake microphone; the script records the
 * Gemini tool calls, the NammaOps contract each returned, and both transcripts.
 *
 *   node scripts/check-nammaops-voice-live.mjs <questions.json> <out.json>
 *   questions.json: [{ "id": "q01", "agent": "Alice", "wav": "path.raw.wav", "text": "..." }]
 *
 * Costs Gemini Live usage per question. Never runs in CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer";
import { prepareFunctionalOffice } from "./browser-functional-office.mjs";

const origin = process.env.AGENT_TOWN_TEST_ORIGIN ?? "http://localhost:3108";
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const [questionsPath, outPath] = process.argv.slice(2);
if (!questionsPath || !outPath) throw new Error("Usage: <questions.json> <out.json>");
const questions = JSON.parse(readFileSync(questionsPath, "utf8"));
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

/** 6 s of silence before the question and 40 s after, so Chrome's looping capture does not repeat it mid-answer. */
function padWav(input, output) {
  const wav = readFileSync(input);
  let offset = 12;
  let fmt;
  let data;
  while (offset < wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") fmt = wav.subarray(offset + 8, offset + 8 + size);
    if (id === "data") data = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  const rate = fmt.readUInt32LE(4);
  const blockAlign = fmt.readUInt16LE(12);
  const silence = (seconds) => Buffer.alloc(Math.round(rate * seconds) * blockAlign);
  const pcm = Buffer.concat([silence(6), data, silence(40)]);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  fmt.copy(header, 20, 0, 16);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(output, Buffer.concat([header, pcm]));
}

async function ask(question) {
  const wav = question.wav.replace(/\.raw\.wav$/, ".padded.wav");
  padWav(question.wav, wav);
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav.replace(/\\/g, "/")}`,
    ],
  });
  const record = {
    id: question.id,
    agent: question.agent,
    spoken: question.text,
    tools: [],
    transcripts: [],
    errors: [],
  };
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => record.errors.push(error.message));
    page.on("response", async (response) => {
      const url = response.url();
      if (url.endsWith("/api/runtime/voice/actions") && response.request().method() === "POST") {
        const request = JSON.parse(response.request().postData() ?? "{}");
        let body = null;
        try {
          body = await response.json();
        } catch {
          /* ignore */
        }
        record.tools.push({
          at: Date.now(),
          tool: request.tool,
          args: request.args,
          status: response.status(),
          result: body,
        });
      }
      if (url.endsWith("/api/voice/session") && response.request().method() === "POST")
        record.session = { status: response.status() };
    });
    page.on("request", (request) => {
      if (request.url().endsWith("/api/runtime/voice/transcripts") && request.method() === "POST") {
        const turn = JSON.parse(request.postData() ?? "{}");
        record.transcripts.push({
          at: Date.now(),
          role: turn.role,
          content: turn.content,
          interrupted: turn.interrupted,
        });
      }
    });
    await page.evaluateOnNewDocument(() =>
      localStorage.setItem("agent-town:onboarding-done", "true"),
    );
    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${origin}/app`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await prepareFunctionalOffice(page);
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll(".topbar-agent-pill")].some((b) => b.title.startsWith(name)),
      { timeout: 120000 },
      question.agent,
    );
    await page.click(".hud-chat-dock__btn");
    await page.waitForSelector(".chat-mode-switch button:nth-child(2)");
    await page.click(".chat-mode-switch button:nth-child(2)");
    await page.waitForSelector("#chat-agent");
    const value = await page.$eval(
      "#chat-agent",
      (select, name) =>
        [...select.options].find((option) => option.textContent.trim() === name)?.value,
      question.agent,
    );
    if (!value) throw new Error(`${question.agent} is not selectable in voice mode`);
    await page.select("#chat-agent", value);
    await page.waitForFunction(
      () => !document.querySelector(".chat-voice-buttons button")?.disabled,
      { timeout: 60000 },
    );
    const started = Date.now();
    await page.click(".chat-voice-buttons button");
    // Done when the assistant has spoken after the last tool result and 7 s pass with no new turn.
    const deadline = started + 75000;
    let last = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const assistant = record.transcripts.filter((turn) => turn.role === "assistant");
      const lastTool = record.tools.at(-1)?.at ?? 0;
      // The answer is an assistant turn after both the latest question and the latest tool result.
      const lastUser = Math.max(
        0,
        ...record.transcripts.filter((t) => t.role === "user").map((t) => t.at),
      );
      const answered = lastUser
        ? assistant.filter((turn) => turn.at > Math.max(lastTool, lastUser))
        : [];
      const newest = Math.max(0, ...record.transcripts.map((turn) => turn.at), lastTool);
      if (answered.length && Date.now() - newest > 7000) break;
      last = newest;
    }
    record.state = await page.$eval(".chat-voice-state", (el) => el.textContent).catch(() => null);
    record.seconds = Math.round((Date.now() - started) / 1000);
    void last;
    // End the call through the UI so the server finalizes it.
    await page.$$eval(".chat-voice-buttons button", (buttons) => {
      const end = buttons.find((button) =>
        /end|stop|hang/i.test(button.textContent + button.title),
      );
      end?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error) {
    record.errors.push(String(error.message ?? error));
  } finally {
    await browser.close();
  }
  return record;
}

const results = [];
for (const question of questions) {
  if (only && !only.has(question.id)) continue;
  const record = await ask(question);
  results.push(record);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  const tools = record.tools
    .map((row) => `${row.tool}(${JSON.stringify(row.args)})->${row.result?.status ?? row.status}`)
    .join(" | ");
  console.log(`${record.id} ${record.agent} [${record.seconds ?? "?"}s] tools: ${tools || "none"}`);
  for (const turn of record.transcripts) console.log(`   ${turn.role}: ${turn.content}`);
  if (record.errors.length) console.log(`   errors: ${record.errors.join("; ")}`);
}
