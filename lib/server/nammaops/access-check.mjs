/**
 * A fixed, read-only access check for the NammaOps workforce. Each probe runs through the normal
 * governed path (ErpBinding -> Governance.decide -> ToolGateway, audited per invocation) under the
 * named specialist's own identity. Probes are hard-coded: a request cannot choose the agent, the
 * capability or the arguments, and no probe is a write that could succeed (the "denied" probes
 * target capabilities the agent was never granted, or that the binding disables).
 */
export const ACCESS_PROBES = Object.freeze([
  { agent: "nammaops-inventory", capability: "erp.warehouses.list", expect: "allowed" },
  { agent: "nammaops-sales", capability: "erp.customers.list", expect: "allowed" },
  { agent: "nammaops-procurement", capability: "erp.suppliers.list", expect: "allowed" },
  { agent: "nammaops-finance", capability: "erp.receivables.aging", expect: "allowed", asOf: true },
  { agent: "nammaops-manager", capability: "erp.items.list", expect: "denied" },
  { agent: "nammaops-finance", capability: "erp.stock.balance", expect: "denied" },
  {
    agent: "nammaops-inventory",
    capability: "erp.receivables.aging",
    expect: "denied",
    asOf: true,
  },
  {
    agent: "nammaops-sales",
    capability: "erp.po.submit",
    expect: "denied",
    args: { name: "ACCESS-CHECK-NONE" },
  },
]);

const rowsIn = (data) => {
  for (const key of ["warehouses", "customers", "suppliers", "invoices", "items", "bins"])
    if (Array.isArray(data?.[key])) return { key, count: data[key].length };
  return null;
};

export async function accessCheck({ binding, today, mcpGateway }) {
  const results = [];
  for (const probe of ACCESS_PROBES) {
    const args = probe.args ?? (probe.asOf ? { as_of: today() } : {});
    const row = {
      agent: probe.agent,
      capability: probe.capability,
      tool: binding.binding.capabilities[probe.capability]?.tool ?? null,
      expected: probe.expect,
    };
    try {
      const out = await binding.call(probe.agent, probe.capability, args, {
        correlationId: "access-check",
      });
      const invocation = mcpGateway
        ?.invocations?.({ agentId: probe.agent })
        .find((inv) => inv.invocation_id === out.invocation_id);
      results.push({
        ...row,
        outcome: "allowed",
        invocation_id: out.invocation_id,
        invocation_status: invocation?.status ?? "completed",
        source: out.data?.source ?? null,
        rows: rowsIn(out.data),
      });
    } catch (error) {
      results.push({
        ...row,
        outcome: "denied",
        // "blocked" by governance/binding; an invocation id exists when the gateway recorded it.
        invocation_id: error.invocation_id ?? null,
        invocation_status:
          error.invocationStatus ?? (error.invocation_id ? null : "refused_before_gateway"),
        reason: String(error.message).slice(0, 240),
      });
    }
  }
  // A denial only counts when policy refused it, never when the call merely failed.
  const refused = (r) =>
    ["denied", "unavailable", "refused_before_gateway"].includes(r.invocation_status);
  const scored = results.map((r) => ({
    ...r,
    pass: r.expected === "allowed" ? r.outcome === "allowed" : r.outcome === "denied" && refused(r),
  }));
  return { results: scored, passed: scored.every((r) => r.pass) };
}
