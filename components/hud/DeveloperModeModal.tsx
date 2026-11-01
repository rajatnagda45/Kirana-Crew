"use client";
import "./seat-manager.css";
import "./developer-mode.css";
import { useEffect, useRef, useState } from "react";
import { Code2, X } from "lucide-react";
import type { SeatState } from "@/types/game";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = "/api/developer/agent-config";
const POLL_MS = 5000;

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { data });
  return data as T;
}

const lines = (value: string) =>
  value
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);

/** Developer-only configuration flow: the AI proposes, the server validates, the developer decides. */
export default function DeveloperModeModal(props: {
  open: boolean;
  onClose: () => void;
  seats: SeatState[];
}) {
  const { open, onClose, seats } = props;
  const [description, setDescription] = useState("");
  const [seatId, setSeatId] = useState("");
  const [generation, setGeneration] = useState<Any | null>(null);
  const [config, setConfig] = useState<Any | null>(null);
  const [validation, setValidation] = useState<Any | null>(null);
  const [saved, setSaved] = useState<Any | null>(null);
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(poll.current), []);
  if (!open) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const follow = (id: string) => {
    clearTimeout(poll.current);
    poll.current = setTimeout(async () => {
      try {
        const { generation: next } = await call<{ generation: Any }>(`/generations/${id}`);
        setGeneration(next);
        if (next.status === "generating") return follow(id);
        if (next.status === "proposed") {
          setConfig(next.proposal.config);
          setValidation(next.proposal.validation);
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }, POLL_MS);
  };

  const generate = () =>
    run(async () => {
      setConfig(null);
      setSaved(null);
      const { generation: started } = await call<{ generation: Any }>("/generate", "POST", {
        description,
        ...(seatId ? { seat_id: seatId } : {}),
      });
      setGeneration(started);
      follow(started.generation_id);
    });

  const edit = (key: string, value: unknown) => {
    setConfig((current) => (current ? { ...current, [key]: value } : current));
    setValidation(null);
  };

  const validate = () =>
    run(async () => {
      const result = await call<{ validation: Any }>("/validate", "POST", {
        config,
        ...(saved ? { id: saved.id } : {}),
      });
      setValidation(result.validation);
    });

  const save = (draft: boolean) =>
    run(async () => {
      const body = { confirm: true, draft, config, generation_id: generation?.generation_id };
      const result = saved
        ? await call<{ specialization: Any }>(`/${saved.id}`, "PATCH", body)
        : await call<{ specialization: Any }>("/save", "POST", body);
      setSaved(result.specialization);
      setValidation(result.specialization.validation);
    });

  const decide = (manifestId: string, decision: string) =>
    run(async () => {
      if (!saved) return;
      await call(`/${saved.id}/permissions/${manifestId}`, "POST", { decision });
      const { specialization } = await call<{ specialization: Any }>(`/${saved.id}`);
      setSaved(specialization);
      setValidation(specialization.validation);
    });

  const assign = () =>
    run(async () => {
      if (!saved) return;
      const result = await call<{ specialization: Any; agent?: Any }>(`/${saved.id}`, "PATCH", {
        confirm: true,
        config: {},
        assign: { agent_id: agentId, seat_id: config?.runtime?.seat_id ?? seatId },
      });
      setSaved(result.specialization);
      if (result.agent)
        setNotice(`Assigned ${result.agent.agent_id} (profile v${result.agent.version}).`);
    });

  const proposal = generation?.status === "proposed" ? generation.proposal : null;
  const decisions = Object.fromEntries(
    (saved?.approvals ?? []).map((row: Any) => [row.manifest_id, row.decision]),
  );
  const assigned = seats.filter((seat) => seat.assigned);

  return (
    <div
      className="seat-manager-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="seat-manager pixel-panel dev-mode"
        role="dialog"
        aria-modal="true"
        aria-label="Developer Mode"
        tabIndex={-1}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="seat-manager__header">
          <div className="team-heading">
            <span className="team-heading__icon">
              <Code2 size={22} />
            </span>
            <div>
              <h1>Developer Mode</h1>
              <p>Describe an agent. Review the proposal. Nothing is granted automatically.</p>
            </div>
          </div>
          <button className="pixel-icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <X size={18} />
          </button>
        </header>

        <div className="dev-mode__body">
          <section className="dev-mode__section">
            <h2>1. Describe the agent</h2>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              placeholder="Create an Inventory Analyst agent responsible for investigating stock discrepancies… It must not modify inventory records."
            />
            <div className="dev-mode__row">
              <label>
                Target seat
                <select value={seatId} onChange={(event) => setSeatId(event.target.value)}>
                  <option value="">Choose later</option>
                  {assigned.map((seat) => (
                    <option key={seat.seatId} value={seat.seatId}>
                      {seat.label} ({seat.seatId})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="pixel-button pixel-button--primary"
                disabled={
                  busy || description.trim().length < 20 || generation?.status === "generating"
                }
                onClick={generate}
              >
                Generate proposal
              </button>
            </div>
            {generation ? (
              <p className={`dev-mode__status dev-mode__status--${generation.status}`}>
                {generation.status === "generating"
                  ? `Generating on ${generation.source?.runtime} (task ${generation.task_status ?? "queued"})… this can take several minutes.`
                  : generation.status === "proposed"
                    ? "Proposal ready. Review every section before saving."
                    : `Generation ${generation.status}: ${generation.error}`}
              </p>
            ) : null}
          </section>

          {config ? (
            <>
              <section className="dev-mode__section">
                <h2>Agent overview</h2>
                <div className="dev-mode__grid">
                  {(["name", "specialization", "description", "purpose"] as const).map((key) => (
                    <label key={key}>
                      {key}
                      <input
                        value={config[key] ?? ""}
                        onChange={(event) => edit(key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </section>

              <section className="dev-mode__section">
                <h2>Instructions</h2>
                <textarea
                  rows={10}
                  value={config.instructions}
                  onChange={(event) => edit("instructions", event.target.value)}
                />
                <p className="seat-hint">
                  Instructions are context only; the server enforces permissions.
                </p>
              </section>

              <section className="dev-mode__section">
                <h2>Responsibilities and boundaries</h2>
                <div className="dev-mode__grid">
                  <label>
                    Responsibilities (one per line)
                    <textarea
                      rows={4}
                      value={config.responsibilities.join("\n")}
                      onChange={(event) => edit("responsibilities", lines(event.target.value))}
                    />
                  </label>
                  <label>
                    Allowed actions
                    <textarea
                      rows={4}
                      value={config.allowed_actions.join("\n")}
                      onChange={(event) => edit("allowed_actions", lines(event.target.value))}
                    />
                  </label>
                  <label>
                    Forbidden actions
                    <textarea
                      rows={4}
                      value={config.forbidden_actions.map((row: Any) => row.text).join("\n")}
                      onChange={(event) =>
                        edit(
                          "forbidden_actions",
                          lines(event.target.value).map((text) => ({
                            text,
                            category:
                              config.forbidden_actions.find((row: Any) => row.text === text)
                                ?.category ?? "other",
                          })),
                        )
                      }
                    />
                  </label>
                </div>
              </section>

              {proposal ? (
                <section className="dev-mode__section">
                  <h2>Capabilities</h2>
                  <table className="dev-mode__table">
                    <thead>
                      <tr>
                        <th>Capability</th>
                        <th>Status</th>
                        <th>Why</th>
                        <th>Tools / integrations</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proposal.capabilities.map((row: Any) => (
                        <tr key={row.id}>
                          <td>{row.id}</td>
                          <td>
                            <span className={`dev-mode__pill dev-mode__pill--${row.status}`}>
                              {row.status}
                            </span>
                          </td>
                          <td>
                            {row.reason}
                            {row.detail ? <em> — {row.detail}</em> : null}
                          </td>
                          <td>
                            {row.tools.join(", ") || "—"}
                            {row.integrations
                              .filter((item: Any) => !item.configured)
                              .map((item: Any) => (
                                <em key={item.id}> ({item.id} not configured)</em>
                              ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              {proposal ? (
                <section className="dev-mode__section">
                  <h2>Permissions</h2>
                  <table className="dev-mode__table">
                    <thead>
                      <tr>
                        <th>Permission</th>
                        <th>Class</th>
                        <th>Risk</th>
                        <th>Why</th>
                        <th>Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proposal.permission_recommendations.map((row: Any) => (
                        <tr key={row.id}>
                          <td>
                            {row.id}
                            {row.exists ? <em> (granted on seat)</em> : null}
                          </td>
                          <td>
                            <span
                              className={`dev-mode__pill dev-mode__pill--${row.classification}`}
                            >
                              {row.classification}
                            </span>
                          </td>
                          <td>{row.risk ?? "—"}</td>
                          <td>{row.reason}</td>
                          <td>
                            {config.permissions.includes(row.id) ? (
                              saved ? (
                                <span className="dev-mode__decide">
                                  {decisions[row.id] ?? "pending"}
                                  <button
                                    type="button"
                                    className="pixel-button"
                                    disabled={busy}
                                    onClick={() => decide(row.id, "approved")}
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    className="pixel-button"
                                    disabled={busy}
                                    onClick={() => decide(row.id, "denied")}
                                  >
                                    Deny
                                  </button>
                                  {decisions[row.id] === "approved" ? (
                                    <button
                                      type="button"
                                      className="pixel-button"
                                      disabled={busy}
                                      onClick={() => decide(row.id, "revoked")}
                                    >
                                      Revoke
                                    </button>
                                  ) : null}
                                </span>
                              ) : (
                                "save first"
                              )
                            ) : (
                              "not included"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              <section className="dev-mode__section">
                <h2>Runtime</h2>
                <p>
                  Provider <strong>{config.runtime?.provider}</strong>
                  {config.runtime?.seat_id ? `, seat ${config.runtime.seat_id}` : ", no seat yet"}.
                </p>
              </section>

              <section className="dev-mode__section">
                <h2>Validation</h2>
                {validation ? (
                  <div className={`dev-mode__status dev-mode__status--${validation.status}`}>
                    <strong>{validation.status}</strong>
                    {[...validation.errors, ...validation.warnings].map((text: string) => (
                      <p key={text}>{text}</p>
                    ))}
                    {validation.required_approvals.map((row: Any) => (
                      <p key={row.id}>
                        Needs approval: {row.id} ({row.risk}
                        {row.high_risk ? ", HIGH RISK" : ""}, {row.decision})
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="seat-hint">Edited. Validate again before saving.</p>
                )}
                <div className="team-actions">
                  <button type="button" className="pixel-button" disabled={busy} onClick={validate}>
                    Validate
                  </button>
                  <button
                    type="button"
                    className="pixel-button"
                    disabled={busy}
                    onClick={() => save(true)}
                  >
                    Save draft
                  </button>
                  <button
                    type="button"
                    className="pixel-button pixel-button--primary"
                    disabled={busy || validation?.status === "blocked"}
                    onClick={() => save(false)}
                  >
                    {saved ? `Save version ${saved.version + 1}` : "Save specialization"}
                  </button>
                </div>
                {saved ? (
                  <p className="seat-hint">
                    Saved {saved.id} v{saved.version} — {saved.approval_state}.
                  </p>
                ) : null}
              </section>

              {saved && saved.approval_state !== "draft" && saved.approval_state !== "blocked" ? (
                <section className="dev-mode__section">
                  <h2>Assign to a seat</h2>
                  <div className="dev-mode__row">
                    <input
                      placeholder="agent_id, e.g. inventory-analyst-01"
                      value={agentId}
                      onChange={(event) => setAgentId(event.target.value)}
                    />
                    <button
                      type="button"
                      className="pixel-button pixel-button--primary"
                      disabled={busy || !agentId || !(config.runtime?.seat_id || seatId)}
                      onClick={assign}
                    >
                      Assign
                    </button>
                  </div>
                  <p className="seat-hint">
                    Only approved permissions with a reviewed grant are carried over.
                  </p>
                </section>
              ) : null}
            </>
          ) : null}
          {notice ? <p className="team-feedback">{notice}</p> : null}
          {error ? <p className="team-feedback dev-mode__error">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
