# Phase B: Developer Mode

A developer describes an agent in plain language. The model proposes a configuration, the server
checks it against the real registries, the developer reviews and decides, and the existing runtime
enforces the result. A proposal, a saved specialization and an approval never create a grant.

## Pipeline

| Stage                     | Function (`lib/server/developer-config.mjs`)  | Source of truth                          |
| ------------------------- | --------------------------------------------- | ---------------------------------------- |
| Requirement extraction    | `parseProposal` (strict schema, no repair)    | model output                             |
| Capability matching       | `matchCapabilities`                           | `SPECIALIST_CATALOGUE`, grants, services |
| Permission recommendation | `recommendPermissions`                        | manifest permissions, grants on the seat |
| Instruction generation    | `renderInstructions` (deterministic template) | reviewed fields                          |
| Structured configuration  | `buildProposal`                               | all of the above                         |
| Policy validation         | `validateConfig`                              | registries, binding, approvals           |
| Developer decision        | `Specializations.decide`                      | loopback developer only                  |
| Runtime enforcement       | `AgentTasks.preflight`                        | live grants, router, current approval    |

Generation runs as an ordinary task on the seat named by `AGENT_TOWN_DEVELOPER_GENERATION_SEAT`, on
the existing OpenClaw runtime. If the agent records any tool call during generation, the output is
discarded. Malformed output fails with the description preserved; nothing is retried.

## Classifications

- Capabilities: `available`, `requires_authorization`, `unavailable`, `ambiguous`, `not_required`.
- Permissions (manifest IDs, the existing grant unit): `existing`, `additional_recommended`,
  `high_risk`, `unsupported`, `not_required`. Risk comes from the manifest only: writes or
  approval-required writes are high, read-only is medium, none is low.
- Validation: `valid`, `valid_with_warnings`, `blocked`, `requires_developer_approval`.

## REST

Both `/api/developer/agent-config` and `/api/runtime/developer/agent-config` reach one handler.
Callers must be on a loopback socket and pass the runtime's same-origin checks.

| Method | Path                             | Purpose                                         |
| ------ | -------------------------------- | ----------------------------------------------- |
| POST   | `/generate`                      | Start generation; returns 202 + generation      |
| GET    | `/generations/{id}`              | `generating`, `proposed`, `failed`, `blocked`   |
| POST   | `/validate`                      | Validate a config (optional `id` for approvals) |
| POST   | `/save`                          | Save with `confirm: true`; `draft`, `assign`    |
| GET    | `/` and `/{id}`                  | List or read specializations                    |
| PATCH  | `/{id}`                          | New version; optional `assign`                  |
| POST   | `/{id}/permissions/{manifestId}` | `approved`, `denied` or `revoked`               |

## Storage

`runtime_records` namespaces, no new table: `developer.generation`, `agent.specialization` (revision is
the version) and `developer.permission-approval` (each change emits an event; the record keeps its
decision history). Phase A profiles gained `specialization_id` and `specialization_version`.

## UI

Employees panel → **Developer Mode**. Sections: describe, overview, instructions, responsibilities and
boundaries, capabilities, permissions with approve/deny/revoke, runtime, validation, assign.
