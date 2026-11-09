import { NAMMAOPS_EXAMPLES as EX } from "./openapi-examples.mjs";
import { DASHBOARDS } from "./dashboards.mjs";
import { V2_INTENTS } from "./workflows-v2.mjs";

const DASHBOARD_NAMES = [...DASHBOARDS];

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({
  content: { "application/json": { schema, ...(example === undefined ? {} : { example }) } },
});
const error = (description, example) => ({ description, ...json(ref("Error"), example) });
const id = { type: "string", pattern: "^[A-Za-z0-9_.-]{1,128}$" };
const text = { type: "string" };
const strings = { type: "array", items: text };

/** Shared request rules, applied by the runtime handler before NammaOps sees a request. */
const COMMON_ERRORS = {
  403: error(
    "Request refused: cross-origin, a write without a same-origin Origin header, or a non-loopback caller.",
    EX.errors["e-origin"],
  ),
  503: error("NammaOps is not configured on this server.", { error: "NammaOps is not available." }),
};

/**
 * OpenAPI 3.1 description of the NammaOps REST API exactly as implemented in
 * `lib/server/nammaops/api.mjs`. Every route is also served under `/api/runtime/nammaops/...`.
 * Examples are real fixture responses (see openapi-examples.mjs).
 */
export const NAMMAOPS_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "NammaOps REST API",
    version: "1.0.0",
    description:
      "Kirana-store workforce API on the Agent Town server. Loopback only. Writes (POST) need a same-origin `Origin` header. " +
      "Every route is also available under `/api/runtime/nammaops/...`. Data source is the ERPNext-shaped TEST FIXTURE unless " +
      "`GET /binding` and `GET /dashboard` report otherwise. Owner approval additionally needs the owner PIN.",
  },
  servers: [{ url: "http://127.0.0.1:3108", description: "Local Agent Town (port from PORT)" }],
  paths: {
    "/api/nammaops/setup": {
      post: {
        summary: "Configure the five-agent workforce (idempotent)",
        description:
          "Registers the ERP MCP server from the binding file, runs discovery, reviews bound tools, saves the five " +
          "specializations, binds agents to free OpenClaw seats and grants each agent its business capabilities. " +
          "Re-running reuses what exists. Persists `nammaops.workforce/current`.",
        requestBody: {
          required: false,
          ...json(
            {
              type: "object",
              properties: {
                seats: {
                  type: "object",
                  description: "Optional role → seat_id overrides for agents not yet created.",
                  additionalProperties: id,
                },
              },
              additionalProperties: false,
            },
            {},
          ),
        },
        responses: {
          200: {
            description: "Setup report; check `blockers`.",
            ...json(
              {
                type: "object",
                required: ["setup"],
                properties: { setup: ref("SetupReport") },
              },
              EX.setup,
            ),
          },
          400: error("Invalid JSON body.", EX.errors["e-json"]),
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/workforce": {
      get: {
        summary: "Current workforce (null before setup)",
        responses: {
          200: {
            description: "Workforce record.",
            ...json(
              {
                type: "object",
                required: ["workforce"],
                properties: { workforce: { oneOf: [ref("Workforce"), { type: "null" }] } },
              },
              EX.workforce,
            ),
          },
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/binding": {
      get: {
        summary: "Business capability → MCP tool binding status",
        responses: {
          200: {
            description: "One entry per business capability.",
            ...json(
              {
                type: "object",
                required: ["binding"],
                properties: { binding: { type: "array", items: ref("BindingEntry") } },
              },
              EX.binding,
            ),
          },
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/dashboard": {
      get: {
        summary: "Latest result of each workflow kind, open approvals and data source",
        responses: {
          200: {
            description: "Dashboard.",
            ...json(ref("Dashboard"), EX.dashboard),
          },
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/dashboards": {
      get: {
        summary: "Names of the ERPNext-style management dashboards",
        responses: {
          200: {
            description: "Dashboard names.",
            ...json(
              {
                type: "object",
                required: ["dashboards"],
                properties: { dashboards: { type: "array", items: { enum: DASHBOARD_NAMES } } },
              },
              { dashboards: DASHBOARD_NAMES },
            ),
          },
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/dashboards/{name}": {
      get: {
        summary: "One management dashboard (cards, charts, tables) for a date range",
        description:
          "Reads ERP data only through the governed MCP gateway as the READ-only principal " +
          "`nammaops-dashboard-reader`; every read is an audited invocation sharing `correlation_id`. " +
          "A capability that is unavailable or disabled in the binding is listed in `sections_unavailable` " +
          "instead of failing the dashboard. `verification` states whether the data is the synthetic fixture " +
          "or an unreconciled live read. Query: `from`, `to` (YYYY-MM-DD; default the 30 days ending today; " +
          "at most 366 days).",
        parameters: [
          { name: "name", in: "path", required: true, schema: { enum: DASHBOARD_NAMES } },
          {
            name: "from",
            in: "query",
            required: false,
            schema: { type: "string", format: "date" },
          },
          { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
        ],
        responses: {
          200: { description: "Dashboard.", ...json(ref("ManagementDashboard")) },
          400: error("Invalid date range or unknown query parameter.", {
            error: "from and to must be YYYY-MM-DD dates.",
          }),
          404: error("Unknown dashboard.", { error: "Unknown dashboard." }),
          409: error("The workforce is not set up yet.", {
            error: "The NammaOps workforce is not set up yet (POST /api/nammaops/setup).",
          }),
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/workflows": {
      get: {
        summary: "Recent workflows (newest first, at most 50)",
        responses: {
          200: {
            description: "Workflow summaries.",
            ...json(
              {
                type: "object",
                required: ["workflows"],
                properties: { workflows: { type: "array", items: ref("WorkflowSummary") } },
              },
              EX.workflows,
            ),
          },
          ...COMMON_ERRORS,
        },
      },
      post: {
        summary: "Start a workflow from owner text or a structured intent",
        description:
          "Runs asynchronously: the response is the persisted workflow with status `running`; poll " +
          "`GET /workflows/{id}`. Text is parsed deterministically into stock_check, prepare_reorder, " +
          "daily_report or demand_forecast. Each specialist step is a governed MCP call under that agent's identity.",
        requestBody: {
          required: true,
          ...json(
            {
              oneOf: [
                {
                  type: "object",
                  required: ["text"],
                  properties: { text: { type: "string", minLength: 1, maxLength: 500 } },
                },
                { type: "object", required: ["intent"], properties: { intent: ref("Intent") } },
              ],
            },
            { text: "Check the stock of milk." },
          ),
        },
        responses: {
          202: {
            description: "Workflow accepted and running.",
            ...json(
              {
                type: "object",
                required: ["workflow"],
                properties: { workflow: ref("Workflow") },
              },
              EX.workflowStarted,
            ),
          },
          400: error(
            "Invalid JSON, empty/oversized command, or an intent that fails validation.",
            EX.errors["e-intent"],
          ),
          409: error("Workforce not set up.", {
            error: "The NammaOps workforce is not set up yet (POST /api/nammaops/setup).",
          }),
          422: error("Unsupported operation or unrecognised request.", EX.errors["e-unsup"]),
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/workflows/{id}": {
      get: {
        summary: "One workflow with its specialist tasks and result",
        parameters: [{ name: "id", in: "path", required: true, schema: id }],
        responses: {
          200: {
            description: "Workflow view.",
            ...json(
              {
                type: "object",
                required: ["workflow"],
                properties: { workflow: ref("Workflow") },
              },
              EX.workflow,
            ),
          },
          404: error("Unknown workflow.", EX.errors["e-404"]),
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/workflows/{id}/events": {
      get: {
        summary: "Timeline and specialist tasks of one workflow",
        parameters: [{ name: "id", in: "path", required: true, schema: id }],
        responses: {
          200: {
            description: "Timeline and tasks.",
            ...json(
              {
                type: "object",
                required: ["timeline", "tasks"],
                properties: {
                  timeline: { type: "array", items: ref("TimelineEvent") },
                  tasks: { type: "array", items: ref("Task") },
                },
              },
              EX.events,
            ),
          },
          404: error("Unknown workflow.", EX.errors["e-404"]),
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/voices": {
      get: {
        summary: "Each specialist's spoken voice (Gnani Timbre) and the voices available",
        responses: {
          200: { description: "Voices by role.", ...json(ref("AgentVoices")) },
          ...COMMON_ERRORS,
        },
      },
      post: {
        summary: "Choose the spoken voice for one or more specialists",
        requestBody: {
          required: true,
          ...json(
            {
              type: "object",
              required: ["voices"],
              properties: { voices: { type: "object", additionalProperties: text } },
            },
            { voices: { inventory: "Avinash" } },
          ),
        },
        responses: {
          200: { description: "Saved voices.", ...json(ref("AgentVoices")) },
          400: error("Unknown role or voice.", { error: "Unknown voice for sales: Nobody." }),
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/voice-query": {
      post: {
        summary: "Spoken business question -> spoken answer (Gnani first, Gemini backup)",
        description:
          "multipart/form-data with `audio` (wav, mp3, ogg, flac, aac, m4a or webm, at most 5 MB) and optional " +
          "`language` (e.g. en-IN). The audio is transcribed (Gnani Prisma; Gemini only on a Gnani outage), " +
          "answered by the matching NammaOps workflow through the governed read-only ERP path, and the summary " +
          "is spoken (Gnani Timbre; Gemini only on an outage). No OpenClaw agent task is started.",
        responses: {
          200: {
            description:
              "`heard` (transcript and provider), `workflow` (or null when the request was not understood), " +
              "`answer`, and `speech` (base64 audio) or `speech_unavailable`.",
            ...json({
              type: "object",
              required: ["heard", "answer"],
              properties: {
                heard: { type: "object" },
                workflow: { type: ["object", "null"] },
                answer: text,
                speech: { type: ["object", "null"] },
                speech_unavailable: text,
              },
            }),
          },
          400: error("Missing or invalid audio.", { error: "audio file field is required." }),
          413: error("Audio too large.", { error: "Audio upload too large." }),
          415: error("Not a multipart upload, or an unsupported audio type.", {
            error: "Use multipart/form-data.",
          }),
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/access-check": {
      post: {
        summary: "Run the fixed read-only workforce access probes",
        description:
          "Hard-coded probes: one harmless permitted read per specialist and several calls that must be denied. " +
          "The request cannot choose the agent, capability or arguments. Every probe goes through governance and is audited.",
        responses: {
          200: {
            description:
              "Probe results; `passed` is true only when every probe matched its expectation.",
            ...json({
              type: "object",
              required: ["access_check"],
              properties: {
                access_check: {
                  type: "object",
                  required: ["results", "passed"],
                  properties: {
                    passed: { type: "boolean" },
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["agent", "capability", "expected", "outcome", "pass"],
                        properties: {
                          agent: text,
                          capability: text,
                          tool: { type: ["string", "null"] },
                          expected: { enum: ["allowed", "denied"] },
                          outcome: { enum: ["allowed", "denied"] },
                          pass: { type: "boolean" },
                          invocation_id: { type: ["string", "null"] },
                        },
                      },
                    },
                  },
                },
              },
            }),
          },
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/owner-pin": {
      get: {
        summary: "Where the owner approval PIN comes from (never the PIN itself)",
        responses: {
          200: {
            description:
              "PIN source: settings (owner-set, stored as a salted hash), environment, or default (1234).",
            ...json(ref("OwnerPinStatus"), {
              owner_pin: { source: "environment", updated_at: null },
            }),
          },
          ...COMMON_ERRORS,
        },
      },
      post: {
        summary: "Change the owner approval PIN (requires the current PIN)",
        requestBody: {
          required: true,
          ...json(
            {
              type: "object",
              required: ["current_pin", "new_pin"],
              properties: {
                current_pin: text,
                new_pin: { type: "string", pattern: "^[0-9]{4,8}$" },
              },
            },
            { current_pin: "1234", new_pin: "5678" },
          ),
        },
        responses: {
          200: { description: "PIN changed.", ...json(ref("OwnerPinStatus")) },
          400: error("The new PIN must be 4 to 8 digits.", {
            error: "The new PIN must be 4 to 8 digits.",
          }),
          403: error("Current PIN is incorrect.", { error: "Owner PIN is incorrect." }),
          429: error("Locked for 5 minutes after 5 wrong attempts.", {
            error: "Too many wrong PIN attempts. Try again in a few minutes.",
          }),
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/approvals": {
      get: {
        summary: "All owner approval requests",
        responses: {
          200: {
            description: "Approval records.",
            ...json(
              {
                type: "object",
                required: ["approvals"],
                properties: { approvals: { type: "array", items: ref("Approval") } },
              },
              EX.approvals,
            ),
          },
          ...COMMON_ERRORS,
        },
      },
    },
    "/api/nammaops/approvals/{id}/approve": {
      post: approvalAction(
        "Owner approves: re-read the draft, check it is unchanged, submit exactly once",
        true,
      ),
    },
    "/api/nammaops/approvals/{id}/reject": {
      post: approvalAction("Owner rejects: nothing is submitted", true),
    },
    "/api/nammaops/approvals/{id}/reconcile": {
      post: approvalAction(
        "After an uncertain or failed submission, read the ERP document before anything else",
        false,
      ),
    },
    "/api/nammaops/handoffs/{id}/accept": {
      post: handoffAction(
        "Owner agrees to move the conversation to the proposed teammate (chat button)",
      ),
    },
    "/api/nammaops/handoffs/{id}/decline": {
      post: handoffAction("Owner declines the proposed handoff; nothing moves"),
    },
    "/api/nammaops/openapi.json": {
      get: {
        summary: "This document",
        responses: { 200: { description: "OpenAPI 3.1 JSON.", ...json({ type: "object" }) } },
      },
    },
  },
  components: {
    schemas: {
      AgentVoices: {
        type: "object",
        required: ["voices", "available"],
        properties: {
          voices: {
            type: "object",
            additionalProperties: {
              type: "object",
              required: ["name", "voice", "custom"],
              properties: { name: text, voice: text, custom: { type: "boolean" } },
            },
          },
          available: strings,
        },
      },
      OwnerPinStatus: {
        type: "object",
        required: ["owner_pin"],
        properties: {
          owner_pin: {
            type: "object",
            required: ["source", "updated_at"],
            properties: {
              source: { enum: ["settings", "environment", "default"] },
              updated_at: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
        },
      },
      ManagementDashboard: {
        type: "object",
        required: [
          "dashboard",
          "source",
          "verification",
          "generated_at",
          "range",
          "cards",
          "charts",
          "tables",
          "sections_unavailable",
          "invocation_ids",
          "correlation_id",
        ],
        properties: {
          dashboard: { enum: DASHBOARD_NAMES },
          source: { enum: ["fixture", "erpnext"] },
          verification: { enum: ["synthetic_fixture", "live_read_unverified"] },
          generated_at: text,
          range: {
            type: "object",
            required: ["from", "to"],
            properties: { from: text, to: text },
          },
          cards: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "label", "value", "unit"],
              properties: {
                id: text,
                label: text,
                value: { type: ["number", "string", "null"] },
                unit: { enum: ["INR", "count", "pct", "days", "x", "text"] },
                tone: { enum: ["ok", "warn", "bad"] },
              },
            },
          },
          charts: {
            type: "object",
            additionalProperties: {
              type: "object",
              required: ["type", "labels", "series"],
              properties: {
                type: { enum: ["line", "bar", "donut", "aging"] },
                title: text,
                unit: text,
                labels: strings,
                series: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["name", "values"],
                    properties: {
                      name: text,
                      values: { type: "array", items: { type: ["number", "null"] } },
                    },
                  },
                },
              },
            },
          },
          tables: {
            type: "object",
            additionalProperties: {
              type: "object",
              required: ["columns", "rows"],
              properties: {
                columns: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["key", "label"],
                    properties: { key: text, label: text, unit: text },
                  },
                },
                rows: { type: "array", items: { type: "object" } },
              },
            },
          },
          disclaimer: text,
          sections_unavailable: {
            type: "array",
            items: {
              type: "object",
              required: ["sections", "capability", "status", "reason"],
              properties: {
                sections: strings,
                capability: text,
                status: { enum: ["blocked", "uncertain", "failed"] },
                reason: text,
              },
            },
          },
          invocation_ids: strings,
          correlation_id: text,
        },
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: text },
        additionalProperties: true,
      },
      Intent: {
        type: "object",
        required: ["action"],
        properties: {
          action: {
            enum: [
              "stock_check",
              "prepare_reorder",
              "daily_report",
              "demand_forecast",
              "supplier_comparison",
              ...V2_INTENTS,
            ],
          },
          products: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 60 },
          },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          to: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            description:
              "daily_report only: last day (inclusive) of a multi-day report, at most 31 days from `date`. A date in the future is clamped to today. Absent means a single day.",
          },
          qty: {
            type: "integer",
            minimum: 1,
            maximum: 100000,
            description: "supplier_comparison only: quantity to compare for.",
          },
        },
        additionalProperties: false,
      },
      TimelineEvent: {
        type: "object",
        required: ["at", "type", "agent"],
        properties: { at: text, type: text, agent: text, detail: text, document: text },
      },
      Task: {
        type: "object",
        required: ["id", "workflow_id", "role", "title", "status", "evidence"],
        properties: {
          id: text,
          workflow_id: text,
          role: { enum: ["manager", "inventory", "sales", "procurement", "finance"] },
          agent_id: { type: ["string", "null"] },
          agent_name: text,
          title: text,
          status: { enum: ["running", "completed", "failed", "blocked", "uncertain"] },
          started_at: text,
          finished_at: text,
          summary: { type: ["string", "null"] },
          error: text,
          evidence: {
            type: "array",
            items: {
              type: "object",
              required: ["business_capability", "invocation_id"],
              properties: { business_capability: text, invocation_id: text },
            },
          },
        },
      },
      WorkflowStatus: {
        enum: [
          "running",
          "completed",
          "partial",
          "awaiting_approval",
          "needs_clarification",
          "blocked",
          "failed",
          "uncertain",
          "interrupted",
          "outcome_unknown",
        ],
      },
      WorkflowSummary: {
        type: "object",
        required: ["id", "intent", "status", "created_at"],
        properties: {
          id: text,
          intent: ref("Intent"),
          status: ref("WorkflowStatus"),
          created_at: text,
          finished_at: { type: ["string", "null"] },
          summary: { type: ["string", "null"] },
          error: {
            ...text,
            description: "Why a blocked, failed or interrupted run did not finish.",
          },
        },
      },
      Workflow: {
        type: "object",
        required: ["id", "intent", "status", "created_at", "timeline", "tasks", "reasoning"],
        properties: {
          id: text,
          intent: ref("Intent"),
          command: { type: ["string", "null"] },
          origin: {
            description:
              "Set by the server when a voice agent started the workflow; never from a request body.",
            type: "object",
            properties: {
              channel: { enum: ["voice"] },
              call_id: text,
              voice_agent: text,
              voice_department: text,
              voice_intent: text,
            },
          },
          status: ref("WorkflowStatus"),
          created_at: text,
          finished_at: { type: ["string", "null"] },
          summary: { type: ["string", "null"] },
          error: text,
          clarifications: {
            type: ["array", "null"],
            items: {
              type: "object",
              required: ["requested", "reason", "options"],
              properties: {
                requested: text,
                reason: { enum: ["ambiguous", "unknown", "missing_product"] },
                options: strings,
              },
            },
          },
          result: {
            description:
              "Depends on intent: kind stock_check (rows, low, recommendations), prepare_reorder (orders, approvals, " +
              "rankings, unplaced), daily_report (total_sales, transaction_count, top_products, profit{status}), " +
              "demand_forecast (items with forecast, backtest, recommendation, evidence, limitations), " +
              "supplier_comparison (items with qty, qty_basis, list_price, considered quotations, choice, blocker).",
            oneOf: [
              { type: "null" },
              {
                type: "object",
                required: ["kind"],
                properties: {
                  kind: {
                    enum: [
                      "stock_check",
                      "prepare_reorder",
                      "daily_report",
                      "demand_forecast",
                      "supplier_comparison",
                      ...V2_INTENTS,
                    ],
                  },
                },
              },
            ],
          },
          reasoning: {
            type: "object",
            required: ["mode", "status"],
            properties: { mode: { enum: ["off", "manager"] }, status: text },
          },
          timeline: { type: "array", items: ref("TimelineEvent") },
          tasks: { type: "array", items: ref("Task") },
        },
      },
      Approval: {
        type: "object",
        required: [
          "id",
          "workflow_id",
          "erp_document_name",
          "supplier",
          "items",
          "total",
          "status",
          "expires_at",
          "fingerprint",
        ],
        properties: {
          id: text,
          workflow_id: text,
          action: { const: "submit_purchase_order" },
          erp_document_type: text,
          erp_document_name: text,
          supplier: text,
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["item_code", "qty", "rate"],
              properties: { item_code: text, qty: { type: "number" }, rate: { type: "number" } },
            },
          },
          total: { type: "number" },
          document_state: text,
          fingerprint: text,
          idempotency_key: text,
          status: {
            enum: [
              "pending",
              "submitting",
              "submitted",
              "rejected",
              "expired",
              "invalidated",
              "uncertain",
              "failed",
            ],
          },
          requested_at: text,
          expires_at: text,
          decided_at: text,
          error: text,
          history: { type: "array", items: { type: "object" } },
        },
      },
      BindingEntry: {
        type: "object",
        required: ["business_capability", "state", "availability"],
        properties: {
          business_capability: text,
          tool: { type: ["string", "null"] },
          capability_id: { type: ["string", "null"] },
          state: text,
          availability: text,
          risk: { type: ["string", "null"] },
        },
      },
      WorkforceAgent: {
        type: "object",
        required: [
          "agent_id",
          "name",
          "specialization_id",
          "seat_id",
          "business_capabilities",
          "granted",
        ],
        properties: {
          agent_id: text,
          name: text,
          specialization_id: text,
          seat_id: text,
          business_capabilities: strings,
          granted: strings,
        },
      },
      Workforce: {
        type: "object",
        required: ["agents", "server_id"],
        properties: {
          agents: { type: "object", additionalProperties: ref("WorkforceAgent") },
          principals: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "granted"],
              properties: { id: text, granted: strings },
            },
          },
          server_id: text,
          at: text,
        },
      },
      SetupReport: {
        type: "object",
        required: ["discovery", "reviewed", "agents", "principals", "blockers"],
        properties: {
          server: { type: "object", description: "Registered MCP server (no secrets)." },
          discovery: {
            type: "object",
            required: ["added", "changed", "unchanged", "removed", "rejected"],
            properties: {
              added: strings,
              changed: strings,
              unchanged: strings,
              removed: strings,
              rejected: strings,
            },
          },
          reviewed: strings,
          agents: { type: "array", items: ref("WorkforceAgent") },
          principals: { type: "array", items: { type: "object" } },
          blockers: strings,
        },
      },
      Dashboard: {
        type: "object",
        required: ["workforce", "binding", "latest", "approvals", "data_source"],
        properties: {
          workforce: { oneOf: [ref("Workforce"), { type: "null" }] },
          binding: { type: "array", items: ref("BindingEntry") },
          latest: {
            type: "object",
            description: "Latest workflow view per intent action.",
            additionalProperties: ref("Workflow"),
          },
          approvals: { type: "array", items: ref("Approval") },
          data_source: text,
        },
      },
    },
  },
};

function handoffAction(summary) {
  return {
    summary,
    description:
      "A handoff moves the conversation, never permissions. The target seat, session and context come from the " +
      "server's stored proposal; the request carries only the handoff ID. Single use and short-lived.",
    parameters: [{ name: "id", in: "path", required: true, schema: id }],
    responses: {
      200: {
        description: "Handoff status.",
        ...json({
          type: "object",
          required: ["handoff"],
          properties: {
            handoff: { type: "object", required: ["status"], properties: { status: text } },
          },
        }),
      },
      404: error("Unknown handoff.", { error: "Handoff not found." }),
      409: error("Already decided, or the conversation or teammate changed.", {
        error: "That handoff is consumed.",
      }),
      410: error("The handoff expired.", { error: "That handoff expired. Ask again." }),
      ...COMMON_ERRORS,
    },
  };
}

function approvalAction(summary, needsPin) {
  return {
    summary,
    description: needsPin
      ? "Requires the owner PIN (NAMMAOPS_OWNER_PIN). The PIN is checked before the request is looked up, so a wrong PIN " +
        "returns 403 even for an unknown ID. This is a business approval; it never changes tool permissions."
      : "Reads the purchase order through the governed gateway; sets submitted, or pending with a fresh expiry.",
    parameters: [{ name: "id", in: "path", required: true, schema: id }],
    requestBody: needsPin
      ? {
          required: true,
          ...json(
            { type: "object", required: ["pin"], properties: { pin: { type: "string" } } },
            { pin: "<owner PIN>" },
          ),
        }
      : undefined,
    responses: {
      200: {
        description: "Updated approval.",
        ...json({
          type: "object",
          required: ["approval"],
          properties: { approval: ref("Approval") },
        }),
      },
      ...(needsPin ? { 403: error("Owner PIN is incorrect.", EX.errors["e-appr"]) } : {}),
      404: error("Unknown approval request.", { error: "Approval request not found." }),
      409: error("Not pending, expired, changed draft, or not reconcilable.", {
        error: "This request is already submitted.",
      }),
      ...(needsPin
        ? {
            503: error("Owner approval not configured.", {
              error: "Owner approval is not configured (set NAMMAOPS_OWNER_PIN).",
            }),
          }
        : {}),
    },
  };
}
