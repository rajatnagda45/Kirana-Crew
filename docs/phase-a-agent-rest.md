# Phase A: configurable agents and REST task execution

An agent is configuration over things that already exist: a seat, the reviewed manifests and grants
bound to it, and its OpenClaw session. A new specialization is a new `POST /api/agents` body, not new
code. Nothing here provisions a seat, grant, gateway agent or session.

## Paths

Both prefixes call the same functions (`lib/server/agent-api.mjs`).

| Operation          | Spec path                     | Runtime-prefixed mirror                     |
| ------------------ | ----------------------------- | ------------------------------------------- |
| Create agent       | `POST /api/agents`            | `POST /api/runtime/agents`                  |
| List agents        | `GET /api/agents`             | `GET /api/runtime/agents`                   |
| Get agent          | `GET /api/agents/{id}`        | `GET /api/runtime/agents/{id}`              |
| Update agent       | `PATCH /api/agents/{id}`      | `PATCH /api/runtime/agents/{id}`            |
| Submit text task   | `POST /api/tasks`             | `POST /api/runtime/agent-tasks`             |
| Submit voice task  | `POST /api/tasks/voice`       | `POST /api/runtime/agent-tasks/voice`       |
| Task status/result | `GET /api/tasks/{id}`         | `GET /api/runtime/agent-tasks/{id}`         |
| Task events        | `GET /api/tasks/{id}/events`  | `GET /api/runtime/agent-tasks/{id}/events`  |
| Cancel             | `POST /api/tasks/{id}/cancel` | `POST /api/runtime/agent-tasks/{id}/cancel` |

`/api/runtime/tasks*` is the existing seat API used by the UI and is unchanged, which is why the
mirror is `agent-tasks`. Writes must be same-origin like every other runtime write: send an `Origin`
header equal to the app origin (the demo script does).

## Agent configuration

```json
{
  "agent_id": "inventory-analyst-01",
  "name": "Inventory Analyst",
  "specialization": "Inventory analysis",
  "instructions": "Analyze inventory questions and report evidence clearly.",
  "runtime": "openclaw",
  "seat_id": "oc-planner",
  "workspace": "agents/inventory-analyst-01",
  "permissions": [],
  "capabilities": []
}
```

- `seat_id` must be an existing, verified seat on a runtime matching `runtime`.
- `permissions` are reviewed manifest IDs that already have a grant on that seat. They are checked,
  never created. `capabilities` must be provided by those manifests. Empty means a chat-only agent.
- `instructions` are sent as background context and add no tools or permissions.
- `PATCH` may change `name`, `specialization`, `instructions`, `model`, `capabilities`,
  `permissions`, `workspace`; `version` increases by one. Seat, runtime and ID cannot change.
- Stored in the existing `runtime_records` table (`agent.profile`). No migration.

## Execution

1. Validate the request and resolve the agent.
2. Check the emergency stop, the gateway connection and the seat binding (`TaskRuntime.resolve`).
3. If the agent has permissions, run `ExecutionRouter.selectTask({ preflight: true })` pinned to the
   seat for each manifest. No eligible option returns `409 {"status":"blocked","error":...}`.
   Per-task enforcement still happens at dispatch, as before.
4. Write the input record (`agent.task-input`), then call the seat runtime's `submit`, which stores
   the task row before the gateway is called.
5. Status is the runtime's own: `queued`, `running`, `completed`, `failed`, `stopped`,
   `cancel_requested`, `outcome_unknown`. Delivery alone never means `completed`, and nothing retries.

`session_id` is a caller correlation label saved with the input. The OpenClaw session is the seat's
bound session (or the profile's `session_key`).

Refusals use `{"status":"blocked"|"unavailable","error":"..."}` with 409 or 503.

## Voice

`multipart/form-data` with `audio` (file), `agent_id`, optional `session_id`, optional `language`.
Limits: 5 MB, `wav/mp3/ogg/flac/aac/m4a/webm` MIME types, language like `hi-IN` or `indic-auto`.
Transcript then enters the same function as text. The record stores transcript, provider, language,
MIME and byte count, never the audio.

Provider by `AGENT_TOWN_STT_PROVIDER` (unset means `503`):

| Value     | Needs            | Notes                                                                                                                                                                                           |
| --------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini`  | `GEMINI_API_KEY` | Temporary; `gemini-2.5-flash` via `generateContent`. Live Gemini voice in the browser is unchanged.                                                                                             |
| `gnani`   | `GNANI_API_KEY`  | Prisma v2.5 REST, `POST https://api.vachana.ai/stt/v3`, header `X-API-Key-ID`, fields `audio_file`, `format=transcribe`, `language_code`, `preferred_language`. 60 s timeout. No `model` field. |
| `fixture` | none             | Returns a fixed transcript. Proves wiring, not recognition.                                                                                                                                     |

## Tools

`lib/server/tool-registry.mjs` lists only `dispatch_to_worker` as a boundary for a later MCP client.
No discovery exists. Tool calls the gateway already reports are returned as `tool_events`.

## Status

| Item                                        | Implemented | Unit tested        | Integration tested | Live verified |
| ------------------------------------------- | ----------- | ------------------ | ------------------ | ------------- |
| Agent profiles, REST, task pipeline, cancel | yes         | yes (stub runtime) | no                 | see report    |
| Gnani, Gemini adapters                      | yes         | mocked HTTP/client | no                 | no (no keys)  |
| Fixture STT                                 | yes         | yes                | no                 | n/a           |
