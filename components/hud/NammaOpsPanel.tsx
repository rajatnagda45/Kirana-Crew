"use client";
import "./developer-mode.css";
import { useEffect, useState } from "react";
import HudFlyout from "./HudFlyout";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const EXAMPLES = [
  "Check the stock of milk, rice and cooking oil. Tell me what we need to buy tomorrow.",
  "Prepare an order for the products that are running low. Choose the cheapest suitable supplier.",
  "Tell me how much business I did today, what sold the most and how much profit I made.",
  "What will sell next week and what should I buy?",
];
const ROLES = ["manager", "inventory", "sales", "procurement", "finance"];

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/nammaops${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

/**
 * NammaOps business view: the five-agent workforce, owner commands, results with evidence, the
 * owner's purchase approvals and the live workflow timeline. Data comes from the governed ERP
 * tools; the panel says when that source is the test fixture.
 */
export default function NammaOpsPanel() {
  const [dash, setDash] = useState<Any | null>(null);
  const [active, setActive] = useState<Any | null>(null);
  const [text, setText] = useState(EXAMPLES[0]);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [openItem, setOpenItem] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () =>
      void call<Any>("/dashboard")
        .then((data) => {
          if (!closed) setDash(data);
        })
        .catch((error) => !closed && setMessage(error.message));
    const events = new EventSource("/api/runtime/events");
    events.onmessage = (event) => {
      try {
        if (!/^nammaops\.|^mcp\.invocation$/.test(JSON.parse(event.data).kind)) return;
      } catch {
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
        setActive((current: Any | null) => {
          if (current)
            void call<{ workflow: Any }>(`/workflows/${current.id}`).then(
              (r) => !closed && setActive(r.workflow),
            );
          return current;
        });
      }, 250);
    };
    refresh();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      events.close();
    };
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const latest = dash?.latest ?? {};
  const stock = latest.stock_check?.result;
  const report = latest.daily_report?.result;
  const demand = latest.demand_forecast?.result;
  const reorder = latest.prepare_reorder;
  const workforce = dash?.workforce?.agents ?? {};
  const shown: Any | null = active ?? (Object.values(latest)[0] as Any | undefined) ?? null;
  const agentStatus = (role: string) =>
    shown?.tasks?.filter((task: Any) => task.role === role).at(-1)?.status ?? "idle";

  return (
    <HudFlyout
      title="KiranaCrew"
      subtitle="Your kirana store's AI workforce"
      bodyClass="nammaops-body"
    >
      <div className="dev-mode__body">
        {dash?.data_source?.startsWith("fixture") ? (
          <p className="seat-hint">
            Data source: <strong>test fixture</strong> (synthetic ERPNext-shaped data, not real
            store records).
          </p>
        ) : dash?.data_source ? (
          <p className="seat-hint">
            Data source: <strong>live ERPNext</strong> (read-only; purchase-order drafts and
            submission are disabled).
          </p>
        ) : null}

        <section className="dev-mode__section">
          <h2>Workforce</h2>
          {dash && !dash.workforce ? (
            <div className="dev-mode__row">
              <span>Not set up yet.</span>
              <button
                type="button"
                className="pixel-button pixel-button--primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const { setup } = await call<{ setup: Any }>("/setup", "POST", {});
                    setMessage(
                      setup.blockers.length ? setup.blockers.join(" ") : "Workforce configured.",
                    );
                    setDash(await call<Any>("/dashboard"));
                  })
                }
              >
                Set up workforce
              </button>
            </div>
          ) : (
            <table className="dev-mode__table">
              <tbody>
                {ROLES.map((role) => (
                  <tr key={role}>
                    <td>{workforce[role]?.name ?? role}</td>
                    <td>
                      <em>{workforce[role]?.seat_id ?? "unassigned"}</em>
                    </td>
                    <td>{workforce[role]?.granted?.length ?? 0} permitted tool(s)</td>
                    <td>
                      <span className={`dev-mode__pill dev-mode__pill--${agentStatus(role)}`}>
                        {agentStatus(role)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="dev-mode__section">
          <h2>Ask your store</h2>
          <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} />
          <div className="dev-mode__decide">
            {EXAMPLES.map((example, index) => (
              <button
                key={example}
                type="button"
                className="pixel-button"
                onClick={() => setText(example)}
              >
                {["Stock", "Reorder", "Today's business", "Demand"][index]}
              </button>
            ))}
            <button
              type="button"
              className="pixel-button pixel-button--primary"
              disabled={busy || !text.trim()}
              onClick={() =>
                run(async () => {
                  const { workflow } = await call<{ workflow: Any }>("/workflows", "POST", {
                    text,
                  });
                  setActive(workflow);
                })
              }
            >
              Run
            </button>
          </div>
          {shown ? (
            <p className={`dev-mode__status dev-mode__status--${shown.status}`}>
              <strong>{shown.status}</strong> {shown.summary ?? shown.error ?? ""}
              {shown.reasoning?.status === "accepted" ? <em> {shown.reasoning.reply}</em> : null}
            </p>
          ) : null}
        </section>

        {stock ? (
          <section className="dev-mode__section">
            <h2>Inventory</h2>
            <table className="dev-mode__table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Stock</th>
                  <th>Reorder at</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {stock.rows.map((row: Any) => (
                  <tr key={row.item_code}>
                    <td>{row.item_name}</td>
                    <td>{row.available}</td>
                    <td>{row.reorder_level ?? "—"}</td>
                    <td>
                      <span
                        className={`dev-mode__pill dev-mode__pill--${row.status === "low" ? "high_risk" : "available"}`}
                      >
                        {row.status === "low" ? `buy ${row.recommended_qty}` : row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {reorder ? (
          <section className="dev-mode__section">
            <h2>Purchase approval</h2>
            {dash?.approvals?.some((row: Any) => row.status === "pending") ? (
              <label className="dev-mode__row">
                Owner PIN
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label="Owner PIN"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                />
              </label>
            ) : null}
            {(reorder.result?.orders ?? []).map((po: Any) => {
              const approval = dash?.approvals?.find(
                (row: Any) => row.erp_document_name === po.name,
              );
              return (
                <div key={po.name}>
                  <strong>{po.name}</strong> · {po.supplier} · total {po.grand_total}
                  <table className="dev-mode__table">
                    <tbody>
                      {po.items.map((row: Any) => (
                        <tr key={row.item_code}>
                          <td>{row.item_code}</td>
                          <td>{row.qty}</td>
                          <td>@ {row.rate}</td>
                          <td>{row.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {approval?.status === "pending" ? (
                    <div className="dev-mode__row">
                      <button
                        type="button"
                        className="pixel-button pixel-button--primary"
                        disabled={busy || !pin}
                        onClick={() =>
                          run(async () => {
                            const { approval: done } = await call<{ approval: Any }>(
                              `/approvals/${approval.id}/approve`,
                              "POST",
                              { pin },
                            );
                            setMessage(`${po.name}: ${done.status}`);
                          })
                        }
                      >
                        Approve and submit
                      </button>
                      <button
                        type="button"
                        className="pixel-button"
                        disabled={busy || !pin}
                        onClick={() =>
                          run(async () => {
                            await call(`/approvals/${approval.id}/reject`, "POST", { pin });
                            setMessage(`${po.name}: rejected, nothing submitted.`);
                          })
                        }
                      >
                        Reject
                      </button>
                    </div>
                  ) : (
                    <p className="seat-hint">
                      {approval?.status === "submitted"
                        ? "Owner approved; submitted to ERP."
                        : approval
                          ? `Approval ${approval.status}${approval.error ? `: ${approval.error}` : ""}.`
                          : "No approval request."}
                    </p>
                  )}
                </div>
              );
            })}
          </section>
        ) : null}

        {demand ? (
          <section className="dev-mode__section">
            <h2>Demand Intelligence</h2>
            <p className="seat-hint">
              <strong>{demand.label}</strong> as of {demand.as_of}, from sales{" "}
              {demand.history_window.from} to {demand.history_window.to}.
              {dash?.data_source?.startsWith("fixture") ? (
                <strong> SYNTHETIC DEMO DATA.</strong>
              ) : null}{" "}
              A recommendation is not an order; purchases still need a reorder and your approval.
            </p>
            <table className="dev-mode__table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Next 7d</th>
                  <th>Next 30d</th>
                  <th>Stock</th>
                  <th>Incoming</th>
                  <th>Risk</th>
                  <th>Suggest</th>
                </tr>
              </thead>
              <tbody>
                {demand.items.map((row: Any) => (
                  <tr
                    key={row.item_code}
                    onClick={() => setOpenItem(openItem === row.item_code ? null : row.item_code)}
                    style={{ cursor: "pointer" }}
                    title="Show evidence"
                  >
                    <td>{row.item_name}</td>
                    {row.status === "ok" ? (
                      <>
                        <td>{row.forecast.next_7_days}</td>
                        <td>{row.forecast.next_30_days}</td>
                        <td>{row.current_stock}</td>
                        <td>{row.incoming_stock}</td>
                        <td>
                          <span
                            className={`dev-mode__pill dev-mode__pill--${row.recommendation?.stockout_risk === "high" ? "high_risk" : "available"}`}
                          >
                            {row.recommendation?.stockout_risk ?? "—"}
                          </span>
                        </td>
                        <td>{row.recommendation?.suggested_qty ?? "—"}</td>
                      </>
                    ) : (
                      <td colSpan={6}>
                        <em>insufficient evidence ({row.history.observed_days} day(s))</em>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {demand.items
              .filter((row: Any) => row.item_code === openItem)
              .map((row: Any) => (
                <div key={row.item_code} className="dev-mode__evidence">
                  <h2>Evidence: {row.item_name}</h2>
                  <p>
                    History {row.history.from} to {row.history.to}: {row.history.units_sold} unit(s)
                    over {row.history.observed_days} observed day(s)
                    {row.history.censored_stockout_days.length
                      ? `, ${row.history.censored_stockout_days.length} stockout day(s) excluded`
                      : ""}
                    .
                  </p>
                  {row.status === "ok" ? (
                    <>
                      <p>
                        Method: {row.method.label} (lowest error on the held-out{" "}
                        {row.backtest.window?.days ?? 0} days). Average {row.average_daily_demand}
                        /day, σ {row.method.sigma}.
                      </p>
                      <p>
                        Held-out error (WAPE):{" "}
                        {Object.entries(row.backtest.methods)
                          .map((entry: Any) => `${entry[0]} ${entry[1].wape ?? "n/a"}`)
                          .join(" · ")}
                      </p>
                      <p>
                        Lead time {row.supplier_lead_time_days ?? "unknown"} day(s): lead-time
                        demand {row.recommendation?.lead_time_demand ?? "—"} + safety{" "}
                        {row.recommendation?.safety_stock ?? "—"} − stock {row.current_stock} −
                        incoming {row.incoming_stock} → buy{" "}
                        {row.recommendation?.suggested_qty ?? "—"}.
                      </p>
                      {row.supplier_comparison?.choice ? (
                        <p>
                          Supplier: {row.supplier_comparison.choice.supplier} at{" "}
                          {row.supplier_comparison.choice.rate} (
                          {row.supplier_comparison.considered
                            .map(
                              (q: Any) =>
                                `${q.supplier}@${q.rate}${q.suitable ? "" : " not suitable"}`,
                            )
                            .join(", ")}
                          )
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  <p>
                    Sales documents ({row.evidence.sales_documents.length}):{" "}
                    <code>{row.evidence.sales_documents.slice(0, 8).join(", ")}</code>
                    {row.evidence.sales_documents.length > 8 ? " …" : ""}
                  </p>
                  {row.evidence.incoming_documents.length ? (
                    <p>
                      Incoming: <code>{row.evidence.incoming_documents.join(", ")}</code>
                    </p>
                  ) : null}
                  {row.limitations.map((text: string) => (
                    <p key={text} className="seat-hint">
                      {text}
                    </p>
                  ))}
                </div>
              ))}
          </section>
        ) : null}

        {report ? (
          <section className="dev-mode__section">
            <h2>Business today ({report.period.from_date})</h2>
            <p>
              Sales <strong>{report.total_sales}</strong> · {report.transaction_count}{" "}
              transaction(s) · top{" "}
              {report.top_products
                .slice(0, 3)
                .map((row: Any) => row.item_name)
                .join(", ") || "none"}
            </p>
            <p>
              Net profit:{" "}
              {report.profit.status === "verified" ? (
                <strong>
                  {report.profit.net_profit} <em>(posted P&amp;L)</em>
                </strong>
              ) : (
                <em>not verified — {report.profit.reason}</em>
              )}
            </p>
            {report.warnings.map((warning: string) => (
              <p key={warning} className="seat-hint">
                {warning}
              </p>
            ))}
          </section>
        ) : null}

        {shown ? (
          <section className="dev-mode__section">
            <h2>Activity</h2>
            <table className="dev-mode__table">
              <tbody>
                {shown.timeline.map((event: Any, index: number) => (
                  <tr key={`${event.at}-${index}`}>
                    <td>{new Date(event.at).toLocaleTimeString()}</td>
                    <td>{event.agent}</td>
                    <td>{event.type.replace(/_/g, " ").toLowerCase()}</td>
                    <td>
                      <em>{event.detail}</em>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {message ? <p className="team-feedback">{message}</p> : null}
      </div>
    </HudFlyout>
  );
}
