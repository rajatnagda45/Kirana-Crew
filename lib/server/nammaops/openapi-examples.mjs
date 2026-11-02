/**
 * Real responses captured from the running app on TEST FIXTURE data (2026-11-01), trimmed to a
 * couple of entries per list. Regenerate after contract changes; never hand-edit values.
 */
export const NAMMAOPS_EXAMPLES = {
  workforce: {
    workforce: {
      agents: {
        manager: {
          agent_id: "nammaops-manager",
          name: "Manager Agent",
          specialization_id: "spec_kirana-store-operations-coordinator_945497",
          seat_id: "analyze",
          business_capabilities: [],
          granted: [],
        },
        inventory: {
          agent_id: "nammaops-inventory",
          name: "Inventory Agent",
          specialization_id: "spec_kirana-stock-monitoring_e5173f",
          seat_id: "plan",
          business_capabilities: ["erp.items.list"],
          granted: ["mcp.erp-fixture.list_items"],
        },
        sales: {
          agent_id: "nammaops-sales",
          name: "Sales Agent",
          specialization_id: "spec_kirana-sales-analysis_c02f8d",
          seat_id: "review",
          business_capabilities: ["erp.sales_invoices.list"],
          granted: ["mcp.erp-fixture.list_sales_invoices"],
        },
        procurement: {
          agent_id: "nammaops-procurement",
          name: "Procurement Agent",
          specialization_id: "spec_kirana-supplier-purchasing_9f4836",
          seat_id: "seat-0",
          business_capabilities: ["erp.suppliers.list"],
          granted: ["mcp.erp-fixture.list_suppliers"],
        },
        finance: {
          agent_id: "nammaops-finance",
          name: "Finance Agent",
          specialization_id: "spec_kirana-financial-reporting_0307e2",
          seat_id: "seat-1",
          business_capabilities: ["erp.pnl"],
          granted: ["mcp.erp-fixture.get_profit_and_loss"],
        },
      },
      principals: [
        {
          id: "nammaops-po-submit",
          granted: ["mcp.erp-fixture.get_purchase_order"],
        },
      ],
      server_id: "erp-fixture",
      at: "2026-11-01T08:41:38.420Z",
      id: "current",
      revision: 2,
    },
  },
  binding: {
    binding: [
      {
        business_capability: "erp.items.list",
        tool: "list_items",
        capability_id: "mcp.erp-fixture.list_items",
        state: "registered",
        availability: "available",
        risk: "READ",
      },
      {
        business_capability: "erp.stock.balance",
        tool: "get_stock_balance",
        capability_id: "mcp.erp-fixture.get_stock_balance",
        state: "registered",
        availability: "available",
        risk: "READ",
      },
    ],
  },
  workflows: {
    workflows: [
      {
        id: "wf_mvxl63se55bf7fc5",
        intent: {
          action: "demand_forecast",
          products: [],
        },
        status: "completed",
        created_at: "2026-11-01T08:46:43.118Z",
        finished_at: "2026-11-01T08:46:43.269Z",
        summary:
          "Historical-demand forecast for the next 7 days: Toned Milk 500ml ~272.5, Sunflower Oil 1L ~46.7, Sugar 1kg ~42.2. Suggested purchases: Toned Milk 500ml 44 (high risk); Sona Masoori Rice 5kg 3 (medium risk). Not enough history to forecast: Ghee 200ml.",
      },
      {
        id: "wf_mvxl628g961fcb5e",
        intent: {
          action: "daily_report",
          date: "2026-11-01",
        },
        status: "completed",
        created_at: "2026-11-01T08:46:41.104Z",
        finished_at: "2026-11-01T08:46:41.178Z",
        summary:
          "2026-11-01: sales 3186 across 3 transaction(s); top sellers Sona Masoori Rice 5kg, Toned Milk 500ml, Sunflower Oil 1L; net profit 484 from the posted P&L.",
      },
    ],
  },
  approvals: {
    approvals: [
      {
        workflow_id: "wf_mvxjfvl54835ee0b",
        action: "submit_purchase_order",
        erp_document_type: "Purchase Order",
        erp_document_name: "PUR-ORD-FX-0001",
        supplier: "Bengaluru Wholesale Traders",
        items: [
          {
            item_code: "MILK-500",
            qty: 60,
            rate: 24,
          },
        ],
        total: 1440,
        document_state: "draft",
        fingerprint: "1460e0625f828ea26bd9d3d06c658d365c770dd62863d58de3ebde5d6bb14ba5",
        idempotency_key: "own_mvxjfvr858dc266894",
        status: "expired",
        requested_at: "2026-11-01T07:58:20.036Z",
        expires_at: "2026-11-01T08:28:20.036Z",
        history: [],
        id: "own_mvxjfvr858dc266894",
        revision: 1,
      },
      {
        workflow_id: "wf_mvxjfvl54835ee0b",
        action: "submit_purchase_order",
        erp_document_type: "Purchase Order",
        erp_document_name: "PUR-ORD-FX-0002",
        supplier: "Mysuru Agro Supplies",
        items: [
          {
            item_code: "OIL-SUN-1L",
            qty: 24,
            rate: 138,
          },
        ],
        total: 3312,
        document_state: "draft",
        fingerprint: "6299ce9a180d5a5b75e8496e1679002dc91219cdfeef9bb7b5b499e6d7b529f2",
        idempotency_key: "own_mvxjfvrg9dffd2b2d0",
        status: "expired",
        requested_at: "2026-11-01T07:58:20.045Z",
        expires_at: "2026-11-01T08:28:20.045Z",
        history: [],
        id: "own_mvxjfvrg9dffd2b2d0",
        revision: 1,
      },
    ],
  },
  setup: {
    setup: {
      server: {
        server_id: "erp-fixture",
        enabled: true,
        authentication_ref: null,
        connect_timeout_ms: 10000,
        request_timeout_ms: 30000,
        description: "Synthetic ERPNext-shaped data for development. Not real business data.",
        name: "ERPNext fixture (TEST)",
        transport: "stdio",
        connection: {
          command: "node",
          args: ["lib/mcp/fixture-erpnext-server.mjs"],
        },
        createdAt: "2026-11-01T07:58:11.895Z",
        version: 1,
        authentication: null,
        health: {
          status: "connected",
          last_error: null,
          last_connected_at: "2026-11-01T10:14:14.033Z",
          last_discovery_at: "2026-11-01T10:14:14.040Z",
        },
      },
      discovery: {
        added: [],
        changed: [],
        unchanged: ["mcp.erp-fixture.list_items"],
        removed: [],
        rejected: [],
      },
      reviewed: [],
      agents: [
        {
          agent_id: "nammaops-manager",
          name: "Manager Agent",
          specialization_id: "spec_kirana-store-operations-coordinator_945497",
          seat_id: "analyze",
          business_capabilities: [],
          granted: [],
        },
      ],
      principals: [
        {
          id: "nammaops-po-submit",
          granted: ["mcp.erp-fixture.get_purchase_order"],
        },
      ],
      blockers: [],
    },
  },
  workflowStarted: {
    workflow: {
      intent: {
        action: "stock_check",
        products: ["milk"],
      },
      command: "Check the stock of milk.",
      status: "running",
      created_at: "2026-11-01T10:14:14.159Z",
      finished_at: null,
      result: null,
      summary: null,
      reasoning: {
        mode: "off",
        status: "off",
      },
      timeline: [
        {
          at: "2026-11-01T10:14:14.159Z",
          type: "WORKFLOW_STARTED",
          agent: "manager",
          detail: "stock_check",
        },
      ],
      id: "wf_mvxoanimdb978e06",
      revision: 2,
      tasks: [
        {
          workflow_id: "wf_mvxoanimdb978e06",
          role: "inventory",
          agent_id: "nammaops-inventory",
          agent_name: "Inventory Agent",
          title: "Read stock and compare with reorder levels",
          status: "running",
          started_at: "2026-11-01T10:14:14.160Z",
          evidence: [],
          id: "nt_mvxoanio0a3fd6c4",
          revision: 1,
        },
      ],
    },
  },
  workflow: {
    workflow: {
      intent: {
        action: "stock_check",
        products: ["milk"],
      },
      command: "Check the stock of milk.",
      status: "completed",
      created_at: "2026-11-01T10:14:14.159Z",
      finished_at: "2026-11-01T10:14:14.198Z",
      result: {
        kind: "stock_check",
        rows: [
          {
            item_code: "MILK-500",
            item_name: "Toned Milk 500ml",
            uom: "Nos",
            available: 24,
            reorder_level: 40,
            status: "low",
            shortage: 16,
            recommended_qty: 60,
            warehouses: [
              {
                warehouse: "Stores - NK",
                qty: 18,
              },
            ],
          },
        ],
        low: [
          {
            item_code: "MILK-500",
            item_name: "Toned Milk 500ml",
            uom: "Nos",
            available: 24,
            reorder_level: 40,
            status: "low",
            shortage: 16,
            recommended_qty: 60,
            warehouses: [
              {
                warehouse: "Stores - NK",
                qty: 18,
              },
            ],
          },
        ],
        recommendations: [
          {
            item_code: "MILK-500",
            qty: 60,
            choice: {
              supplier: "Bengaluru Wholesale Traders",
              quotation: "SQ-FX-0001",
              rate: 24,
              available_qty: 200,
              lead_time_days: 1,
              on_time_rate: 0.95,
              suitable: true,
              not_suitable_because: [],
              missing: [],
            },
            considered: [
              {
                supplier: "Bengaluru Wholesale Traders",
                quotation: "SQ-FX-0001",
                rate: 24,
                available_qty: 200,
                lead_time_days: 1,
                on_time_rate: 0.95,
                suitable: true,
                not_suitable_because: [],
                missing: [],
              },
            ],
            criteria:
              "Suitable = can supply the quantity and quotation still valid; then lowest rate, shortest lead time, best on-time rate.",
            blocker: null,
          },
        ],
        recommendations_status: "available",
      },
      summary: "1 item(s) to buy tomorrow: Toned Milk 500ml (24 left, reorder at 40, buy 60).",
      reasoning: {
        mode: "off",
        status: "off",
      },
      timeline: [
        {
          at: "2026-11-01T10:14:14.159Z",
          type: "WORKFLOW_STARTED",
          agent: "manager",
          detail: "stock_check",
        },
      ],
      clarifications: null,
      id: "wf_mvxoanimdb978e06",
      revision: 8,
      tasks: [
        {
          workflow_id: "wf_mvxoanimdb978e06",
          role: "inventory",
          agent_id: "nammaops-inventory",
          agent_name: "Inventory Agent",
          title: "Read stock and compare with reorder levels",
          status: "completed",
          started_at: "2026-11-01T10:14:14.160Z",
          evidence: [
            {
              business_capability: "erp.items.list",
              invocation_id: "inv_mvxoaniq016de2087d",
            },
          ],
          summary: "1 product(s) checked; 1 at or below reorder level.",
          finished_at: "2026-11-01T10:14:14.180Z",
          id: "nt_mvxoanio0a3fd6c4",
          revision: 2,
        },
      ],
    },
  },
  events: {
    timeline: [
      {
        at: "2026-11-01T10:14:14.159Z",
        type: "WORKFLOW_STARTED",
        agent: "manager",
        detail: "stock_check",
      },
      {
        at: "2026-11-01T10:14:14.160Z",
        type: "INVENTORY_TASK_STARTED",
        agent: "inventory",
        detail: "Read stock and compare with reorder levels",
      },
    ],
    tasks: [
      {
        workflow_id: "wf_mvxoanimdb978e06",
        role: "inventory",
        agent_id: "nammaops-inventory",
        agent_name: "Inventory Agent",
        title: "Read stock and compare with reorder levels",
        status: "completed",
        started_at: "2026-11-01T10:14:14.160Z",
        evidence: [
          {
            business_capability: "erp.items.list",
            invocation_id: "inv_mvxoaniq016de2087d",
          },
        ],
        summary: "1 product(s) checked; 1 at or below reorder level.",
        finished_at: "2026-11-01T10:14:14.180Z",
        id: "nt_mvxoanio0a3fd6c4",
        revision: 2,
      },
      {
        workflow_id: "wf_mvxoanimdb978e06",
        role: "procurement",
        agent_id: "nammaops-procurement",
        agent_name: "Procurement Agent",
        title: "Compare suppliers for low-stock products",
        status: "completed",
        started_at: "2026-11-01T10:14:14.182Z",
        evidence: [
          {
            business_capability: "erp.suppliers.list",
            invocation_id: "inv_mvxoanjbd6224b1a85",
          },
        ],
        summary: "1 of 1 item(s) have a suitable supplier.",
        finished_at: "2026-11-01T10:14:14.193Z",
        id: "nt_mvxoanja9b178bb5",
        revision: 2,
      },
    ],
  },
  dashboard: {
    workforce: {
      agents: {
        manager: {
          agent_id: "nammaops-manager",
          name: "Manager Agent",
          specialization_id: "spec_kirana-store-operations-coordinator_945497",
          seat_id: "analyze",
          business_capabilities: [],
          granted: [],
        },
        inventory: {
          agent_id: "nammaops-inventory",
          name: "Inventory Agent",
          specialization_id: "spec_kirana-stock-monitoring_e5173f",
          seat_id: "plan",
          business_capabilities: ["erp.items.list"],
          granted: ["mcp.erp-fixture.list_items"],
        },
        sales: {
          agent_id: "nammaops-sales",
          name: "Sales Agent",
          specialization_id: "spec_kirana-sales-analysis_c02f8d",
          seat_id: "review",
          business_capabilities: ["erp.sales_invoices.list"],
          granted: ["mcp.erp-fixture.list_sales_invoices"],
        },
        procurement: {
          agent_id: "nammaops-procurement",
          name: "Procurement Agent",
          specialization_id: "spec_kirana-supplier-purchasing_9f4836",
          seat_id: "seat-0",
          business_capabilities: ["erp.suppliers.list"],
          granted: ["mcp.erp-fixture.list_suppliers"],
        },
        finance: {
          agent_id: "nammaops-finance",
          name: "Finance Agent",
          specialization_id: "spec_kirana-financial-reporting_0307e2",
          seat_id: "seat-1",
          business_capabilities: ["erp.pnl"],
          granted: ["mcp.erp-fixture.get_profit_and_loss"],
        },
      },
      principals: [
        {
          id: "nammaops-po-submit",
          granted: ["mcp.erp-fixture.get_purchase_order"],
        },
      ],
      server_id: "erp-fixture",
      at: "2026-11-01T08:41:38.420Z",
      id: "current",
      revision: 2,
    },
    binding: [
      {
        business_capability: "erp.items.list",
        tool: "list_items",
        capability_id: "mcp.erp-fixture.list_items",
        state: "registered",
        availability: "available",
        risk: "READ",
      },
      {
        business_capability: "erp.stock.balance",
        tool: "get_stock_balance",
        capability_id: "mcp.erp-fixture.get_stock_balance",
        state: "registered",
        availability: "available",
        risk: "READ",
      },
    ],
    latest: {
      demand_forecast: {
        intent: {
          action: "demand_forecast",
          products: [],
        },
        command: "What will sell next week and what should I buy?",
        status: "completed",
        created_at: "2026-11-01T08:46:43.118Z",
        finished_at: "2026-11-01T08:46:43.269Z",
        result: {
          kind: "demand_forecast",
          label: "Historical-demand forecast (not a market prediction)",
          as_of: "2026-11-01",
          history_window: {
            from: "2026-08-03",
            to: "2026-10-31",
          },
          items: [
            {
              item_code: "MILK-500",
              item_name: "Toned Milk 500ml",
              history: {
                from: "2026-08-03",
                to: "2026-10-31",
                observed_days: 88,
                censored_stockout_days: ["2026-08-24"],
                units_sold: 3471,
              },
              evidence: {
                sales_documents: ["HIST-POS-2026-08-03"],
                incoming_documents: [],
              },
              current_stock: 24,
              reserved_stock: 0,
              incoming_stock: 0,
              supplier_lead_time_days: 1,
              status: "ok",
              average_daily_demand: 39.44,
              method: {
                id: "weekday",
                label: "30-day average with weekday pattern",
                sigma: 11.94,
                z: 1.65,
              },
              backtest: {
                status: "ok",
                window: {
                  from: "2026-10-18",
                  to: "2026-10-31",
                  days: 14,
                },
                actual_units: 518,
                methods: {
                  ma7: {
                    mae: 9.98,
                    wape: 0.27,
                  },
                  ma30: {
                    mae: 9.98,
                    wape: 0.27,
                  },
                  weighted: {
                    mae: 11.73,
                    wape: 0.317,
                  },
                  weekday: {
                    mae: 8.59,
                    wape: 0.232,
                  },
                },
              },
              forecast: {
                next_7_days: 272.5,
                next_30_days: 1175.3,
              },
              recommendation: {
                status: "ok",
                lead_time_demand: 48.2,
                safety_stock: 19.7,
                suggested_qty: 44,
                days_of_cover: 0.6,
                stockout_risk: "high",
                formula:
                  "max(0, lead-time demand + safety stock - (available - reserved) - incoming)",
              },
              limitations: [
                "Historical-demand forecast from this store's own sales; it does not see events, weather, prices or competitors.",
              ],
              incoming: [],
              supplier_comparison: {
                item_code: "MILK-500",
                qty: 44,
                choice: {
                  supplier: "Bengaluru Wholesale Traders",
                  quotation: "SQ-FX-0001",
                  rate: 24,
                  available_qty: 200,
                  lead_time_days: 1,
                  on_time_rate: 0.95,
                  suitable: true,
                  not_suitable_because: [],
                  missing: [],
                },
                considered: [
                  {
                    supplier: "Bengaluru Wholesale Traders",
                    quotation: "SQ-FX-0001",
                    rate: 24,
                    available_qty: 200,
                    lead_time_days: 1,
                    on_time_rate: 0.95,
                    suitable: true,
                    not_suitable_because: [],
                    missing: [],
                  },
                ],
                criteria:
                  "Suitable = can supply the quantity and quotation still valid; then lowest rate, shortest lead time, best on-time rate.",
                blocker: null,
              },
            },
          ],
          supply_status: "available",
        },
        summary:
          "Historical-demand forecast for the next 7 days: Toned Milk 500ml ~272.5, Sunflower Oil 1L ~46.7, Sugar 1kg ~42.2. Suggested purchases: Toned Milk 500ml 44 (high risk); Sona Masoori Rice 5kg 3 (medium risk). Not enough history to forecast: Ghee 200ml.",
        reasoning: {
          mode: "off",
          status: "off",
        },
        timeline: [
          {
            at: "2026-11-01T08:46:43.118Z",
            type: "WORKFLOW_STARTED",
            agent: "manager",
            detail: "demand_forecast",
          },
        ],
        clarifications: null,
        id: "wf_mvxl63se55bf7fc5",
        revision: 10,
        tasks: [
          {
            workflow_id: "wf_mvxl63se55bf7fc5",
            role: "sales",
            agent_id: "nammaops-sales",
            agent_name: "Sales Agent",
            title: "Read sales history 2026-08-03 to 2026-10-31",
            status: "completed",
            started_at: "2026-11-01T08:46:43.119Z",
            evidence: [
              {
                business_capability: "erp.sales.history",
                invocation_id: "inv_mvxl63sga652760d4d",
              },
            ],
            summary: "526 sales line(s) from 90 submitted invoice(s).",
            finished_at: "2026-11-01T08:46:43.131Z",
            id: "nt_mvxl63sffd0f5138",
            revision: 2,
          },
        ],
      },
      daily_report: {
        intent: {
          action: "daily_report",
          date: "2026-11-01",
        },
        command:
          "Tell me how much business I did today, what sold the most and how much profit I made.",
        status: "completed",
        created_at: "2026-11-01T08:46:41.104Z",
        finished_at: "2026-11-01T08:46:41.178Z",
        result: {
          kind: "daily_report",
          period: {
            from_date: "2026-11-01",
            to_date: "2026-11-01",
          },
          total_sales: 3186,
          transaction_count: 3,
          top_products: [
            {
              item_code: "RICE-5KG",
              qty: 4,
              amount: 1600,
              item_name: "Sona Masoori Rice 5kg",
            },
          ],
          invoice_refs: ["SINV-FX-0001"],
          profit: {
            status: "verified",
            net_profit: 484,
            income: 3186,
            expense: 2702,
            source: "Profit and Loss report",
          },
          warnings: [],
          data_status: {
            sales: "available",
            profit: "verified",
          },
          sources: {
            invoices: ["SINV-FX-0001"],
            profit: "Profit and Loss report",
          },
        },
        summary:
          "2026-11-01: sales 3186 across 3 transaction(s); top sellers Sona Masoori Rice 5kg, Toned Milk 500ml, Sunflower Oil 1L; net profit 484 from the posted P&L.",
        reasoning: {
          mode: "off",
          status: "off",
        },
        timeline: [
          {
            at: "2026-11-01T08:46:41.104Z",
            type: "WORKFLOW_STARTED",
            agent: "manager",
            detail: "daily_report",
          },
        ],
        clarifications: null,
        id: "wf_mvxl628g961fcb5e",
        revision: 8,
        tasks: [
          {
            workflow_id: "wf_mvxl628g961fcb5e",
            role: "sales",
            agent_id: "nammaops-sales",
            agent_name: "Sales Agent",
            title: "Read sales for 2026-11-01",
            status: "completed",
            started_at: "2026-11-01T08:46:41.108Z",
            evidence: [
              {
                business_capability: "erp.sales_invoices.list",
                invocation_id: "inv_mvxl628l3dba2333b3",
              },
            ],
            summary: "3 transaction(s), total 3186.",
            finished_at: "2026-11-01T08:46:41.167Z",
            id: "nt_mvxl628j93e32560",
            revision: 2,
          },
        ],
      },
      prepare_reorder: {
        intent: {
          action: "prepare_reorder",
          products: [],
        },
        command:
          "Prepare an order for the products that are running low. Choose the cheapest suitable supplier.",
        status: "completed",
        created_at: "2026-11-01T08:46:22.968Z",
        finished_at: "2026-11-01T08:46:38.883Z",
        result: {
          kind: "prepare_reorder",
          low: [
            {
              item_code: "MILK-500",
              item_name: "Toned Milk 500ml",
              uom: "Nos",
              available: 24,
              reorder_level: 40,
              status: "low",
              shortage: 16,
              recommended_qty: 60,
              warehouses: [
                {
                  warehouse: "Stores - NK",
                  qty: 18,
                },
              ],
            },
          ],
          rankings: [
            {
              item_code: "MILK-500",
              qty: 60,
              choice: {
                supplier: "Bengaluru Wholesale Traders",
                quotation: "SQ-FX-0001",
                rate: 24,
                available_qty: 200,
                lead_time_days: 1,
                on_time_rate: 0.95,
                suitable: true,
                not_suitable_because: [],
                missing: [],
              },
              considered: [
                {
                  supplier: "Bengaluru Wholesale Traders",
                  quotation: "SQ-FX-0001",
                  rate: 24,
                  available_qty: 200,
                  lead_time_days: 1,
                  on_time_rate: 0.95,
                  suitable: true,
                  not_suitable_because: [],
                  missing: [],
                },
              ],
              criteria:
                "Suitable = can supply the quantity and quotation still valid; then lowest rate, shortest lead time, best on-time rate.",
              blocker: null,
            },
          ],
          orders: [
            {
              name: "PUR-ORD-FX-0003",
              supplier: "Bengaluru Wholesale Traders",
              schedule_date: "2026-11-02",
              items: [
                {
                  item_code: "MILK-500",
                  qty: 60,
                  rate: 24,
                  amount: 1440,
                },
              ],
              docstatus: 0,
              status: "Draft",
              grand_total: 1440,
            },
          ],
          unplaced: [],
          approvals: ["own_mvxl5odoc6ad6d45e9"],
        },
        summary:
          "2 draft purchase order(s) ready for your approval: PUR-ORD-FX-0003 from Bengaluru Wholesale Traders, total 1440; PUR-ORD-FX-0004 from Mysuru Agro Supplies, total 3312.",
        reasoning: {
          mode: "off",
          status: "off",
        },
        timeline: [
          {
            at: "2026-11-01T08:46:22.968Z",
            type: "WORKFLOW_STARTED",
            agent: "manager",
            detail: "prepare_reorder",
          },
        ],
        clarifications: null,
        id: "wf_mvxl5o8o2c9aaff2",
        revision: 14,
        tasks: [
          {
            workflow_id: "wf_mvxl5o8o2c9aaff2",
            role: "inventory",
            agent_id: "nammaops-inventory",
            agent_name: "Inventory Agent",
            title: "Read stock and compare with reorder levels",
            status: "completed",
            started_at: "2026-11-01T08:46:22.969Z",
            evidence: [
              {
                business_capability: "erp.items.list",
                invocation_id: "inv_mvxl5o8rbabd3a3478",
              },
            ],
            summary: "7 product(s) checked; 2 at or below reorder level.",
            finished_at: "2026-11-01T08:46:22.990Z",
            id: "nt_mvxl5o8p86e98c54",
            revision: 2,
          },
        ],
      },
      stock_check: {
        intent: {
          action: "stock_check",
          products: ["milk"],
        },
        command:
          "Check the stock of milk, rice and cooking oil. Tell me what we need to buy tomorrow.",
        status: "completed",
        created_at: "2026-11-01T08:46:19.812Z",
        finished_at: "2026-11-01T08:46:19.903Z",
        result: {
          kind: "stock_check",
          rows: [
            {
              item_code: "MILK-500",
              item_name: "Toned Milk 500ml",
              uom: "Nos",
              available: 24,
              reorder_level: 40,
              status: "low",
              shortage: 16,
              recommended_qty: 60,
              warehouses: [
                {
                  warehouse: "Stores - NK",
                  qty: 18,
                },
              ],
            },
          ],
          low: [
            {
              item_code: "MILK-500",
              item_name: "Toned Milk 500ml",
              uom: "Nos",
              available: 24,
              reorder_level: 40,
              status: "low",
              shortage: 16,
              recommended_qty: 60,
              warehouses: [
                {
                  warehouse: "Stores - NK",
                  qty: 18,
                },
              ],
            },
          ],
          recommendations: [
            {
              item_code: "MILK-500",
              qty: 60,
              choice: {
                supplier: "Bengaluru Wholesale Traders",
                quotation: "SQ-FX-0001",
                rate: 24,
                available_qty: 200,
                lead_time_days: 1,
                on_time_rate: 0.95,
                suitable: true,
                not_suitable_because: [],
                missing: [],
              },
              considered: [
                {
                  supplier: "Bengaluru Wholesale Traders",
                  quotation: "SQ-FX-0001",
                  rate: 24,
                  available_qty: 200,
                  lead_time_days: 1,
                  on_time_rate: 0.95,
                  suitable: true,
                  not_suitable_because: [],
                  missing: [],
                },
              ],
              criteria:
                "Suitable = can supply the quantity and quotation still valid; then lowest rate, shortest lead time, best on-time rate.",
              blocker: null,
            },
          ],
          recommendations_status: "available",
        },
        summary:
          "2 item(s) to buy tomorrow: Toned Milk 500ml (24 left, reorder at 40, buy 60); Sunflower Oil 1L (9 left, reorder at 15, buy 24).",
        reasoning: {
          mode: "off",
          status: "off",
        },
        timeline: [
          {
            at: "2026-11-01T08:46:19.812Z",
            type: "WORKFLOW_STARTED",
            agent: "manager",
            detail: "stock_check",
          },
        ],
        clarifications: null,
        id: "wf_mvxl5lszf24663a6",
        revision: 8,
        tasks: [
          {
            workflow_id: "wf_mvxl5lszf24663a6",
            role: "inventory",
            agent_id: "nammaops-inventory",
            agent_name: "Inventory Agent",
            title: "Read stock and compare with reorder levels",
            status: "completed",
            started_at: "2026-11-01T08:46:19.813Z",
            evidence: [
              {
                business_capability: "erp.items.list",
                invocation_id: "inv_mvxl5lt323c4829a7a",
              },
            ],
            summary: "3 product(s) checked; 2 at or below reorder level.",
            finished_at: "2026-11-01T08:46:19.873Z",
            id: "nt_mvxl5lt13d75975f",
            revision: 2,
          },
        ],
      },
    },
    approvals: [
      {
        workflow_id: "wf_mvxl5o8o2c9aaff2",
        action: "submit_purchase_order",
        erp_document_type: "Purchase Order",
        erp_document_name: "PUR-ORD-FX-0003",
        supplier: "Bengaluru Wholesale Traders",
        items: [
          {
            item_code: "MILK-500",
            qty: 60,
            rate: 24,
          },
        ],
        total: 1440,
        document_state: "draft",
        fingerprint: "e51615626973b053a4b3986d61553288146945814a5f07a5c13bfec694b27cc7",
        idempotency_key: "own_mvxl5odoc6ad6d45e9",
        status: "rejected",
        requested_at: "2026-11-01T08:46:23.149Z",
        expires_at: "2026-11-01T09:16:23.149Z",
        history: [
          {
            event: "rejected",
            at: "2026-11-01T08:46:34.350Z",
          },
        ],
        decided_at: "2026-11-01T08:46:34.350Z",
        id: "own_mvxl5odoc6ad6d45e9",
        revision: 2,
      },
      {
        workflow_id: "wf_mvxl5o8o2c9aaff2",
        action: "submit_purchase_order",
        erp_document_type: "Purchase Order",
        erp_document_name: "PUR-ORD-FX-0004",
        supplier: "Mysuru Agro Supplies",
        items: [
          {
            item_code: "OIL-SUN-1L",
            qty: 24,
            rate: 138,
          },
        ],
        total: 3312,
        document_state: "submitted",
        fingerprint: "02324a524375ee630dd327f1c19741e8b3395f61d711e18b61bea704ff140433",
        idempotency_key: "own_mvxl5odq5590647b90",
        status: "submitted",
        requested_at: "2026-11-01T08:46:23.150Z",
        expires_at: "2026-11-01T09:16:23.150Z",
        history: [
          {
            event: "approved",
            at: "2026-11-01T08:46:38.816Z",
          },
        ],
        decided_at: "2026-11-01T08:46:38.816Z",
        approved_by: "owner",
        erp_response: {
          submit: "inv_mvxl60gw791f601009",
          confirm: "inv_mvxl60h3a89940ca3e",
          docstatus: 1,
        },
        id: "own_mvxl5odq5590647b90",
        revision: 3,
      },
    ],
    data_source: "fixture (synthetic, not real ERPNext data)",
  },
  errors: {
    "e-origin": {
      error: "Same-origin request required",
    },
    "e-json": {
      error: "Invalid JSON body",
    },
    "e-unsup": {
      error:
        "That operation is not supported. NammaOps can check stock, forecast demand, compare supplier quotations, prepare a reorder for approval, or report a day's business.",
    },
    "e-intent": {
      error: "Invalid intent.",
    },
    "e-empty": {
      error: "Command must be 1-500 characters.",
    },
    "e-404": {
      error: "Workflow not found.",
    },
    "e-path": {
      error: "Unsupported NammaOps endpoint or method.",
    },
    "e-appr": {
      error: "Owner PIN is incorrect.",
    },
  },
};
