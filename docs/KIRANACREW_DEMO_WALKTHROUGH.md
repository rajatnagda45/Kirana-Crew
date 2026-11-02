# KiranaCrew Demo Walkthrough

**KiranaCrew · Great Indian AI Internship Challenge 2026**

A judge-friendly step-by-step guide to reproduce the full demo. Every command is verified against the actual codebase. All ERP data in the demo is the synthetic test fixture — no real ERPNext account is required.

---

## Prerequisites

| Requirement | Version | How to check |
|---|---|---|
| Node.js | ≥ 22.19.0 | `node --version` |
| pnpm | 10.20.0 | `pnpm --version` |
| OpenClaw or Nightshift gateway | Any | `openclaw --version` |
| Git | Any | `git --version` |

---

## Step 1: Setup

```bash
git clone https://github.com/rajatnagda45/NammaOps.git kiranacrew
cd kiranacrew
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Edit `.env.local` with these minimum values for the fixture demo (no real API keys needed):

```env
# Minimum config for the fixture demo
AGENT_PROVIDER=openclaw
GATEWAY_URL=ws://127.0.0.1:18789/
NAMMAOPS_OWNER_PIN=4826
AGENT_TOWN_STT_PROVIDER=fixture
AGENT_TOWN_STT_FIXTURE_TRANSCRIPT=Check the stock of milk and rice.
```

For Gnani Prisma STT (requires a real key):
```env
AGENT_TOWN_STT_PROVIDER=gnani
GNANI_API_KEY=your_gnani_api_key
```

---

## Step 2: Run the Automated Demo Script

The fastest path to seeing the full workforce in action is the demo script, which runs entirely against the in-memory fixture — no server, no browser, no API keys needed:

```bash
node --import tsx scripts/nammaops-demo.mjs
```

### Expected output

```
== Milestone 1: five configured agents
{
  "discovered_tools": 19,
  "agents": [
    { "agent": "Manager Agent",     "seat": "desk-1", "permitted_tools": 0 },
    { "agent": "Inventory Agent",   "seat": "desk-2", "permitted_tools": 5 },
    { "agent": "Sales Agent",       "seat": "desk-3", "permitted_tools": 5 },
    { "agent": "Procurement Agent", "seat": "desk-4", "permitted_tools": 6 },
    { "agent": "Finance Agent",     "seat": "desk-5", "permitted_tools": 4 }
  ],
  "principals": [{ "id": "nammaops-po-submit", "granted": [...] }],
  "blockers": []
}

== Workflow 1: stock intelligence
3 item(s) to buy tomorrow: Milk 500ml (18 left, reorder at 20, buy 22); ...

┌─────────┬──────────────────────────┬───────┬──────────────────┬──────────────┐
│ (index) │ product                  │ stock │ reorder_level    │ result       │
├─────────┼──────────────────────────┼───────┼──────────────────┼──────────────┤
│ 0       │ 'Milk 500ml'             │ 18    │ 20               │ 'buy 22'     │
│ 1       │ 'Basmati Rice 1kg'       │ 45    │ 30               │ 'ok'         │
│ 2       │ 'Sunflower Oil 1L'       │ 8     │ 15               │ 'buy 22'     │
└─────────┴──────────────────────────┴───────┴──────────────────┴──────────────┘
```

The script then demonstrates:
- **Live ERP data change:** Milk stock is changed in the fixture file mid-run; the next check immediately shows the new value.
- **Workflow 2 — Reorder with supplier comparison:** Two draft POs are created, one per supplier.
- **Wrong PIN rejection:** `approve(first, "0000")` fails with "Owner PIN is incorrect."
- **Owner rejects first PO:** `reject(first, "4826")` → status `rejected`.
- **Owner approves second PO:** `approve(second, "4826")` → status `submitted`, docstatus=1 in ERP fixture.
- **Duplicate approval blocked:** Second `approve(second, "4826")` → "This request is already submitted."
- **Workflow 3 — Daily report:** Sales totals and P&L for the fixture date.
- **Audit trail:** Total governed ERP calls, denied calls (should be 0), calls per agent.

---

## Step 3: Start the Server

```bash
# Start the OpenClaw gateway (in a separate terminal)
openclaw gateway start

# Start KiranaCrew
pnpm dev
```

The server starts on `http://localhost:3000`.

---

## Step 4: Open the Landing Page

Navigate to `http://localhost:3000`. You should see the KiranaCrew landing page with:
- The five-agent crew cards (Alice/Bob/Carol/Dave voice departments)
- A voice command demo section
- Navigation to the application

---

## Step 5: Navigate to the NammaOps Panel

1. Click **Enter App** or navigate to `http://localhost:3000/app`
2. Move to the NammaOps section of the office (WASD/arrow keys, E to interact)
3. Or open the HUD dock and select **NammaOps**

The NammaOps panel shows:
- Setup status (click **Set up workforce** if not yet configured)
- Recent workflows with status badges
- Pending purchase order approvals (if any)
- Voice query entry

---

## Step 6: Voice Workflow Example (Fixture STT)

With `AGENT_TOWN_STT_PROVIDER=fixture` and `AGENT_TOWN_STT_FIXTURE_TRANSCRIPT=Check the stock of milk and rice.`:

1. In the NammaOps panel, click **Voice** or use the voice section
2. Record or submit audio — the fixture provider will use the fixed transcript
3. Watch the workflow execute:
   - Inventory Agent step appears: "Read stock and compare with reorder levels"
   - Each ERP call is logged in the workflow timeline
   - Result appears: stock levels for milk and rice
4. The voice contract shows `facts`, `recommendations`, and `limitations` arrays

**With Gnani Prisma STT (real key):**
1. Set `AGENT_TOWN_STT_PROVIDER=gnani` and `GNANI_API_KEY`
2. Speak in Kannada: "Haalina stock check maadi."
3. The transcript appears in the panel
4. The same workflow runs with the transcribed intent

---

## Step 7: Purchase Order Approval Flow

1. Run a reorder workflow from the NammaOps panel:
   - Type: "Prepare an order for the products that are running low."
   - Or use the demo script's Workflow 2

2. The workflow creates draft POs and returns `status: "awaiting_approval"`

3. The NammaOps panel shows pending approvals with:
   - PO name, supplier, items, total
   - Approve / Reject buttons

4. Click **Approve**, enter PIN `4826` (the demo PIN from `.env.local`)

5. The system:
   - Verifies the PIN
   - Re-reads the ERP draft to check the fingerprint
   - Calls `erp.po.submit`
   - Confirms `docstatus=1`

6. Status changes to `submitted`. The workflow moves to `completed`.

7. Try clicking **Approve** again → "This request is already submitted."

8. Try entering a wrong PIN → "Owner PIN is incorrect."

---

## Step 8: What the Demo Proves

| Claim | Evidence |
|---|---|
| Five agents with distinct ERP permissions | `setup.agents` output shows 0/5/5/6/4 permitted tools per agent |
| Deterministic results from ERP data | Stock quantities and supplier rates come directly from fixture data, not generated by a model |
| Live data changes are reflected immediately | Milk stock changes in the fixture file; next workflow check shows the new value |
| Owner approval is required for purchases | No PO is submitted without the correct PIN |
| Fingerprint prevents approval of changed orders | Changing the ERP draft between presentation and approval invalidates the request |
| Duplicate approvals are blocked | Second approve call fails with "already submitted" |
| Full audit trail | `audit.governed_calls`, `audit.by_agent`, `audit.denied` show every ERP invocation |
| 1162 tests pass | `pnpm test` — 105 test files, 0 failures |

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `POST /api/nammaops/setup` returns 409 | Workforce already set up | Normal on second run; the setup is idempotent |
| `GNANI_API_KEY is not configured` | `AGENT_TOWN_STT_PROVIDER=gnani` but no key | Add `GNANI_API_KEY` to `.env.local` or use `fixture` provider |
| `No free bound OpenClaw seat` | OpenClaw gateway not started | Run `openclaw gateway start` first |
| `NAMMAOPS_OWNER_PIN is not configured` | `NAMMAOPS_OWNER_PIN` not set | Add it to `.env.local` |
| Workflow status `blocked` | Agent not configured | Check `blockers` array in setup response |
| Approval status `invalidated` | ERP draft changed after presentation | Run a new reorder workflow |
