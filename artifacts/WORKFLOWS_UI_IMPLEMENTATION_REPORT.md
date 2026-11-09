# Workflows page: implementation report

Date: 2026-11-09. Page: `http://localhost:3000/app/workflows`. Nothing is committed.

## Result in one paragraph

The Workflows page now shows each run as a readable business report instead of raw JSON: a plain-language summary, figures, tables, warnings placed above the figures, and next steps, with copy, print and CSV. History rows use the server's real field names, polling stops when nothing is running, questions the server asks can be answered on the page, and Prepare Reorder explains why it cannot create purchase orders. Type check and lint are clean, and the full suite passes (121 files, 1,521 tests). A real browser run against the live app passed every functional check. One check in the final run failed on a console message that is a stale dev-server cache problem, not a code problem (see "Needs your attention").

## Before and after

| Area | Before | After |
|---|---|---|
| Opening a run | Raw JSON in a 200 px box | Readable report; raw data only under "Advanced: raw data" |
| Summary | Never shown | Shown prominently, once |
| Start / finish / duration | Blank: the page read `startedAt`, `durationMs`, which the server never sends | Real `created_at` / `finished_at`; duration only when both exist and are in order |
| Blocked or failed run | Status word only | Reason in plain words, with the server's own text under "Technical detail" |
| Partial run | Looked like success or failure | "Partially completed" banner, what could not be checked and why, "Not available" / "Not checked" kept apart from a real zero |
| Polling | Every 2 s forever once any run was `partial`, `blocked` or waiting | Only while a run is `running` (and under 20 min old); waits while the tab is hidden; backs off and stops after 5 failures with "Try again" |
| Clarification | Invisible | Question shown, real options and product groups offered, answer starts a new linked run |
| Prepare Reorder | Ordinary button that always ended `blocked` | Labelled "Purchase orders off", with a read-only "Reorder suggestions" instead |
| Cards | 11, only product / date inputs | 16, each with labelled inputs for only the parameters the API accepts, validated before sending |
| Copy / print / export | None | Copy summary, copy full report, print, CSV per table |

## Files

New:
- `lib/workflow-contract.ts`: the server contract, status rules, labels.
- `components/workflows/`: `reports/` (model, formatters, CSV, one builder per workflow, generic fallback, plain text, print HTML), `ReportView.tsx`, `RunHistory.tsx`, `WorkflowCards.tsx`, `ClarificationPanel.tsx`, `ApprovalsCard.tsx`, `definitions.ts`, `clarify.ts`, `export.ts`, `styles.ts`.
- Tests: `workflow-reports.test.ts` (53), `workflows-page.test.tsx` (45), `workflow-export.test.tsx` (12), `workflow-inputs.test.ts` (13), `workflow-recovery.test.ts` (7), plus 18 real run-record fixtures in `lib/__tests__/fixtures/workflow-runs/`.
- Scripts: `scripts/shot-workflows.mjs` (live browser verification), `scripts/make-workflow-fixtures.mjs` (builds anonymised fixtures from real records).

Changed:
- `components/pages/WorkflowsPage.tsx` (rewritten), `lib/hooks/useNammaOps.ts` (real types, safe fetching, new polling, detail hook).
- `lib/server/nammaops/workflows.mjs`: `list()` also returns `error`; new `recover()`. `index.mjs` calls it at startup. `openapi.mjs`: `error` on the run summary, `interrupted` and `outcome_unknown` as statuses. (These three files also contain another session's uncommitted edits; mine are 75 added lines.)
- Same wrong-status bug fixed in two other pages that run their own wait loops: `ProcurementPage.tsx`, `dashboard/WorkflowAction.tsx`. `OverviewPage.tsx` read `completedAt` (never sent); now `finished_at`.

## API fields actually used

- List `GET /workflows`: `id, intent, status, created_at, finished_at, summary`, plus `error` (new, only when present).
- Detail `GET /workflows/:id` (`workflow`): the above plus `result, clarifications, timeline, tasks, origin, command, reasoning`. Tasks: `id, role, title, status, error, summary, started_at, finished_at`.
- Clarification: `requested, reason, options, categories, question`. `categories` is `{ "<group name>": [product names] }`.
- Start `POST /workflows { intent }`; only keys the server's intent schema accepts are ever sent.
- Approvals: `id, workflow_id, kind, erp_document_name, supplier | customer, items, total, status, requested_at, expires_at`; decisions send `{ pin, session }` for approve and reject.
- Binding `GET /binding`: `business_capability, tool, availability`, used for Prepare Reorder and for the cards that need an ERP connection.

Statuses handled: `running, completed, partial, needs_clarification, awaiting_approval, blocked, failed, uncertain, interrupted, outcome_unknown, stopped`. The server never writes `stopped`; it now writes `interrupted` / `outcome_unknown` only from the startup sweep.

## Workflow coverage

| Card | Report layout | Run live in this check |
|---|---|---|
| Stock Check, Daily Report (verified profit and no-profit day), Demand Forecast, Store Health, Supplier Comparison (product list, unknown product, group answer) | Specific | Yes |
| Udhaar, Expiry, Purchase Status, Supplier Performance, Customer Insights, Business Report, Billing Summary | Specific, built from real saved records | Earlier runs opened; not re-run |
| Prepare Reorder | Blocked run explained; read-only alternative runs `stock_check` | Blocked record opened; "Reorder suggestions" not run |
| Payments Summary, GST Summary, Purchase Order Lookup | Generic layout only | **Cannot run here**: their ERP connection is not set up (below) |
| Prepare Bill | **No card**: it creates a draft bill in the ERP | n/a |

## Test results

- `tsc` clean. ESLint: no errors or warnings in files I touched.
- Full suite: 121 files, 1,521 tests passed.
- Tests I checked by breaking the code: re-adding `partial`/`blocked`/`needs_clarification` as "active" makes the polling tests fail; removing the StrictMode fix makes those tests fail; running the new recovery and backoff tests against the old gateway code fails them.
- Live browser run (`node scripts/shot-workflows.mjs`, real app, real read-only ERPNext): the last fully clean run passed 32 of 32 checks; the final run passed 34 of 35 (the one failure is the console message below). It confirms: an earlier report opens readably; rows show start, finish and duration; Stock Check, Daily Report (a day with posted accounting, and today), Demand Forecast, Store Health and Supplier Comparison all run to their final status and open their reports; copy summary matches the server's saved summary; CSV has a UTF-8 BOM; print builds a clean light page (PDF saved); an unknown product asks a question, the page offers the real product groups, answering starts a linked run that completes, and the old run shows "Answered"; **zero list requests in a 14 s quiet window once nothing was running**; no sideways scroll on a phone-width screen.

### Bugs the live run caught that unit tests had missed
1. React StrictMode (development) skipped the second history load, leaving the history empty. Fixed and tested.
2. The server's `categories` maps group names to product names; I had offered product names as groups ("All Face Wash 100g"). Now "All Personal Care (4 products)".
3. The Payments, GST and PO Lookup cards could only produce blocked runs, so they now read the binding and say "Not available yet".

## Screenshots (`artifacts/workflows-ui/`)

`01-page-top` · `02-existing-stock-check-report` · `03-stock-check-running` · `04-stock-check-report` · `05-stock-check-print` (png and pdf) · `06-daily-report-completed` · `07-daily-report-today` · `08-demand-forecast` · `09-store-health` · `10-supplier-comparison-needs-input` · `11-supplier-comparison-result` · `12-clarification-question` · `13-clarification-answered` · `14-mobile-report` · `15-cards-needing-erp-setup` · `verification.json`

## Acceptance criteria

1. Open the page: yes (01). 2. Run a workflow: yes (03, 06, 08, 09, 11). 3. See its status: yes, the row shows Running then the final status; no manual refresh. 4. Open the result: yes, it opens by itself for a run you start. 5. Understand the summary: yes, prominent plain text, once. 6. Figures and recommendations: yes (04, 08, 11). 7. Warnings and incomplete checks: yes (09 shows expiry not checked; 07 shows profit unavailable). 8. Answer a clarification: yes (12, 13). 9. Copy or print: yes (checked live; the print dialog itself cannot be automated). 10. Return to history and open an earlier report: yes (02).

## Needs your attention

1. **Restart your dev server (`pnpm dev`).** Pages under the workspace shell currently return HTTP 500 on first load with `Failed to load chunk server/chunks/ssr/components_workflows_….js`, and Next shows "1 Issue". This is a stale Turbopack cache from adding the new `components/workflows` folder while the server was running. The page still works because the browser re-renders it, and I confirmed my page renders on the server without errors. A restart should clear it; please tell me if it does not, because I could not read the server's own log.
2. **Payments Summary, GST Summary and Purchase Order Lookup are not connected.** The binding reports their tools as `not_discovered`, so runs end `blocked` ("Unknown capability"). The cards now say so. They need the NammaOps setup/discovery step to be run after the adapter gained those tools; I did not run it. My three test runs of these left three blocked records in the history.
3. The server edits (`error` in the list, startup sweep) are live, because the server restarted after I made them. The sweep is covered by tests but has not had a stuck run to close.

## Known limitations

- The app's own sidebar does not collapse on phones, leaving about 170 px for the page. The page does not scroll sideways, but it is cramped. That is a shell issue I did not change.
- Only product-name questions can be answered on the page (missing product, unknown product, ambiguous product). Quantity, unit and customer questions are shown read-only.
- The approvals card is rebuilt on the real approval fields but was only tested with a fake server: there is nothing to approve on the live binding.
- `ProcurementPage` still reads the old `payload` fields of approvals, so its approval box has the same blank-text bug. Only its polling was fixed.
- Report times use the viewer's time zone. Runs in the history are the 50 most recent, as the server returns them.
- Fixtures keep real amounts and product names; only customer and supplier names are replaced.
- Running the live check adds real run records to your history (about ten per run).

## Re-running the checks

```
npx vitest --run lib/__tests__/workflow-reports.test.ts lib/__tests__/workflows-page.test.tsx lib/__tests__/workflow-export.test.tsx lib/__tests__/workflow-inputs.test.ts lib/__tests__/workflow-recovery.test.ts
node scripts/shot-workflows.mjs --url http://localhost:3000 --out artifacts/workflows-ui
node scripts/make-workflow-fixtures.mjs        # rebuild fixtures from real records (read-only)
```
