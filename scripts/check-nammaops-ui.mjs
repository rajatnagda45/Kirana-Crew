/**
 * Browser verification of the NammaOps panel against a running app (fixture ERP data).
 * Drives the real UI: toolbar button, workforce setup, the three workflows, and the owner's
 * PIN approval and rejection. Saves a screenshot after each step.
 *
 *   NAMMAOPS_UI_PIN=<owner pin> node scripts/check-nammaops-ui.mjs [--url http://localhost:3108] [--out <dir>]
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const origin = arg("--url", "http://localhost:3108");
const out = arg("--out", "nammaops-ui-check");
const pin = process.env.NAMMAOPS_UI_PIN;
if (!pin) throw new Error("Set NAMMAOPS_UI_PIN to the app's NAMMAOPS_OWNER_PIN.");
mkdirSync(out, { recursive: true });
const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path) => existsSync(path));

const browser = await puppeteer.launch({ headless: true, executablePath, args: ["--disable-gpu"] });
const log = (step, detail) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}${detail ? `: ${detail}` : ""}`);
try {
  const page = await browser.newPage();
  const errors = [];
  const failures = [];
  page.on("response", (response) => {
    if (response.status() >= 400)
      failures.push({ status: response.status(), url: new URL(response.url()).pathname });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  const shot = async (name) => {
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: false });
    log("screenshot", join(out, `${name}.png`));
  };
  const panelText = () => page.$eval(".hud-flyout", (element) => element.innerText);
  const clickButton = (label) =>
    page.evaluate((text) => {
      const button = [...document.querySelectorAll(".hud-flyout button")].find(
        (element) => element.textContent.trim() === text && !element.disabled,
      );
      if (!button) return false;
      button.click();
      return true;
    }, label);
  const waitForText = (predicate, timeout = 60000) =>
    page.waitForFunction(predicate, { timeout, polling: 500 });

  await page.goto(`${origin}/app`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-dock-id="nammaops"]', { timeout: 120000 });
  log("app loaded", origin);
  // Clicks before hydration are lost, so retry until the flyout appears.
  for (let attempt = 1; ; attempt += 1) {
    await page.click('[data-dock-id="nammaops"]');
    const opened = await page
      .waitForFunction(
        () => document.querySelector(".hud-flyout__title")?.textContent === "NammaOps",
        {
          timeout: 4000,
        },
      )
      .then(() => true)
      .catch(() => false);
    if (opened) break;
    if (attempt === 10) throw new Error("NammaOps panel did not open.");
  }
  log("NammaOps panel opened");
  await shot("01-panel");

  if (await clickButton("Set up workforce")) {
    log("setting up workforce");
    await waitForText(
      () => document.querySelector(".hud-flyout")?.innerText.includes("Procurement Agent"),
      120000,
    );
  }
  const workforce = await panelText();
  for (const name of [
    "Manager Agent",
    "Inventory Agent",
    "Sales Agent",
    "Procurement Agent",
    "Finance Agent",
  ])
    assert.match(workforce, new RegExp(name), `${name} missing from the workforce table`);
  assert.match(workforce, /test fixture/, "fixture data source not disclosed");
  log("workforce", "five agents shown");
  await shot("02-workforce");

  const runWorkflow = async (exampleLabel, done) => {
    assert.ok(await clickButton(exampleLabel), `example button ${exampleLabel} not found`);
    assert.ok(await clickButton("Run"), "Run button not clickable");
    await waitForText(done, 120000);
    const text = await panelText();
    const status =
      /\n(completed|awaiting_approval|partial|blocked|failed|needs_clarification)\s/.exec(
        text,
      )?.[1];
    log(`${exampleLabel} workflow`, status);
    return text;
  };

  const stock = await runWorkflow(
    "Stock",
    () =>
      /\nInventory\n/.test(document.querySelector(".hud-flyout")?.innerText ?? "") &&
      /item\(s\) to buy tomorrow|above their reorder level/.test(
        document.querySelector(".hud-flyout")?.innerText ?? "",
      ),
  );
  assert.match(stock, /Toned Milk 500ml/);
  assert.match(stock, /buy 60/);
  await shot("03-stock-check");

  const reorder = await runWorkflow(
    "Reorder",
    () =>
      (document.querySelector(".hud-flyout")?.innerText ?? "").includes("Purchase approval") &&
      (document.querySelector(".hud-flyout")?.innerText ?? "").includes("ready for your approval"),
  );
  const orders = [...reorder.matchAll(/(PUR-ORD-FX-\d{4}) · ([^·\n]+) · total ([\d.]+)/g)].map(
    (m) => ({ name: m[1], supplier: m[2].trim(), total: m[3] }),
  );
  log("draft orders shown", JSON.stringify(orders));
  assert.ok(orders.length >= 1, "no draft purchase order shown");
  await shot("04-reorder-drafts");

  const typePin = async (value) => {
    const input = await page.$('.hud-flyout input[type="password"]');
    assert.ok(input, "owner PIN field not shown");
    await input.focus();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await input.type(value);
  };
  await typePin("000000");
  await clickButton("Approve and submit");
  await waitForText(() =>
    /Owner PIN is incorrect/.test(document.querySelector(".hud-flyout")?.innerText ?? ""),
  );
  log("wrong PIN", "refused");
  await shot("05-wrong-pin");

  if (orders.length > 1) {
    await typePin(pin);
    await clickButton("Reject");
    await waitForText(() =>
      /rejected, nothing submitted/.test(document.querySelector(".hud-flyout")?.innerText ?? ""),
    );
    log("first order", "rejected by owner");
  }
  await typePin(pin);
  await clickButton("Approve and submit");
  await waitForText(() =>
    /: submitted\b/.test(document.querySelector(".hud-flyout")?.innerText ?? ""),
  );
  await waitForText(() =>
    /Owner approved; submitted to ERP\./.test(
      document.querySelector(".hud-flyout")?.innerText ?? "",
    ),
  );
  log("order approved", "submitted to ERP fixture");
  await shot("06-approved");

  const report = await runWorkflow("Today's business", () =>
    /Business today/.test(document.querySelector(".hud-flyout")?.innerText ?? ""),
  );
  assert.match(report, /Sales \d+/);
  log("daily report", /Net profit:[^\n]*/.exec(report)?.[0]);
  await shot("07-daily-report");

  const demand = await runWorkflow("Demand", () =>
    /Demand Intelligence/.test(document.querySelector(".hud-flyout")?.innerText ?? ""),
  );
  assert.match(demand, /Historical-demand forecast/);
  assert.match(demand, /SYNTHETIC DEMO DATA/);
  assert.match(demand, /insufficient evidence/);
  await page.evaluate(() => {
    const section = [...document.querySelectorAll(".hud-flyout section")].find(
      (node) => node.querySelector("h2")?.textContent === "Demand Intelligence",
    );
    [...(section?.querySelectorAll("tbody tr") ?? [])]
      .find((row) => row.innerText.startsWith("Toned Milk 500ml"))
      ?.click();
  });
  await waitForText(() =>
    /Evidence: Toned Milk 500ml/.test(document.querySelector(".hud-flyout")?.innerText ?? ""),
  );
  const evidence = await panelText();
  assert.match(evidence, /Held-out error \(WAPE\)/);
  assert.match(evidence, /HIST-POS-/);
  log("demand forecast", /Method: [^\n]*/.exec(evidence)?.[0]);
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll(".hud-flyout h2")].find(
      (node) => node.textContent === "Demand Intelligence",
    );
    heading?.scrollIntoView();
  });
  await shot("08-demand-intelligence");
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll(".hud-flyout h2")].find((node) =>
      node.textContent?.startsWith("Evidence:"),
    );
    heading?.scrollIntoView();
  });
  await shot("09-demand-evidence");

  const timeline = await panelText();
  assert.match(timeline, /workflow completed/i);
  // The only expected failed request is the deliberate wrong-PIN approval (403).
  const unexpected = failures.filter(
    (row) => !(row.status === 403 && /\/api\/nammaops\/approvals\/[^/]+\/approve$/.test(row.url)),
  );
  log("failed requests", failures.length ? JSON.stringify(failures) : "none");
  // Office chat history for a seat whose gateway session is broken; outside NammaOps.
  const known = unexpected.filter(
    (row) => row.status === 500 && row.url === "/api/runtime/history",
  );
  if (known.length)
    log("known non-NammaOps failure", "chat history for an unavailable OpenClaw session");
  unexpected.splice(0, unexpected.length, ...unexpected.filter((row) => !known.includes(row)));
  const appErrors = errors.filter(
    (text) => !/favicon|WebGL|THREE\.|Failed to load resource/i.test(text),
  );
  log("browser console errors", appErrors.length ? appErrors.join(" | ") : "none");
  assert.deepEqual(unexpected, [], "unexpected failed requests");
  assert.equal(appErrors.length, 0);
  log("RESULT", "all three workflows completed through the UI");
} finally {
  await browser.close();
}
