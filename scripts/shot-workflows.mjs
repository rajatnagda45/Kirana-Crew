#!/usr/bin/env node
/**
 * Drives the real /app/workflows page in Chrome against the running app and saves screenshots plus
 * a verification record. The app talks to the live, read-only ERPNext binding, so every run here is
 * a real run (it adds records to the run history like any other use).
 *
 *   node scripts/shot-workflows.mjs [--url http://localhost:3000] [--out artifacts/workflows-ui]
 *
 * It checks: an existing report opens as a readable report, runs reach their final status, polling
 * stops when nothing is running (counted from network requests), a clarification can be answered,
 * copy / CSV / print work, and the page fits a phone screen. Exits non-zero if any check fails.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { browserCheckOptions } from "./browser-check-options.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const origin = flag("--url", process.env.OFFICE_CHECK_URL ?? "http://localhost:3000");
const out = flag("--out", "artifacts/workflows-ui");
mkdirSync(out, { recursive: true });
const downloads = mkdtempSync(join(tmpdir(), "wf-shots-"));

const chrome = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => p && existsSync(p));

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 160)})` : ""}`,
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 20000, what = "condition") => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
};

// The dev server restarts when server files change; wait until it answers before starting.
for (let i = 0; i < 60; i += 1) {
  const up = await fetch(`${origin}/api/runtime/nammaops/workflows`).then(
    (r) => r.ok,
    () => false,
  );
  if (up) break;
  await sleep(2000);
}

const browser = await puppeteer.launch({
  ...browserCheckOptions(),
  ...(chrome ? { executablePath: chrome } : {}),
});
const errors = [];
const requests = [];
let page;
try {
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(origin, [
    "clipboard-read",
    "clipboard-write",
    "clipboard-sanitized-write",
  ]);
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("request", (r) => requests.push({ t: Date.now(), method: r.method(), url: r.url() }));
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
    eventsEnabled: true,
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );

  const shot = (name, fullPage = false) =>
    page.screenshot({ path: join(out, `${name}.png`), fullPage });

  // In-page helpers.
  const clickIn = (rootSelector, text) =>
    page.evaluate(
      (rootSelector, text) => {
        const root = document.querySelector(rootSelector);
        const button = [...(root?.querySelectorAll("button") ?? [])].find((b) =>
          b.textContent.trim().includes(text),
        );
        if (!button) return false;
        button.click();
        return true;
      },
      rootSelector,
      text,
    );
  const rowIds = () =>
    page.$$eval("li[data-run-id]", (rows) => rows.map((r) => r.getAttribute("data-run-id")));
  const status = (id) =>
    page
      .$eval(`li[data-run-id="${id}"]`, (r) => r.getAttribute("data-run-status"))
      .catch(() => null);
  /** Sets an input the way React expects (native setter + input event). Typing into a date field is locale-dependent. */
  const setValue = (selector, value) =>
    page.$eval(
      selector,
      (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      value,
    );

  /** Presses a card's run button, returns the new run's id once it appears, then waits for it to settle. */
  async function runCard(action, { fill } = {}) {
    const before = new Set(await rowIds());
    if (fill) await fill();
    check(
      `${action}: run button is present`,
      await clickIn(`form[aria-labelledby="wf-${action}-title"]`, "Run"),
    );
    const id = await wait(
      async () => (await rowIds()).find((r) => !before.has(r)),
      15000,
      `${action} to appear in the history`,
    );
    return id;
  }
  const settle = (id, ms = 120000) =>
    wait(
      async () => {
        const s = await status(id);
        return s && s !== "running" ? s : null;
      },
      ms,
      `run ${id} to finish`,
    );

  // ── 1. Open the page and an existing report ──────────────────────────────
  await page.goto(`${origin}/app/workflows`, { waitUntil: "networkidle2", timeout: 60000 });
  const hasTitle = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("h1")].some((h) => h.textContent === "Workflows"),
    );
  await wait(hasTitle, 30000, "the Workflows heading");
  check("page title is Workflows", await hasTitle());
  await wait(async () => (await rowIds()).length > 0, 20000, "run history");
  await shot("01-page-top");

  const existing = await page.$$eval("li[data-run-id]", (rows) =>
    rows.map((r) => ({
      id: r.getAttribute("data-run-id"),
      status: r.getAttribute("data-run-status"),
      name: r.querySelector("h3")?.textContent,
    })),
  );
  const oldStock = existing.find((r) => r.name === "Stock Check" && r.status === "completed");
  if (oldStock) {
    await clickIn(`li[data-run-id="${oldStock.id}"]`, "View report");
    await page.waitForSelector(`li[data-run-id="${oldStock.id}"] article`, { timeout: 20000 });
    const text = await page.$eval(`li[data-run-id="${oldStock.id}"]`, (r) => r.textContent);
    check(
      "an earlier Stock Check opens as a readable report",
      /Key figures|Products running low|No product is at or below/.test(text) &&
        !/"kind"/.test(text),
    );
    check(
      "the history row shows start, finish and duration",
      /Started .*Finished .*Took /.test(text),
      text.slice(0, 160),
    );
    await page.$eval(`li[data-run-id="${oldStock.id}"]`, (r) => r.scrollIntoView());
    await shot("02-existing-stock-check-report");
    await clickIn(`li[data-run-id="${oldStock.id}"]`, "Hide report");
  } else check("an earlier completed Stock Check exists", false, "none in the history");

  // Cards that depend on an ERP connection must match what the binding says right now.
  const binding = await page.evaluate(() =>
    fetch("/api/runtime/nammaops/binding")
      .then((r) => r.json())
      .then((j) => j.binding),
  );
  for (const [action, capability] of [
    ["payments_summary", "erp.payments.summary"],
    ["gst_summary", "erp.gst.summary"],
    ["purchase_order_lookup", "erp.po.get"],
  ]) {
    const available =
      binding.find((b) => b.business_capability === capability)?.availability === "available";
    const card = await page.$eval(`form[aria-labelledby="wf-${action}-title"]`, (f) => ({
      text: f.textContent ?? "",
      hasRun: [...f.querySelectorAll("button")].some((b) => /^Run /.test(b.textContent.trim())),
    }));
    check(
      `${action}: card matches the live ERP connection (${available ? "available" : "not set up"})`,
      available
        ? card.hasRun && !/Not available yet/.test(card.text)
        : !card.hasRun && /Not available yet/.test(card.text),
      `${capability}: ${available ? "available" : "unavailable"}`,
    );
  }
  await page.$eval('form[aria-labelledby="wf-payments_summary-title"]', (f) =>
    f.scrollIntoView({ block: "center" }),
  );
  await shot("15-cards-needing-erp-setup");

  // ── 2. Run the five required workflows ───────────────────────────────────
  const runs = {};

  const stockId = await runCard("stock_check");
  check(
    "a new run shows as running in the history",
    ["running", "completed", "partial"].includes(await status(stockId)),
  );
  await shot("03-stock-check-running");
  runs.stock_check = await settle(stockId);
  await wait(
    async () => page.$(`li[data-run-id="${stockId}"] article`),
    20000,
    "the stock report to open",
  );
  check(
    "Stock Check finished and its report opened by itself",
    ["completed", "partial"].includes(runs.stock_check),
    runs.stock_check,
  );
  await page.$eval(`li[data-run-id="${stockId}"]`, (r) => r.scrollIntoView());
  await shot("04-stock-check-report");

  // Copy summary / full report from this report.
  const clipRead = () => page.evaluate(() => navigator.clipboard.readText());
  await clickIn(`li[data-run-id="${stockId}"]`, "Copy summary");
  const copied = await wait(clipRead, 5000, "clipboard");
  // Compare with the summary the server saved, not with anything read off the page.
  const savedSummary = await page.evaluate(
    (id) =>
      fetch(`/api/runtime/nammaops/workflows/${id}`)
        .then((r) => r.json())
        .then((j) => j.workflow.summary),
    stockId,
  );
  check(
    "Copy summary puts the title and the server's saved summary on the clipboard",
    /^Stock Check/.test(copied) && !!savedSummary && copied.includes(savedSummary),
    copied.slice(0, 120),
  );
  await clickIn(`li[data-run-id="${stockId}"]`, "Copy full report");
  const full = await wait(clipRead, 5000, "clipboard");
  check(
    "Copy full report includes key figures and every table",
    /Key figures:/.test(full) &&
      /Products running low|No product is at or below/.test(full) &&
      !/[{}]/.test(full),
    full.length + " chars",
  );

  // CSV.
  if (await clickIn(`li[data-run-id="${stockId}"]`, "Download CSV")) {
    const file = await wait(
      async () => readdirSync(downloads).find((f) => f.endsWith(".csv")),
      10000,
      "CSV download",
    );
    const bytes = readFileSync(join(downloads, file));
    check(
      "CSV downloads with a UTF-8 BOM and a header row",
      bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf &&
        /Product,/.test(bytes.toString("utf8")),
      file,
    );
  } else check("CSV button is offered for a report with a table", false);

  // Print: the print page is a self-contained HTML document written into a hidden iframe.
  await page.evaluate(() => {
    window.__printed = null;
    const original = document.body.appendChild.bind(document.body);
    document.body.appendChild = (node) => {
      if (node?.tagName === "IFRAME") window.__printed = node.srcdoc;
      return original(node);
    };
  });
  await clickIn(`li[data-run-id="${stockId}"]`, "Print");
  const html = await wait(() => page.evaluate(() => window.__printed), 10000, "print document");
  check(
    "Print builds a clean light page with title, summary and figures",
    /<h1>Stock Check/.test(html) && !/var\(--/.test(html) && !/<script/i.test(html),
    `${html.length} chars`,
  );
  const printPage = await browser.newPage();
  await printPage.setContent(html, { waitUntil: "load" });
  await printPage.emulateMediaType("print");
  await printPage.pdf({
    path: join(out, "05-stock-check-print.pdf"),
    format: "A4",
    printBackground: true,
  });
  await printPage.setViewport({ width: 900, height: 1200 });
  await printPage.screenshot({ path: join(out, "05-stock-check-print.png"), fullPage: true });
  await printPage.close();

  // Daily Report: a day with posted accounting (profit verified), and today (profit unavailable).
  const dayId = await runCard("daily_report", {
    fill: () => setValue("#wf-daily_report-date", "2026-10-31"),
  });
  runs.daily_verified = await settle(dayId);
  await wait(async () => page.$(`li[data-run-id="${dayId}"] article`), 20000, "daily report");
  const dayText = await page.$eval(`li[data-run-id="${dayId}"]`, (r) => r.textContent);
  check(
    "Daily Report for a day with sales shows recorded sales and transactions",
    /Total recorded sales/.test(dayText) && /Transactions/.test(dayText),
    runs.daily_verified,
  );
  await page.$eval(`li[data-run-id="${dayId}"]`, (r) => r.scrollIntoView());
  await shot("06-daily-report-completed");
  check(
    "it states the profit source or says it is unavailable, never a bare number",
    /Profit or loss/.test(dayText) &&
      /From posted accounting entries|Not available|Not requested/.test(dayText),
  );

  const todayId = await runCard("daily_report");
  runs.daily_today = await settle(todayId);
  await wait(
    async () => page.$(`li[data-run-id="${todayId}"] article`),
    20000,
    "today's daily report",
  );
  await page.$eval(`li[data-run-id="${todayId}"]`, (r) => r.scrollIntoView());
  await shot("07-daily-report-today");

  const forecastId = await runCard("demand_forecast");
  runs.demand_forecast = await settle(forecastId, 180000);
  await wait(
    async () => page.$(`li[data-run-id="${forecastId}"] article`),
    30000,
    "forecast report",
  );
  const forecastText = await page.$eval(`li[data-run-id="${forecastId}"]`, (r) => r.textContent);
  check(
    "Demand Forecast shows next 7 / 30 days and says what it is based on",
    /Next 7 days/.test(forecastText) &&
      /Next 30 days/.test(forecastText) &&
      /not a market prediction/.test(forecastText),
    runs.demand_forecast,
  );
  await page.$eval(`li[data-run-id="${forecastId}"]`, (r) => r.scrollIntoView());
  await shot("08-demand-forecast");

  const healthId = await runCard("store_health_report");
  runs.store_health = await settle(healthId);
  await wait(
    async () => page.$(`li[data-run-id="${healthId}"] article`),
    20000,
    "store health report",
  );
  const healthText = await page.$eval(`li[data-run-id="${healthId}"]`, (r) => r.textContent);
  check(
    "Store Health lists problems and any area it could not check",
    /biggest problems|problem/i.test(healthText) &&
      (/was not checked/.test(healthText) || runs.store_health === "completed"),
    runs.store_health,
  );
  check(
    "Store Health never claims 'no problems' while an area is unchecked",
    !(
      /No problems were found in the areas checked/.test(healthText) &&
      /was not checked/.test(healthText)
    ),
  );
  await page.$eval(`li[data-run-id="${healthId}"]`, (r) => r.scrollIntoView());
  await shot("09-store-health");

  // Supplier Comparison: empty input is stopped before anything is sent; then the page's own example.
  const sentBefore = requests.filter(
    (r) => r.method === "POST" && /nammaops\/workflows$/.test(r.url),
  ).length;
  await clickIn('form[aria-labelledby="wf-supplier_comparison-title"]', "Run");
  await wait(
    async () => page.$('form[aria-labelledby="wf-supplier_comparison-title"] [role="alert"]'),
    5000,
    "inline error",
  );
  check(
    "Supplier Comparison with no products is stopped with a clear message",
    requests.filter((r) => r.method === "POST" && /nammaops\/workflows$/.test(r.url)).length ===
      sentBefore,
  );
  await page.$eval('form[aria-labelledby="wf-supplier_comparison-title"]', (f) =>
    f.scrollIntoView(),
  );
  await shot("10-supplier-comparison-needs-input");
  const supplierId = await runCard("supplier_comparison", {
    fill: () => setValue("#wf-supplier_comparison-products", "Atta, Rice, Sugar"),
  });
  runs.supplier_comparison = await settle(supplierId);
  await wait(
    async () => page.$(`li[data-run-id="${supplierId}"] article`),
    20000,
    "supplier comparison report",
  );
  await page.$eval(`li[data-run-id="${supplierId}"]`, (r) => r.scrollIntoView());
  await shot("11-supplier-comparison-result");

  // A product the store does not sell makes the server ask a question; answer it on the page.
  const unknownId = await runCard("supplier_comparison", {
    fill: () => setValue("#wf-supplier_comparison-products", "Zzyzx tea"),
  });
  runs.supplier_unknown = await settle(unknownId);
  await wait(
    async () => page.$(`li[data-run-id="${unknownId}"] article`),
    20000,
    "unknown-product report",
  );
  check(
    "an unknown product makes the run ask a question",
    runs.supplier_unknown === "needs_clarification",
    runs.supplier_unknown,
  );
  let clarifiedId = null;
  if (runs.supplier_unknown === "needs_clarification") {
    const panel = `li[data-run-id="${unknownId}"] section[aria-label="Answer to continue"]`;
    await wait(async () => page.$(panel), 10000, "clarification panel");
    await page.$eval(panel, (p) => p.scrollIntoView({ block: "center" }));
    await shot("12-clarification-question");
    const questionText = await page.$eval(panel, (p) => p.textContent);
    check(
      "the clarification question and its missing information are shown",
      /more information is needed/i.test(questionText),
      questionText.slice(0, 120),
    );
    const before = new Set(await rowIds());
    const choice = await page.evaluate((panel) => {
      const options = [...document.querySelectorAll(`${panel} [role="group"] button`)];
      if (options.length) {
        options[0].click();
        return options[0].textContent.trim();
      }
      return null;
    }, panel);
    if (!choice) await setValue(`${panel} input[type="text"]`, "Rice");
    await clickIn(panel, "Run again with this answer");
    clarifiedId = await wait(
      async () => (await rowIds()).find((r) => !before.has(r)),
      15000,
      "the answered run",
    );
    check("answering the question starts a new linked run", !!clarifiedId, choice ?? "typed Rice");
    runs.clarified = await settle(clarifiedId);
    await wait(
      async () => page.$(`li[data-run-id="${clarifiedId}"] article`),
      20000,
      "answered report",
    );
    check(
      "the answered run finishes with a report",
      ["completed", "partial"].includes(runs.clarified),
      runs.clarified,
    );
    check(
      "the old run is marked as answered",
      /Answered\./.test(await page.$eval(`li[data-run-id="${unknownId}"]`, (r) => r.textContent)),
    );
    await page.$eval(`li[data-run-id="${clarifiedId}"]`, (r) => r.scrollIntoView());
    await shot("13-clarification-answered");
  }
  check(
    "Supplier Comparison for real products completed",
    ["completed", "partial"].includes(runs.supplier_comparison),
    runs.supplier_comparison,
  );

  // ── 3. Polling stops once nothing is running ─────────────────────────────
  const anyRunning = await page.$$eval(
    "li[data-run-status]",
    (rows) => rows.filter((r) => r.getAttribute("data-run-status") === "running").length,
  );
  check("no run is left running", anyRunning === 0, `${anyRunning} running`);
  await sleep(1500);
  const quietFrom = Date.now();
  await sleep(14000);
  const during = requests.filter(
    (r) => r.t >= quietFrom && /nammaops\/workflows(\/|$)/.test(r.url) && r.method === "GET",
  ).length;
  check(
    "the page stops polling the run list when nothing is running (14 s quiet window)",
    during === 0,
    `${during} requests`,
  );

  // ── 4. A phone-sized screen ──────────────────────────────────────────────
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  // (the page keeps an event connection open, so "network idle" is not a reliable signal here)
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(hasTitle, 30000, "the Workflows heading on mobile");
  await wait(async () => (await rowIds()).length > 0, 20000, "history on mobile");
  const firstId = (await rowIds())[0];
  await clickIn(`li[data-run-id="${firstId}"]`, "View");
  await wait(async () => page.$(`li[data-run-id="${firstId}"] article`), 20000, "mobile report");
  await page.$eval(`li[data-run-id="${firstId}"]`, (r) => r.scrollIntoView());
  const overflow = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll("div")].find(
      (d) =>
        getComputedStyle(d).overflowY === "auto" &&
        d.scrollHeight > d.clientHeight &&
        d.querySelector("h1"),
    );
    return scroller
      ? { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth }
      : null;
  });
  check(
    "on a phone screen the page does not scroll sideways",
    !overflow || overflow.scrollWidth <= overflow.clientWidth + 1,
    JSON.stringify(overflow),
  );
  await shot("14-mobile-report");

  // ── 5. Only the console errors that matter ───────────────────────────────
  const relevant = errors.filter(
    (e) =>
      !/favicon|Failed to load resource.*(404|401)|Download the React DevTools|hydrat/i.test(e),
  );
  check(
    "no unexpected console or page errors",
    relevant.length === 0,
    relevant.slice(0, 3).join(" | "),
  );
  writeFileSync(
    join(out, "verification.json"),
    JSON.stringify(
      { origin, at: new Date().toISOString(), runs, checks, errors: relevant },
      null,
      2,
    ),
  );
} catch (error) {
  check("script completed", false, error instanceof Error ? error.message : String(error));
  if (page)
    await page.screenshot({ path: join(out, "99-failure.png"), fullPage: true }).catch(() => {});
  writeFileSync(
    join(out, "verification.json"),
    JSON.stringify({ origin, at: new Date().toISOString(), checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(
  `\n${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${checks.length} checks). Screenshots in ${out}`,
);
process.exit(failed.length ? 1 : 0);
