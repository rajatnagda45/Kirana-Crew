# Phase E: local ERPNext, hvgerp-mcp and historical-demand forecasting

## Status

| Part                                                | State                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| Resource preflight                                  | Done; gate failed twice, passed once after freeing memory             |
| Local ERPNext (frappe_docker `pwd.yml`)             | **Blocked**: stopped for memory safety during first start (see below) |
| Seed script `scripts/erpnext-seed.mjs`              | Written, dry-run checked; **not executed** against ERPNext            |
| hvgerp-mcp 3.7.0 install, `listTools()`, converters | **Blocked** on ERPNext; converters intentionally not guessed          |
| Forecast engine `lib/server/nammaops/forecast.mjs`  | Implemented, unit tested                                              |
| `demand_forecast` workflow                          | Implemented, fixture tested, browser verified                         |
| Demand Intelligence UI                              | Implemented, browser verified                                         |

## ERPNext attempt

- Official `frappe/frappe_docker` at `61d35da` (2026-10-29), image `frappe/erpnext:v16.53.0`, cloned to
  `I:\Project\agent_house\erpnext-demo` (outside the repo). Compose project `nammaops-erpnext`.
- `pwd.local.yml` overrides the frontend port to `127.0.0.1:8080` because `pwd.yml` publishes it on
  all interfaces with fixed demo credentials.
- While images extracted, the WSL/Docker VM grew from 0.7 GB to 4.6 GB of host RAM and host free
  memory reached 20 MB. The watchdog stopped the stack. Site creation was interrupted, so the demo
  volumes hold a partial site: reset with
  `docker compose -p nammaops-erpnext -f pwd.yml -f pwd.local.yml down -v` before retrying.
- Restart policy on the 11 demo containers was set to `no` so the broken site does not restart in a
  loop. Images are kept.

## Forecast method

- Daily units per item from submitted sales lines, zero-filled from the item's first evidence.
- Stockout days (stock ledger balance ≤ 0 at day end) are excluded as censored demand.
- Methods: 7-day average, 30-day average, exponential weighted (α 0.3), 30-day average with weekday
  factors (≥ 28 days). The last 14 observed days are held out; the method with the lowest WAPE wins.
- Reorder qty = max(0, lead-time demand + safety stock − (available − reserved) − incoming), safety
  stock = 1.65 × σ(daily demand, last 30 days) × √lead time. Fewer than 14 observed days →
  `insufficient_evidence`.
- It is a historical-demand forecast of this store's own sales, not a market prediction.

## Fixture history

`config/nammaops/fixture-data.json` → `demand_history` generates 90 days deterministically: weekend
uplift, a sunflower-oil promotion, a toor-dal stockout (18–23 Oct), a newly launched ghee, and open
purchase orders. New fixture tools: `list_sales_lines`, `list_stock_ledger`,
`list_open_purchase_orders`, bound as `erp.sales.history`, `erp.stock.movements`, `erp.po.open`.
