#!/usr/bin/env node
/**
 * TEST FIXTURE. A deterministic MCP server with four stock tools and in-memory data, used by tests
 * and the Phase C demo. It is not an inventory integration and holds no real records.
 *
 * Run as a stdio MCP server: `node lib/mcp/fixture-stock-server.mjs`.
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const key = {
  sku: { type: "string", pattern: "^[A-Z0-9-]{1,32}$" },
  warehouse: { type: "string", pattern: "^[A-Z0-9-]{1,32}$" },
};
export const FIXTURE_TOOLS = [
  {
    name: "get_stock_balance",
    description: "Fixture: read the stock balance for a SKU in a warehouse.",
    inputSchema: {
      type: "object",
      properties: key,
      required: ["sku", "warehouse"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_stock_ledger",
    description: "Fixture: read the stock movements recorded for a SKU.",
    inputSchema: {
      type: "object",
      properties: { sku: key.sku },
      required: ["sku"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "update_stock_quantity",
    description: "Fixture: set the stock quantity for a SKU in a warehouse.",
    inputSchema: {
      type: "object",
      properties: { ...key, quantity: { type: "integer", minimum: 0, maximum: 100000 } },
      required: ["sku", "warehouse", "quantity"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "delete_stock_record",
    description: "Fixture: delete the stock record for a SKU in a warehouse.",
    inputSchema: {
      type: "object",
      properties: key,
      required: ["sku", "warehouse"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
];

/** A fresh fixture with its own in-memory data. */
export function createFixtureStockServer() {
  const stock = new Map([
    ["SKU-17|BIN-A", 12],
    ["SKU-17|BIN-B", 3],
    ["SKU-42|BIN-A", 40],
  ]);
  const ledger = [
    { sku: "SKU-17", warehouse: "BIN-A", change: 15, reason: "receipt", at: "2026-10-01" },
    { sku: "SKU-17", warehouse: "BIN-A", change: -3, reason: "sale", at: "2026-10-02" },
    { sku: "SKU-17", warehouse: "BIN-B", change: 3, reason: "transfer", at: "2026-10-03" },
  ];
  const server = new Server(
    { name: "agent-town-fixture-stock", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FIXTURE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const id = `${args.sku}|${args.warehouse}`;
    const reply = (value) => ({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    });
    if (name === "get_stock_balance") {
      if (!stock.has(id))
        return { isError: true, content: [{ type: "text", text: "Unknown SKU or warehouse." }] };
      return reply({ sku: args.sku, warehouse: args.warehouse, quantity: stock.get(id) });
    }
    if (name === "get_stock_ledger")
      return reply({ sku: args.sku, entries: ledger.filter((row) => row.sku === args.sku) });
    if (name === "update_stock_quantity") {
      const before = stock.get(id) ?? 0;
      stock.set(id, args.quantity);
      return reply({ sku: args.sku, warehouse: args.warehouse, before, after: args.quantity });
    }
    if (name === "delete_stock_record")
      return reply({ sku: args.sku, warehouse: args.warehouse, deleted: stock.delete(id) });
    return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] };
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await createFixtureStockServer().connect(new StdioServerTransport());
