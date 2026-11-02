#!/usr/bin/env node
/**
 * Phase G1: start the pinned @hvgllc/hvgerp-mcp over stdio, run listTools(), and write what the
 * server actually reports. Read-only: this script never calls a tool. Credentials come from
 * .env.local (ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET), go only to the child process, and
 * are never printed.
 *
 *   node scripts/erpnext-mcp-discover.mjs [--categories=sales,inventory,purchasing,accounting] [--out=file.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const PINNED_VERSION = "3.7.0";
export const SERVER_ENTRY = resolve("node_modules/@hvgllc/hvgerp-mcp/hvgerp-mcp.mjs");

/** ERPNEXT_* values from .env.local (process.env wins). Throws without printing any value. */
export function erpnextEnv(file = ".env.local") {
  const found = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^(ERPNEXT_(?:URL|API_KEY|API_SECRET))=(.*)$/.exec(line.trim());
      if (match) found[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* fall back to process.env */
  }
  const env = {
    ERPNEXT_URL: process.env.ERPNEXT_URL ?? found.ERPNEXT_URL,
    ERPNEXT_API_KEY: process.env.ERPNEXT_API_KEY ?? found.ERPNEXT_API_KEY,
    ERPNEXT_API_SECRET: process.env.ERPNEXT_API_SECRET ?? found.ERPNEXT_API_SECRET,
  };
  const missing = Object.keys(env).filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")} (.env.local or environment).`);
  if (!/^https?:\/\//.test(env.ERPNEXT_URL)) env.ERPNEXT_URL = `https://${env.ERPNEXT_URL}`;
  env.ERPNEXT_URL = env.ERPNEXT_URL.replace(/\/$/, "");
  return env;
}

export function connectHvgerp(categories) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY, ...(categories ? [`--categories=${categories}`] : [])],
    env: erpnextEnv(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "nammaops-g1", version: "1.0.0" });
  return { client, transport, stderr, connect: () => client.connect(transport) };
}

const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=")[1];

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const pkg = JSON.parse(readFileSync("node_modules/@hvgllc/hvgerp-mcp/package.json", "utf8"));
  if (pkg.version !== PINNED_VERSION)
    throw new Error(
      `Installed hvgerp-mcp is ${pkg.version}, expected the pinned ${PINNED_VERSION}.`,
    );
  const categories = arg("categories") ?? "sales,inventory,purchasing,accounting";
  const { client, stderr, connect } = connectHvgerp(categories);
  await connect();
  const listed = await client.listTools();
  const server = client.getServerVersion();
  const tools = listed.tools.map((tool) => ({
    name: tool.name,
    title: tool.title ?? null,
    description: String(tool.description ?? "").slice(0, 300),
    annotations: tool.annotations ?? null,
    required: tool.inputSchema?.required ?? [],
    properties: Object.fromEntries(
      Object.entries(tool.inputSchema?.properties ?? {}).map(([key, value]) => [
        key,
        {
          type: value.type ?? null,
          enum: value.enum,
          description: String(value.description ?? "").slice(0, 160),
        },
      ]),
    ),
    hasOutputSchema: !!tool.outputSchema,
  }));
  const out = arg("out") ?? "config/nammaops/hvgerp-tools.discovered.json";
  writeFileSync(
    out,
    JSON.stringify(
      {
        _note:
          "Discovered with listTools() from the real server. No credentials. Read-only discovery; no tool was called.",
        package: { name: pkg.name, version: pkg.version },
        server,
        categories,
        count: tools.length,
        tools,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      server,
      categories,
      count: tools.length,
      wrote: out,
      stderrLines: stderr.join("").split("\n").filter(Boolean).length,
    }),
  );
  await client.close();
}
