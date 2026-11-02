import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isLoopbackHost } from "../server-security.mjs";

export const SERVER_NAMESPACE = "mcp.server";
export const HEALTH_NAMESPACE = "mcp.server-health";
export const TRANSPORTS = ["stdio", "streamable_http"];
const ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
const SECRET_REF = /^[A-Z][A-Z0-9_]{2,63}$/;
const FIELDS = new Set([
  "server_id",
  "name",
  "description",
  "transport",
  "enabled",
  "connection",
  "authentication_ref",
  "connect_timeout_ms",
  "request_timeout_ms",
]);
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 200;

const omit = (value, ...keys) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const ms = (value, fallback, max) =>
  value === undefined
    ? fallback
    : Number.isInteger(value) && value >= 100 && value <= max
      ? value
      : NaN;

/**
 * Administrator-reviewed allowlists. A stdio server may run only a command line listed exactly in
 * AGENT_TOWN_MCP_STDIO_ALLOWLIST; an HTTP server must be loopback or an https origin listed in
 * AGENT_TOWN_MCP_HTTP_ALLOWLIST. REST input can never widen these.
 * @param {Record<string, string | undefined>} env
 */
export function loadMcpPolicy(env = process.env) {
  const parse = (key) => {
    if (!env[key]) return [];
    try {
      const value = JSON.parse(env[key]);
      if (!Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error(`Invalid ${key} JSON.`);
    }
  };
  const stdio = parse("AGENT_TOWN_MCP_STDIO_ALLOWLIST");
  if (
    stdio.some(
      (row) =>
        !row ||
        !text(row.command, 200) ||
        !Array.isArray(row.args) ||
        row.args.some((arg) => typeof arg !== "string"),
    )
  )
    throw new Error("Invalid AGENT_TOWN_MCP_STDIO_ALLOWLIST entry.");
  const http = parse("AGENT_TOWN_MCP_HTTP_ALLOWLIST");
  if (http.some((origin) => typeof origin !== "string" || !origin.startsWith("https://")))
    throw new Error("AGENT_TOWN_MCP_HTTP_ALLOWLIST accepts https origins only.");
  return { stdio, http, cwd: resolve(env.AGENT_TOWN_MCP_CWD ?? process.cwd()) };
}

/** Validates a server configuration against the reviewed policy before anything connects. */
export function validateServerConfig(input, policy, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail(400, "Server configuration must be an object.");
  for (const key of Object.keys(input))
    if (!FIELDS.has(key)) throw fail(400, `Unsupported server field: ${key}`);
  if (!partial && !ID.test(String(input.server_id)))
    throw fail(400, "server_id must match [a-z0-9-]{2,48}.");
  if ((!partial || input.name !== undefined) && !text(input.name, 80))
    throw fail(400, "name must be 1-80 characters.");
  if (input.description !== undefined && typeof input.description !== "string")
    throw fail(400, "description must be a string.");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw fail(400, "enabled must be a boolean.");
  if (
    input.authentication_ref !== undefined &&
    input.authentication_ref !== null &&
    !SECRET_REF.test(String(input.authentication_ref))
  )
    throw fail(400, "authentication_ref must name an environment variable, not hold a secret.");
  if (Number.isNaN(ms(input.connect_timeout_ms, 10000, 60000)))
    throw fail(400, "connect_timeout_ms must be 100-60000.");
  if (Number.isNaN(ms(input.request_timeout_ms, 30000, 120000)))
    throw fail(400, "request_timeout_ms must be 100-120000.");
  if (partial && input.transport === undefined && input.connection === undefined) return;
  if (!TRANSPORTS.includes(input.transport))
    throw fail(400, `transport must be one of ${TRANSPORTS.join(", ")}.`);
  const connection = input.connection;
  if (!connection || typeof connection !== "object") throw fail(400, "connection is required.");
  if (input.transport === "stdio") {
    if (Object.keys(connection).some((key) => !["command", "args"].includes(key)))
      throw fail(400, "stdio connection accepts command and args only.");
    const args = connection.args ?? [];
    const approved = policy.stdio.some(
      (row) =>
        row.command === connection.command &&
        row.args.length === args.length &&
        row.args.every((arg, index) => arg === args[index]),
    );
    if (!approved)
      throw fail(403, "This stdio command line is not in the administrator-approved allowlist.");
    return;
  }
  if (Object.keys(connection).some((key) => key !== "url"))
    throw fail(400, "streamable_http connection accepts url only.");
  let url;
  try {
    url = new URL(connection.url);
  } catch {
    throw fail(400, "connection.url is not a valid URL.");
  }
  if (url.username || url.password) throw fail(400, "Credentials are not allowed in the URL.");
  const loopback = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!loopback && !(url.protocol === "https:" && policy.http.includes(url.origin)))
    throw fail(403, "Remote MCP servers must be https origins in the administrator allowlist.");
}

const publicView = (record, health) => {
  if (!record) return null;
  const { id, revision, ...rest } = record;
  return {
    server_id: id,
    ...rest,
    version: revision,
    authentication: rest.authentication_ref ? { ref: rest.authentication_ref } : null,
    health: health
      ? {
          status: health.status,
          last_error: health.last_error ?? null,
          last_connected_at: health.last_connected_at ?? null,
          last_discovery_at: health.last_discovery_at ?? null,
        }
      : { status: "never_connected" },
  };
};

/** Builds an SDK transport. The secret is resolved from its env reference only at connect time. */
export function defaultTransportFactory(config, { env, policy }) {
  const secret = config.authentication_ref ? env[config.authentication_ref] : undefined;
  if (config.authentication_ref && !secret)
    throw fail(503, `Environment variable ${config.authentication_ref} is not set.`);
  if (config.transport === "stdio")
    return new StdioClientTransport({
      command: config.connection.command,
      args: config.connection.args ?? [],
      cwd: policy.cwd,
      env: {
        ...getDefaultEnvironment(),
        ...(secret ? { [config.authentication_ref]: secret } : {}),
      },
      stderr: "ignore",
    });
  return new StreamableHTTPClientTransport(new URL(config.connection.url), {
    requestInit: secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined,
  });
}

/**
 * Registered servers and their live connections. One client per server is reused; connection
 * attempts are retried a bounded number of times, tool calls never are.
 */
export class McpServers {
  /** @param {any} db @param {{env?: Record<string,string|undefined>, policy?: any,
   *  transportFactory?: (config: any, ctx: any) => any, now?: () => Date}} [options] */
  constructor(
    db,
    { env = process.env, policy, transportFactory = defaultTransportFactory, now } = {},
  ) {
    this.db = db;
    this.env = env;
    this.policy = policy ?? loadMcpPolicy(env);
    this.transportFactory = transportFactory;
    this.now = now ?? (() => new Date());
    this.connections = new Map();
    this.pending = new Map();
  }

  record(id) {
    return this.db.record(SERVER_NAMESPACE, id);
  }

  health(id) {
    return this.db.record(HEALTH_NAMESPACE, id);
  }

  setHealth(id, patch) {
    const previous = this.health(id);
    const revision = previous?.revision;
    const rest = omit(previous, "id", "revision");
    return this.db.saveRecord(HEALTH_NAMESPACE, id, { ...rest, ...patch }, revision ?? 0);
  }

  get(id) {
    return publicView(this.record(id), this.health(id));
  }

  list() {
    return this.db
      .records(SERVER_NAMESPACE)
      .map((record) => publicView(record, this.health(record.id)));
  }

  register(input) {
    validateServerConfig(input, this.policy);
    if (this.record(input.server_id)) throw fail(409, "server_id already exists.");
    const { server_id: id, ...rest } = input;
    this.db.saveRecord(
      SERVER_NAMESPACE,
      id,
      {
        enabled: true,
        authentication_ref: null,
        connect_timeout_ms: 10000,
        request_timeout_ms: 30000,
        description: "",
        ...rest,
        createdAt: this.now().toISOString(),
      },
      0,
    );
    return this.get(id);
  }

  async update(id, patch) {
    const current = this.record(id);
    if (!current) throw fail(404, "MCP server not found.");
    if (patch?.server_id !== undefined) throw fail(400, "server_id cannot change.");
    const { revision, createdAt } = current;
    const value = omit(current, "id", "revision", "createdAt", "updatedAt");
    const next = { ...value, ...patch };
    validateServerConfig({ server_id: id, ...next }, this.policy);
    // A changed connection or credential reference must not reuse the old session.
    await this.disconnect(id);
    this.db.saveRecord(
      SERVER_NAMESPACE,
      id,
      { ...next, createdAt, updatedAt: this.now().toISOString() },
      revision,
    );
    return this.get(id);
  }

  /** Returns a connected client, connecting with bounded retries if needed. */
  async client(id) {
    const live = this.connections.get(id);
    if (live) return live.client;
    if (this.pending.has(id)) return this.pending.get(id);
    const attempt = this.open(id).finally(() => this.pending.delete(id));
    this.pending.set(id, attempt);
    return attempt;
  }

  async open(id) {
    const config = this.record(id);
    if (!config) throw fail(404, "MCP server not found.");
    if (!config.enabled) throw fail(409, "MCP server is disabled.");
    // Re-check the stored config against today's policy: a removed allowlist entry stops it.
    const stored = omit(config, "id", "revision", "createdAt", "updatedAt");
    validateServerConfig({ server_id: id, ...stored }, this.policy);
    let lastError;
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
      let transport;
      try {
        transport = this.transportFactory(config, { env: this.env, policy: this.policy });
        const client = new Client({ name: "agent-town", version: "1.0.0" });
        await client.connect(transport, { timeout: config.connect_timeout_ms });
        transport.onclose = () => {
          if (this.connections.get(id)?.client !== client) return;
          this.connections.delete(id);
          try {
            this.setHealth(id, { status: "disconnected", last_error: "Connection closed." });
          } catch {
            /* Storage already closed during shutdown. */
          }
        };
        this.connections.set(id, { client, transport });
        this.setHealth(id, {
          status: "connected",
          last_error: null,
          last_connected_at: this.now().toISOString(),
        });
        return client;
      } catch (error) {
        lastError = error;
        await transport?.close?.().catch(() => {});
        if (error?.status) break;
        if (attempt < RECONNECT_ATTEMPTS)
          await new Promise((done) => setTimeout(done, RECONNECT_DELAY_MS * attempt));
      }
    }
    const message = `Connection failed after ${RECONNECT_ATTEMPTS} attempt(s): ${lastError?.message ?? "unknown error"}`;
    this.setHealth(id, { status: "unreachable", last_error: message.slice(0, 300) });
    throw fail(lastError?.status === 403 ? 403 : 503, message);
  }

  async disconnect(id) {
    const live = this.connections.get(id);
    this.connections.delete(id);
    if (live) {
      await live.client.close().catch(() => {});
      if (this.record(id)) this.setHealth(id, { status: "disconnected", last_error: null });
    }
    return this.get(id);
  }

  async close() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}
