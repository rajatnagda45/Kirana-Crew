#!/usr/bin/env node
/**
 * LIVE ERPNext check (read-only). Runs the real NammaOps workflows and the voice router over the
 * live binding: specialists -> Phase C governance gateway -> adapter -> pinned hvgerp-mcp 3.7.0 ->
 * the ERPNext Cloud site. In-memory database and stub seats (no app, no OpenClaw, no Gemini).
 * Nothing is written to ERPNext: the live binding offers no write capability.
 *
 *   node --env-file=.env.local scripts/check-nammaops-live.mjs [YYYY-MM-DD as "today"]
 */
import { TaskDatabase } from "../lib/server/task-db.mjs";
import { AgentProfiles } from "../lib/server/agent-profiles.mjs";
import { AgentTasks } from "../lib/server/agent-tasks.mjs";
import { Specializations } from "../lib/server/developer-config.mjs";
import { McpServers } from "../lib/server/mcp-servers.mjs";
import {
  CapabilityRegistry,
  Governance,
  ToolGateway,
  WORKFLOW_PRINCIPALS,
} from "../lib/server/mcp-governance.mjs";
import { createNammaOps } from "../lib/server/nammaops/index.mjs";
import { loadBinding } from "../lib/server/nammaops/erp-binding.mjs";
import { loadWorkforce } from "../lib/server/nammaops/workforce.mjs";

const TODAY = process.argv[2] ?? "2026-11-01";
const env = process.env;
const binding = loadBinding("config/nammaops/binding.hvgerp.json");
const db = new TaskDatabase(":memory:");
const servers = new McpServers(db, {
  env,
  policy: { stdio: [binding.server.connection], http: [], cwd: process.cwd() },
});
const owner = {
  gatewayId: "gw",
  gateway: { provider: "openclaw", status: "connected" },
  db,
  resolve: (seatId) => ({
    seat: { seatId, binding: { revision: 1 } },
    agentId: "backend",
    sessionKey: `agent:backend:${seatId}`,
  }),
  submit: () => {},
};
const runtime = {
  db,
  gateway: owner.gateway,
  seatOwner: () => owner,
  taskOwner: () => owner,
  estop: { status: () => ({ engaged: false }) },
  rosterSeats: () =>
    ["s1", "s2", "s3", "s4", "s5"].map((seatId) => ({
      seatId,
      assigned: true,
      binding: { available: true },
    })),
};
runtime.profiles = new AgentProfiles(runtime);
runtime.agentTasks = new AgentTasks(runtime, { profiles: runtime.profiles });
runtime.specializations = new Specializations(runtime, { profiles: runtime.profiles });
runtime.mcpServers = servers;
runtime.capabilities = new CapabilityRegistry(db, servers);
runtime.governance = new Governance(db, runtime.capabilities, {
  identity: (agentId) => {
    if (WORKFLOW_PRINCIPALS.has(agentId)) return { agentId, specializationId: null };
    const profile = runtime.profiles.get(agentId);
    return profile ? { agentId, specializationId: profile.specialization_id ?? null } : null;
  },
});
runtime.mcpGateway = new ToolGateway({
  db,
  servers,
  registry: runtime.capabilities,
  governance: runtime.governance,
});
runtime.nammaops = createNammaOps(
  runtime,
  { NAMMAOPS_OWNER_PIN: "0000", NAMMAOPS_REASONING: "off" },
  {
    binding,
    workforce: loadWorkforce(),
    today: () => TODAY,
  },
);

const t0 = Date.now();
const lines = [];
const say = (text) => lines.push(text);
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const timed = async (label, work) => {
  const started = Date.now();
  const value = await work();
  say(`      (${label}: ${Date.now() - started} ms)`);
  return value;
};

try {
  const setup = await timed("setup + discovery", () => runtime.nammaops.setup({}));
  check("setup has no blockers", setup.blockers.length === 0, JSON.stringify(setup.blockers));
  check("write capabilities disabled, not granted", setup.disabled.length === 4);
  const granted = runtime.governance
    .grants()
    .map((row) => row.capability_id)
    .join(" ");
  check(
    "no purchase-order create/submit capability granted",
    !/create_purchase_order|submit_purchase_order/.test(granted),
  );
  check(
    "discovered tools are the adapter's read tools",
    setup.discovery.added.length >= 16,
    `added=${setup.discovery.added.length}`,
  );

  const ask = (intent) => runtime.nammaops.workflows.start({ intent }).done;
  const stock = await timed("stock_check", () =>
    ask({ action: "stock_check", products: ["milk", "rice"] }),
  );
  check("stock_check completed", stock.status === "completed", stock.error ?? "");
  say(
    "      " +
      stock.result.rows
        .map((r) => `${r.item_name}: ${r.available}/${r.reorder_level} ${r.status}`)
        .join(" | "),
  );

  const report = await timed("daily_report 2026-10-31", () =>
    ask({ action: "daily_report", date: "2026-10-31" }),
  );
  check(
    "daily_report completed with verified profit",
    report.status === "completed" && report.result.profit.status === "verified",
    report.error ?? "",
  );
  check(
    "sales total matches ERPNext (15745, 6 invoices)",
    report.result.total_sales === 15745 && report.result.transaction_count === 6,
    `${report.result.total_sales}/${report.result.transaction_count}`,
  );
  check(
    "net profit from posted P&L (2614)",
    report.result.profit.net_profit === 2614,
    String(report.result.profit.net_profit),
  );
  say(
    "      top: " +
      report.result.top_products
        .slice(0, 3)
        .map((p) => `${p.item_name} ${p.qty}`)
        .join(", "),
  );

  // A day with nothing posted at all (tomorrow) must not produce a profit figure.
  const empty = await ask({
    action: "daily_report",
    date: new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
  });
  check(
    "a day with no postings gives unverified profit, not an invented number",
    empty.result?.profit?.status === "unverified",
    empty.status,
  );
  // Today carries a non-trading stock adjustment: posted, so verified, but it must be flagged.
  const adjusted = await ask({ action: "daily_report", date: TODAY });
  if (adjusted.result?.profit?.status === "verified" && adjusted.result.total_sales === 0)
    check(
      "non-trading postings are flagged, not presented as trading profit",
      adjusted.result.warnings.some((text) => /non-trading postings/.test(text)),
      adjusted.result.warnings[0] ?? "no warning",
    );

  const compare = await timed("supplier_comparison", () =>
    ask({ action: "supplier_comparison", products: ["sugar"] }),
  );
  check(
    "supplier_comparison completed from quotation documents",
    compare.status === "completed",
    compare.error ?? "",
  );
  say(
    "      " +
      (compare.result?.items ?? [])
        .map(
          (i) =>
            `${i.item_name}: ${i.choice ? `${i.choice.supplier} @ ${i.choice.rate}` : i.blocker}; considered ${i.considered.length}; missing ${[...new Set(i.considered.flatMap((c) => c.missing))].join("/")}`,
        )
        .join(" | "),
  );

  const unknown = await ask({ action: "stock_check", products: ["paneer tikka"] });
  check("unknown product asks for clarification", unknown.status === "needs_clarification");

  const forecast = await timed("demand_forecast (90 days)", () =>
    ask({ action: "demand_forecast", products: [] }),
  );
  check(
    "demand_forecast completed",
    ["completed", "partial"].includes(forecast.status),
    forecast.error ?? "",
  );
  if (forecast.result) {
    const ok = forecast.result.items.filter((i) => i.status === "ok");
    check(
      "forecast has items with evidence",
      ok.length > 20,
      `${ok.length} forecast, ${forecast.result.items.length - ok.length} insufficient`,
    );
    const dal = forecast.result.items.find((i) => i.item_code === "NK-DAL-1KG");
    // The Cloud seed skipped toor dal sales for six days without zeroing its stock, so the ledger
    // proves no stockout and the engine must not invent one. Reported, not asserted.
    say(
      `      toor dal: ${dal?.history?.censored_stockout_days?.length ?? "?"} ledger-proven stockout day(s), ${dal?.history?.observed_days} observed day(s)`,
    );
    const millet = forecast.result.items.find((i) => i.item_code === "NK-NEW-MILLET");
    say(`      millet: ${millet?.status}, ${millet?.history?.observed_days} observed day(s)`);
    check(
      "a product with under 14 days of sales is not forecast",
      millet?.status === "insufficient_evidence",
      millet?.status,
    );
    say(
      "      " +
        ok
          .slice(0, 3)
          .map((i) => `${i.item_name} next7=${i.forecast.next_7_days}`)
          .join(" | "),
    );
  }

  const reorder = await ask({ action: "prepare_reorder" });
  check(
    "prepare_reorder creates no draft or approval on live data",
    ["completed", "blocked"].includes(reorder.status) &&
      runtime.nammaops.approvals.list().length === 0,
    `${reorder.status}: ${reorder.summary ?? reorder.error}`,
  );

  const alice = { id: "voice_live", name: "Alice" };
  const voice = (args, actionId) => runtime.nammaops.voice.query({ call: alice, actionId, args });
  const v1 = await timed("voice check_stock", () =>
    voice({ intent: "check_stock", products: ["milk"] }, "a1"),
  );
  check(
    "voice contract: source erpnext_live",
    v1.source === "erpnext_live" && v1.status === "completed",
    `${v1.status}/${v1.source}`,
  );
  check(
    "voice limitations state the live data label",
    v1.limitations.some((t) => /Live ERPNext Cloud/.test(t)),
  );
  check(
    "voice evidence lists specialist invocations",
    v1.evidence.some((e) => e.department === "inventory" && e.invocation_ids.length > 0),
  );
  say("      facts: " + v1.facts.join(" ; "));
  const v2 = await voice({ intent: "sales_summary", day: "2026-10-31" }, "a2");
  say("      facts: " + v2.facts.join(" ; "));
  check(
    "voice sales answer matches ERPNext",
    /15745 from 6 submitted transactions/.test(v2.facts[0] ?? ""),
    v2.facts[0],
  );
  const v3 = await voice({ intent: "business_profit", day: "2026-10-31" }, "a3");
  check(
    "voice profit from posted P&L",
    /Net profit on 2026-10-31: 2614/.test(v3.facts[0] ?? ""),
    v3.facts[0],
  );
  const v4 = await voice({ intent: "prepare_purchase_order" }, "a4");
  check(
    "voice purchase order: no draft, no approval, honest reason",
    v4.approval_required === false &&
      v4.approvals.length === 0 &&
      /No draft purchase order|unavailable|blocked/i.test(
        `${v4.status} ${v4.facts.join(" ")} ${v4.limitations.join(" ")}`,
      ),
    `${v4.status}: ${v4.facts[0] ?? ""} | ${v4.limitations.slice(-1)[0]}`,
  );

  const invocations = runtime.mcpGateway.invocations();
  // The only expected failure is the P&L for a day with no postings, which must not be invented.
  const bad = invocations.filter(
    (row) => row.status !== "completed" && !/get_profit_and_loss$/.test(row.capability_id),
  );
  check(
    `all ${invocations.length} governed invocations completed (bar the empty-day P&L)`,
    bad.length === 0,
    bad
      .slice(0, 2)
      .map((row) => `${row.capability_id}:${row.status}`)
      .join(","),
  );
  check(
    "every invocation was a READ",
    invocations.every((row) => row.risk === undefined || row.risk === "READ"),
  );
} catch (error) {
  failures += 1;
  say(`FAIL  unexpected error: ${String(error.message).slice(0, 300)}`);
} finally {
  console.log(lines.join("\n"));
  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}  (${Math.round((Date.now() - t0) / 1000)} s)`,
  );
  await servers.close();
  db.close();
  process.exit(failures ? 1 : 0);
}
