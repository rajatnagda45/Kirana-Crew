"use client";
import { useCallback, useEffect, useState } from "react";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const RISKS = ["READ", "WRITE", "DESTRUCTIVE", "EXTERNAL_ACTION"];

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/developer${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

type Snapshot = { servers: Any[]; capabilities: Any[]; approvals: Any[]; invocations: Any[] };

async function snapshot(): Promise<Snapshot> {
  const [s, c, a, i] = await Promise.all([
    call<{ servers: Any[] }>("/mcp/servers"),
    call<{ capabilities: Any[] }>("/capabilities"),
    call<{ approvals: Any[] }>("/approvals"),
    call<{ invocations: Any[] }>("/mcp/invocations"),
  ]);
  return {
    servers: s.servers,
    capabilities: c.capabilities,
    approvals: a.approvals,
    invocations: i.invocations,
  };
}

/**
 * MCP servers, discovered tools, reviewed capabilities, assignments, grants, approvals and audit.
 * Each of these is a separate state; none of them implies the next.
 */
export default function McpGovernancePanel() {
  const [servers, setServers] = useState<Any[]>([]);
  const [capabilities, setCapabilities] = useState<Any[]>([]);
  const [approvals, setApprovals] = useState<Any[]>([]);
  const [invocations, setInvocations] = useState<Any[]>([]);
  const [form, setForm] = useState({
    server_id: "",
    name: "",
    transport: "stdio",
    command: "node",
    args: "",
    url: "",
    authentication_ref: "",
  });
  const [subjectId, setSubjectId] = useState("");
  const [assigned, setAssigned] = useState<string[]>([]);
  const [effective, setEffective] = useState<Any | null>(null);
  const [grantCapability, setGrantCapability] = useState("");
  const [scope, setScope] = useState({ argument: "", allowed: "" });
  const [schemaOpen, setSchemaOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const apply = useCallback((data: Snapshot) => {
    setServers(data.servers);
    setCapabilities(data.capabilities);
    setApprovals(data.approvals);
    setInvocations(data.invocations.slice(-20).reverse());
  }, []);
  const refresh = useCallback(async () => apply(await snapshot()), [apply]);

  useEffect(() => {
    let live = true;
    snapshot()
      .then((data) => live && apply(data))
      .catch((error) => live && setMessage(error.message));
    return () => {
      live = false;
    };
  }, [apply]);

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      await refresh();
      if (done) setMessage(done);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const register = () =>
    run(
      () =>
        call("/mcp/servers", "POST", {
          server_id: form.server_id,
          name: form.name,
          transport: form.transport,
          connection:
            form.transport === "stdio"
              ? { command: form.command, args: form.args.split(" ").filter(Boolean) }
              : { url: form.url },
          ...(form.authentication_ref ? { authentication_ref: form.authentication_ref } : {}),
        }),
      "Server registered. Connect, then discover its tools.",
    );

  const loadSubject = () =>
    run(async () => {
      const key = encodeURIComponent(subjectId);
      const [a, p] = await Promise.all([
        call<Any>(`/agents/${key}/capabilities`),
        call<Any>(`/agents/${key}/permissions`),
      ]);
      setAssigned(a.capabilities);
      setEffective({ ...p, subject: a.subject });
    });

  const registered = capabilities.filter((row) => row.state === "registered");
  const decisionOf = (id: string) =>
    effective?.decisions?.find((row: Any) => row.capability_id === id);

  return (
    <div className="dev-mode__body">
      <p className="seat-hint">
        <strong>Discovered</strong> tool → <strong>registered</strong> capability (risk reviewed) →{" "}
        <strong>assigned</strong> to an agent → <strong>authorised</strong> by a grant →{" "}
        <strong>approved</strong> per operation when the risk requires it. Each step is separate.
      </p>

      <section className="dev-mode__section">
        <h2>MCP servers</h2>
        <div className="dev-mode__grid">
          <label>
            server_id
            <input
              value={form.server_id}
              onChange={(e) => setForm({ ...form, server_id: e.target.value })}
            />
          </label>
          <label>
            name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            transport
            <select
              value={form.transport}
              onChange={(e) => setForm({ ...form, transport: e.target.value })}
            >
              <option value="stdio">stdio (allowlisted command only)</option>
              <option value="streamable_http">Streamable HTTP</option>
            </select>
          </label>
          {form.transport === "stdio" ? (
            <>
              <label>
                command
                <input
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                />
              </label>
              <label>
                args (space separated)
                <input
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label>
              url
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </label>
          )}
          <label>
            authentication env var (optional, name only)
            <input
              value={form.authentication_ref}
              onChange={(e) => setForm({ ...form, authentication_ref: e.target.value })}
            />
          </label>
        </div>
        <div className="team-actions">
          <button
            type="button"
            className="pixel-button pixel-button--primary"
            disabled={busy}
            onClick={register}
          >
            Register server
          </button>
        </div>
        <table className="dev-mode__table">
          <thead>
            <tr>
              <th>Server</th>
              <th>Transport</th>
              <th>Health</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => (
              <tr key={server.server_id}>
                <td>
                  {server.name}{" "}
                  <em>
                    ({server.server_id}, v{server.version})
                  </em>
                  {server.authentication ? <em> auth: ${server.authentication.ref}</em> : null}
                </td>
                <td>{server.transport}</td>
                <td>
                  <span className={`dev-mode__pill dev-mode__pill--${server.health.status}`}>
                    {server.enabled ? server.health.status : "disabled"}
                  </span>
                  {server.health.last_error ? <em> {server.health.last_error}</em> : null}
                </td>
                <td className="dev-mode__decide">
                  {(["connect", "discover", "disconnect"] as const).map((action) => (
                    <button
                      key={action}
                      type="button"
                      className="pixel-button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => call(`/mcp/servers/${server.server_id}/${action}`, "POST"),
                          `${action}: done`,
                        )
                      }
                    >
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dev-mode__section">
        <h2>Discovered tools and registered capabilities</h2>
        <table className="dev-mode__table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>State</th>
              <th>Availability</th>
              <th>Risk (server hint)</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {capabilities.map((row) => (
              <tr key={row.capability_id}>
                <td>
                  {row.capability_id}
                  <br />
                  <em>{row.description || "no description"}</em>{" "}
                  <button
                    type="button"
                    className="pixel-button"
                    onClick={() =>
                      setSchemaOpen(schemaOpen === row.capability_id ? null : row.capability_id)
                    }
                  >
                    schema v{row.schema_version}
                  </button>
                  {schemaOpen === row.capability_id ? (
                    <pre className="dev-mode__schema">
                      {JSON.stringify(row.input_schema, null, 2)}
                    </pre>
                  ) : null}
                </td>
                <td>
                  {row.state === "registered" ? "registered" : `discovered (${row.review?.status})`}
                </td>
                <td>
                  <span className={`dev-mode__pill dev-mode__pill--${row.availability}`}>
                    {row.availability}
                  </span>
                </td>
                <td>
                  {row.risk ?? "unreviewed"} <em>({row.suggested_risk})</em>
                  {row.approval_required ? <em> · per-call approval</em> : null}
                </td>
                <td>
                  <select
                    defaultValue={row.risk ?? row.suggested_risk}
                    onChange={(e) =>
                      run(
                        () =>
                          call(`/capabilities/${row.capability_id}/review`, "POST", {
                            risk: e.target.value,
                          }),
                        `${row.capability_id} reviewed as ${e.target.value}`,
                      )
                    }
                    disabled={busy || row.availability === "invalid_schema"}
                  >
                    {RISKS.map((risk) => (
                      <option key={risk} value={risk}>
                        {risk}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dev-mode__section">
        <h2>Assignments and permissions</h2>
        <div className="dev-mode__row">
          <input
            placeholder="agent_id or specialization id"
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
          />
          <button
            type="button"
            className="pixel-button"
            disabled={busy || !subjectId}
            onClick={loadSubject}
          >
            Load
          </button>
        </div>
        {effective ? (
          <>
            <h2>Assigned (may request)</h2>
            <div className="dev-mode__grid">
              {registered.map((row) => (
                <label key={row.capability_id}>
                  <span>
                    <input
                      type="checkbox"
                      checked={assigned.includes(row.capability_id)}
                      onChange={(e) =>
                        setAssigned(
                          e.target.checked
                            ? [...assigned, row.capability_id]
                            : assigned.filter((id) => id !== row.capability_id),
                        )
                      }
                    />{" "}
                    {row.capability_id} ({row.risk})
                    {decisionOf(row.capability_id) ? (
                      <em> → {decisionOf(row.capability_id).decision}</em>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
            <div className="team-actions">
              <button
                type="button"
                className="pixel-button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await call(`/agents/${encodeURIComponent(subjectId)}/capabilities`, "PUT", {
                      capabilities: assigned,
                    });
                    await loadSubject();
                  }, "Assignments saved. Assignment does not authorise.")
                }
              >
                Save assignments
              </button>
            </div>

            <h2>Grants (authorised)</h2>
            <table className="dev-mode__table">
              <tbody>
                {(effective.grants ?? []).map((grant: Any) => (
                  <tr key={grant.grant_id}>
                    <td>{grant.capability_id}</td>
                    <td>{grant.operation}</td>
                    <td>
                      {grant.resource
                        ? `${grant.resource.argument} ∈ ${grant.resource.allowed.join(", ")}`
                        : "any resource"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="pixel-button"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await call(`/permissions/${grant.grant_id}`, "DELETE");
                            await loadSubject();
                          }, "Grant revoked.")
                        }
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="dev-mode__row">
              <select value={grantCapability} onChange={(e) => setGrantCapability(e.target.value)}>
                <option value="">Capability to grant</option>
                {registered.map((row) => (
                  <option key={row.capability_id} value={row.capability_id}>
                    {row.capability_id} ({row.risk})
                  </option>
                ))}
              </select>
              <input
                placeholder="resource argument (optional)"
                value={scope.argument}
                onChange={(e) => setScope({ ...scope, argument: e.target.value })}
              />
              <input
                placeholder="allowed values, comma separated"
                value={scope.allowed}
                onChange={(e) => setScope({ ...scope, allowed: e.target.value })}
              />
              <button
                type="button"
                className="pixel-button pixel-button--primary"
                disabled={busy || !grantCapability}
                onClick={() =>
                  run(async () => {
                    await call("/permissions", "POST", {
                      subject: effective.subject,
                      capability_id: grantCapability,
                      ...(scope.argument
                        ? {
                            resource: {
                              argument: scope.argument,
                              allowed: scope.allowed
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            },
                          }
                        : {}),
                    });
                    await loadSubject();
                  }, "Grant created.")
                }
              >
                Grant
              </button>
            </div>
          </>
        ) : null}
      </section>

      <section className="dev-mode__section">
        <h2>Approval requests (per operation)</h2>
        <table className="dev-mode__table">
          <tbody>
            {approvals.map((row) => (
              <tr key={row.request_id}>
                <td>
                  {row.request_id}
                  <br />
                  <em>
                    {row.agent_id} → {row.capability_id} ({row.operation})
                  </em>
                </td>
                <td>
                  <code>{JSON.stringify(row.args_summary)}</code>
                </td>
                <td>
                  <span className={`dev-mode__pill dev-mode__pill--${row.status}`}>
                    {row.status}
                  </span>
                  <em> expires {new Date(row.expires_at).toLocaleTimeString()}</em>
                </td>
                <td className="dev-mode__decide">
                  {row.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        className="pixel-button"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => call(`/approvals/${row.request_id}/approve`, "POST"),
                            "Approved.",
                          )
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="pixel-button"
                        disabled={busy}
                        onClick={() =>
                          run(() => call(`/approvals/${row.request_id}/deny`, "POST"), "Denied.")
                        }
                      >
                        Deny
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dev-mode__section">
        <h2>Tool invocation audit (latest 20)</h2>
        <table className="dev-mode__table">
          <tbody>
            {invocations.map((row) => (
              <tr key={row.invocation_id}>
                <td>{row.started_at}</td>
                <td>
                  {row.agent_id} → {row.capability_id}
                  {row.task_id ? <em> task {row.task_id}</em> : null}
                </td>
                <td>{row.decision}</td>
                <td>
                  <span className={`dev-mode__pill dev-mode__pill--${row.status}`}>
                    {row.status}
                  </span>
                  {row.error ? <em> {row.error}</em> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {message ? <p className="team-feedback">{message}</p> : null}
    </div>
  );
}
