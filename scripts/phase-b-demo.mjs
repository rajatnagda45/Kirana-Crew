#!/usr/bin/env node
/**
 * Phase B demonstration over REST: generate two specializations through the same pipeline, review
 * them, show a negative case, save one and record a permission decision. Prints blockers as they
 * are; it never fills in a proposal the model did not produce.
 *
 *   node scripts/phase-b-demo.mjs [--base http://127.0.0.1:3108] [--seat oc-planner] [--wait 900]
 *
 * The server needs AGENT_TOWN_DEVELOPER_GENERATION_SEAT set to an OpenClaw seat.
 */
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (rows, item, index, all) =>
        item.startsWith("--") ? [...rows, [item.slice(2), all[index + 1]]] : rows,
      [],
    ),
);
const base = args.base ?? "http://127.0.0.1:3108";
const seat = args.seat ?? "oc-planner";
const waitSeconds = Number(args.wait ?? 900);
const API = "/api/developer/agent-config";

const call = async (method, path, body) => {
  const response = await fetch(base + API + path, {
    method,
    headers: {
      Origin: new URL(base).origin,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const show = (title, value) => console.log(`\n== ${title}\n${JSON.stringify(value, null, 2)}`);

async function generate(description) {
  const started = await call("POST", "/generate", { description, seat_id: seat });
  if (started.status !== 202) {
    show(`generate refused (HTTP ${started.status})`, started.body);
    return null;
  }
  const id = started.body.generation.generation_id;
  console.log(`\n${id}: generating (waiting up to ${waitSeconds}s)`);
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const { body } = await call("GET", `/generations/${id}`);
    if (body?.generation?.status !== "generating") return body.generation;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  console.log(`${id}: still generating after ${waitSeconds}s. Not verified.`);
  return null;
}

function summarize(title, generation) {
  if (!generation) return;
  if (generation.status !== "proposed") return show(`${title}: ${generation.status}`, generation);
  const { proposal } = generation;
  show(
    `${title}: capabilities`,
    proposal.capabilities.map(({ id, status, detail }) => ({ id, status, detail })),
  );
  show(
    `${title}: permissions`,
    proposal.permission_recommendations.map(({ id, classification, risk, reason }) => ({
      id,
      classification,
      risk,
      reason,
    })),
  );
  show(`${title}: validation`, proposal.validation);
  console.log(`\n${title}: instructions\n${proposal.config.instructions}`);
}

const inventory = await generate(
  "Create an Inventory Analyst agent responsible for investigating stock discrepancies, analyzing inventory movements, identifying unusual patterns and preparing evidence-based reports. It must not modify inventory records or submit stock adjustments.",
);
summarize("Inventory Analyst", inventory);
const research = await generate(
  "Create a Research Analyst agent that researches a topic, collects evidence from the available research tools, compares findings and produces a structured report. It must never claim that an unavailable tool was executed.",
);
summarize("Research Analyst", research);

// Negative case: an unregistered capability and an unsupported permission are blocked, not invented.
const negative = {
  name: "Stock Fixer",
  specialization: "Inventory correction",
  instructions: "Correct stock levels directly.",
  responsibilities: ["Correct stock"],
  allowed_actions: ["Write stock adjustments"],
  forbidden_actions: [],
  capabilities: ["write_inventory_ledger"],
  permissions: ["erp-admin"],
  runtime: { provider: "openclaw", seat_id: seat },
};
show("negative case: validate", (await call("POST", "/validate", { config: negative })).body);
show(
  "negative case: save",
  (await call("POST", "/save", { confirm: true, config: negative })).body,
);

if (inventory?.status === "proposed") {
  const saved = await call("POST", "/save", {
    confirm: true,
    config: inventory.proposal.config,
    generation_id: inventory.generation_id,
  });
  show(`save Inventory Analyst (HTTP ${saved.status})`, saved.body);
  const spec = saved.body?.specialization;
  const readOnly = spec?.config.permissions.find((id) =>
    inventory.proposal.permission_recommendations.some(
      (row) => row.id === id && row.scope?.dataAccess === "read_only",
    ),
  );
  if (readOnly) {
    const decided = await call("POST", `/${spec.id}/permissions/${readOnly}`, {
      decision: "approved",
      reason: "Read-only evidence access; writes stay forbidden.",
    });
    show(`approve ${readOnly} (HTTP ${decided.status})`, decided.body);
  }
}
