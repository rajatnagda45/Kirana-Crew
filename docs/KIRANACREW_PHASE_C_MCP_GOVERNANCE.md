# Phase C: MCP integration and permission governance

MCP servers provide tools. Agent Town decides who may call them, checks every call against current
policy, executes it once and records it.

Discovery is not assignment. Assignment is not authorisation. Authorisation is not approval.

## Modules

| Module                             | Owns                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `lib/server/mcp-servers.mjs`       | Server configs, allowlist policy, SDK transports, one reused client per server    |
| `lib/server/mcp-governance.mjs`    | Capability registry, assignments, grants, approvals, policy, the tool gateway     |
| `lib/server/mcp-api.mjs`           | Developer REST routes and the proxy-only gateway route                            |
| `lib/mcp/governed-tools-mcp.mjs`   | stdio MCP proxy for OpenClaw: lists governed tools, forwards calls to the gateway |
| `lib/mcp/fixture-stock-server.mjs` | Test fixture: four deterministic stock tools with in-memory data                  |

MCP client: `@modelcontextprotocol/sdk` 1.32.1 (exact pin). Transports: stdio and Streamable HTTP.
Legacy SSE is not supported.

## Connection policy (administrator-controlled, environment only)

- `AGENT_TOWN_MCP_STDIO_ALLOWLIST`: JSON list of exact `{command, args}` pairs. A stdio server can
  only run a command line that matches one entry. The allowlist is re-checked at every connect.
- `AGENT_TOWN_MCP_HTTP_ALLOWLIST`: JSON list of `https://` origins. Loopback `http://` is allowed.
- `authentication_ref` holds an environment variable **name**. The value is read only at connect
  time (Bearer header for HTTP, child env var for stdio) and never stored or returned.
- Connect timeout per server (default 10 s), request timeout per server (default 30 s). Connection
  attempts retry up to 3 times with backoff. Tool calls are never retried.

## Capability states

| State               | Set by                    | Meaning                                                                          |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| discovered          | MCP `tools/list`          | Tool seen; risk unreviewed. Server annotations are only a suggestion.            |
| registered          | developer review          | Risk set to READ, WRITE, DESTRUCTIVE or EXTERNAL_ACTION for this schema version. |
| assigned            | developer, per agent/spec | The agent may request it.                                                        |
| authorised          | developer grant           | Scoped to one capability, its schema fingerprint, optional resource and env.     |
| approved (per call) | developer approval        | One request, bound to agent, tool and argument fingerprint; 15 min; single use.  |

Capability IDs are `mcp.<server_id>.<tool_name>`. A schema change bumps `schema_version`, returns
the tool to review and makes existing grants stop matching. A removed tool is kept as `removed`.

## Decision order (deterministic, default deny)

1. Unknown or reserved agent identity → DENY
2. Unknown capability → DENY
3. Server disabled or removed, tool removed, invalid schema → UNAVAILABLE
4. Not reviewed for the current schema → DENY
5. Not assigned to the agent or its specialization → DENY
6. No active grant, or grant for an older schema → DENY
7. Resource or environment outside the grant → DENY
8. Risk needs approval (WRITE and EXTERNAL_ACTION by default, DESTRUCTIVE always) → REQUIRES_APPROVAL
9. Otherwise → ALLOW

Then, in the gateway: strict input validation (Ajv, current schema) → approval consumption (revision
checked, so a replay fails) → one `tools/call` with timeout → response checks (shape, 256 KB cap,
`isError`). A side-effecting call that times out or loses its connection is recorded `uncertain`.

## OpenClaw

OpenClaw runs its own MCP clients, so Agent Town cannot intercept calls OpenClaw makes to servers
registered directly in OpenClaw. The governed path is the proxy. Register only the proxy in
OpenClaw (one entry per Agent Town agent) and do not register the underlying servers there:

```bash
openclaw mcp add   # see `openclaw mcp add --help` for flags; the server is:
#   command: node  args: <repo>/lib/mcp/governed-tools-mcp.mjs
#   env: AGENT_TOWN_URL=http://127.0.0.1:3108 AGENT_TOWN_AGENT_ID=<agent_id>
#        AGENT_TOWN_MCP_PROXY_SECRET=<same value as the app's env>
```

The app needs `AGENT_TOWN_MCP_PROXY_SECRET` set. Limitations: the agent identity is fixed by the
proxy's configuration, not proven by OpenClaw; task correlation needs OpenClaw to pass
`_meta.agentTownTaskId`, which is not verified. The existing `tools.effective` checks are unchanged.

## REST (`/api/developer/...`, mirrored under `/api/runtime/developer/...`, loopback only)

| Method | Path                                                    |
| ------ | ------------------------------------------------------- |
| POST   | `/mcp/servers`                                          |
| GET    | `/mcp/servers`, `/mcp/servers/{id}`                     |
| PATCH  | `/mcp/servers/{id}`                                     |
| POST   | `/mcp/servers/{id}/connect`, `/discover`, `/disconnect` |
| GET    | `/mcp/invocations?task_id=&agent_id=`                   |
| GET    | `/capabilities`, `/capabilities/{id}`                   |
| POST   | `/capabilities/{id}/review`                             |
| GET    | `/agents/{id}/capabilities`, `/agents/{id}/permissions` |
| PUT    | `/agents/{id}/capabilities`                             |
| GET    | `/permissions`                                          |
| POST   | `/permissions`                                          |
| DELETE | `/permissions/{id}`                                     |
| GET    | `/approvals`                                            |
| POST   | `/approvals/{id}/approve`, `/approvals/{id}/deny`       |

Proxy route (secret header and loopback only): `GET /api/runtime/mcp-gateway/tools?agent_id=`,
`POST /api/runtime/mcp-gateway/invoke`.

## Storage

Existing `runtime_records` table, no migration: `mcp.server`, `mcp.server-health`, `mcp.capability`,
`mcp.assignment`, `mcp.grant`, `mcp.approval`, `mcp.invocation`, `mcp.decision`. Records are never
deleted; revoked grants and removed tools stay for audit.
