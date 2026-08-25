import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { createHash } from "node:crypto";
import { DEFAULT_PAPERCLIP_API_URL } from "./config.js";
import {
  fetchWithTimeout,
  GATEWAY_CALL_TIMEOUT_MS,
  GATEWAY_REVOKE_TIMEOUT_MS,
  GATEWAY_SETUP_TIMEOUT_MS,
} from "./http.js";

export interface ToolGatewaySession {
  sessionId: string;
  token: string;
  toolsUrl: string;
  callUrl: string;
}

export interface StaplerTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface GatewayTool {
  name: string;
  description?: string;
  title?: string;
  displayName?: string;
  inputSchema?: Record<string, unknown>;
  parametersSchema?: Record<string, unknown>;
}

/** OpenAI-compatible function names are capped at 64 characters. */
export const MAX_GATEWAY_TOOL_NAME_LEN = 64;

function shortToolHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function sanitizeToolChars(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Build a unique ≤64-char tool name for the LLM.
 *
 * Blind prefix truncation collapses long Composio names
 * (`…COMPOSIO_SEARCH_TOOLS` vs `…COMPOSIO_WAIT_FOR_CONNECTIONS`) into one
 * safe id, so discovery calls get routed to WAIT_FOR_CONNECTIONS without
 * `toolkits`. Prefer the meaningful tail, then disambiguate with a hash.
 */
export function allocateSafeToolName(
  original: string,
  used: Set<string>,
): string {
  const trimmed = original.trim();
  if (!trimmed) {
    return "";
  }

  const sanitized = sanitizeToolChars(trimmed);
  if (!sanitized) {
    return "";
  }

  const fit = (value: string): string => {
    if (value.length <= MAX_GATEWAY_TOOL_NAME_LEN) {
      return value;
    }

    return value.slice(value.length - MAX_GATEWAY_TOOL_NAME_LEN);
  };

  let candidate = fit(sanitized);

  if (candidate && !used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  const hash = shortToolHash(trimmed);
  const suffix = `_${hash}`;
  const budget = MAX_GATEWAY_TOOL_NAME_LEN - suffix.length;
  const base =
    sanitized.length <= budget
      ? sanitized
      : sanitized.slice(sanitized.length - budget);

  candidate = `${base}${suffix}`;

  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  for (let index = 2; index < 1000; index += 1) {
    const numbered = `_${hash}${index}`;
    const numberedBudget = MAX_GATEWAY_TOOL_NAME_LEN - numbered.length;
    const numberedBase =
      sanitized.length <= numberedBudget
        ? sanitized
        : sanitized.slice(sanitized.length - numberedBudget);
    candidate = `${numberedBase}${numbered}`;

    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  return "";
}

function asGatewayToolRows(data: unknown): GatewayTool[] {
  /*
   * Paperclip GET /api/tool-gateway/tools returns a bare array of descriptors.
   * Named MCP gateways and some proxies wrap the same payload as { tools: [...] }.
   */
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as { tools?: unknown })?.tools)
      ? ((data as { tools: unknown[] }).tools)
      : Array.isArray((data as { data?: unknown })?.data)
        ? ((data as { data: unknown[] }).data)
        : [];

  return raw.filter(
    (tool: unknown): tool is GatewayTool =>
      !!tool &&
      typeof tool === "object" &&
      typeof (tool as Record<string, unknown>).name === "string",
  );
}

/**
 * Normalize Paperclip session/MCP tool descriptors into OpenAI function tools.
 * Exported for unit tests — Paperclip uses parametersSchema; MCP uses inputSchema.
 */
export function gatewayToolsFromDiscoveryPayload(data: unknown): {
  tools: StaplerTool[];
  originalNameBySafeName: Map<string, string>;
} {
  const rows = asGatewayToolRows(data);
  const used = new Set<string>();
  const originalNameBySafeName = new Map<string, string>();
  const tools: StaplerTool[] = [];

  for (const tool of rows) {
    const original = asString(tool.name, "").trim();
    const safe = allocateSafeToolName(original, used);

    if (!original || !safe) {
      continue;
    }

    originalNameBySafeName.set(safe, original);

    const schemaCandidate =
      tool.inputSchema ?? tool.parametersSchema;

    const inputSchema =
      schemaCandidate && typeof schemaCandidate === "object"
        ? schemaCandidate
        : {
            type: "object",
            properties: {},
            additionalProperties: true,
          };

    const label =
      asString(tool.description, "").trim() ||
      asString(tool.title, "").trim() ||
      asString(tool.displayName, "").trim();

    /*
     * Keep the gateway’s original name in the description so the model can
     * tell COMPOSIO_SEARCH_TOOLS from COMPOSIO_WAIT_FOR_CONNECTIONS even when
     * the OpenAI-facing name is truncated or hashed.
     */
    const description = label
      ? `${label} (gateway tool: ${original})`
      : `Gateway tool: ${original}`;

    tools.push({
      type: "function",
      function: {
        name: safe,
        description,
        parameters: inputSchema,
      },
    });
  }

  return {
    tools,
    originalNameBySafeName,
  };
}

function resolvePaperclipApiUrl(
  config: Record<string, unknown>,
): string {
  return (
    asString(config.paperclipApiUrl, "").trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    DEFAULT_PAPERCLIP_API_URL
  ).replace(/\/+$/, "");
}

export function buildPaperclipApiUrl(
  baseUrl: string,
  endpoint: string,
): string {
  const apiRoot = baseUrl.endsWith("/api")
    ? baseUrl
    : `${baseUrl}/api`;

  return `${apiRoot}/${endpoint.replace(/^\/+/, "")}`;
}

/**
 * Paperclip mints a short-lived run JWT into ctx.authToken when the adapter
 * declares supportsLocalAgentJwt. Fallbacks cover older hosts and operators
 * who bind a Paperclip API key explicitly.
 */
export function resolvePaperclipAuthToken(
  ctx: AdapterExecutionContext,
  config?: Record<string, unknown>,
): string {
  const cfg =
    config ??
    (ctx.config ?? {});

  const runtime =
    (ctx.runtime ?? {}) as unknown as Record<string, unknown>;

  return (
    asString(ctx.authToken, "").trim() ||
    asString(runtime.paperclipApiKey, "").trim() ||
    asString(cfg.paperclipApiKey, "").trim() ||
    asString(
      parseObject(cfg.env).PAPERCLIP_API_KEY,
      "",
    ).trim() ||
    process.env.PAPERCLIP_API_KEY?.trim() ||
    ""
  );
}

/**
 * Heartbeat run id for Paperclip attribution (cross-issue writes require
 * X-Paperclip-Run-Id). Prefer ctx.runId; fall back to wake context and
 * PAPERCLIP_RUN_ID the way CLI adapters do.
 */
export function resolvePaperclipRunId(
  ctx: AdapterExecutionContext,
): string {
  const context = parseObject(ctx.context);
  const runtime =
    (ctx.runtime ?? {}) as unknown as Record<string, unknown>;
  const env = parseObject(
    (ctx.config ?? {}).env,
  );

  return (
    asString(ctx.runId, "").trim() ||
    asString(context.runId, "").trim() ||
    asString(context.paperclipRunId, "").trim() ||
    asString(runtime.runId, "").trim() ||
    asString(env.PAPERCLIP_RUN_ID, "").trim() ||
    process.env.PAPERCLIP_RUN_ID?.trim() ||
    ""
  );
}

/**
 * Resolve a Paperclip session resource URL against the configured API base.
 *
 * Session create returns root-absolute paths (`/api/tool-gateway/tools`) while
 * `paperclipApiUrl` usually already ends in `/api`. Naively concatenating those
 * yields `/api/api/...` and Paperclip responds 404 "API route not found".
 */
export function joinPaperclipResourceUrl(
  baseUrl: string,
  value: string,
): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return baseUrl.replace(/\/+$/, "");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("/")) {
    try {
      return `${new URL(baseUrl).origin}${trimmed}`;
    } catch {
      const withoutApiSuffix = baseUrl.replace(/\/api\/?$/i, "");
      return `${withoutApiSuffix.replace(/\/+$/, "")}${trimmed}`;
    }
  }

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/${trimmed}`;
}

async function paperclipFetch(
  ctx: AdapterExecutionContext,
  url: string,
  init: RequestInit & {
    timeoutMs?: number;
    label?: string;
    config?: Record<string, unknown>;
  } = {},
): Promise<Response> {
  const {
    timeoutMs = GATEWAY_SETUP_TIMEOUT_MS,
    label = `Paperclip API (${url})`,
    config,
    ...rest
  } = init;

  const token = resolvePaperclipAuthToken(ctx, config);

  if (!token) {
    throw new Error(
      "Paperclip authentication token is unavailable to SignalCommander.",
    );
  }

  const headers = new Headers(rest.headers);

  headers.set(
    "Authorization",
    `Bearer ${token}`,
  );

  headers.set(
    "Accept",
    "application/json",
  );

  if (rest.body !== undefined) {
    headers.set(
      "Content-Type",
      "application/json",
    );
  }

  return fetchWithTimeout(
    url,
    {
      ...rest,
      headers,
      timeoutMs,
      label,
    },
  );
}

export async function createToolGatewaySession(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): Promise<ToolGatewaySession | null> {
  const token =
    resolvePaperclipAuthToken(ctx, config);

  if (!token) {
    return null;
  }

  const base =
    resolvePaperclipApiUrl(
      config,
    );

  const context =
    (ctx.context ?? {}) as Record<
      string,
      unknown
    >;

  const issue =
    parseObject(
      context.issue,
    );

  const issueId =
    asString(
      context.issueId,
      "",
    ).trim() ||
    asString(
      context.issueID,
      "",
    ).trim() ||
    asString(
      issue.id,
      "",
    ).trim();

  const project =
    parseObject(
      context.project,
    );

  const projectId =
    asString(
      context.projectId,
      "",
    ).trim() ||
    asString(
      project.id,
      "",
    ).trim();

  const response =
    await paperclipFetch(
      ctx,
      buildPaperclipApiUrl(
        base,
        "tool-gateway/sessions",
      ),
      {
        method: "POST",
        config,

        body: JSON.stringify({
          companyId:
            asString(
              ctx.agent?.companyId,
              "",
            ).trim() ||
            asString(
              context.companyId,
              "",
            ).trim(),

          agentId:
            asString(
              ctx.agent?.id,
              "",
            ).trim(),

          runId: resolvePaperclipRunId(ctx),

          ...(issueId
            ? { issueId }
            : {}),

          ...(projectId
            ? { projectId }
            : {}),

          ttlMs:
            30 * 60 * 1000,
        }),
      },
    );

  if (
    response.status === 404 ||
    response.status === 501
  ) {
    return null;
  }

  if (!response.ok) {
    const body =
      (
        await response.text()
      ).slice(
        0,
        2000,
      );

    throw new Error(
      `Paperclip tool gateway session failed (HTTP ${response.status}): ${body}`,
    );
  }

  const data =
    (await response.json()) as Partial<ToolGatewaySession>;

  if (
    !data.token ||
    !data.toolsUrl ||
    !data.callUrl ||
    !data.sessionId
  ) {
    throw new Error(
      "Paperclip tool gateway returned an incomplete session.",
    );
  }

  return {
    sessionId:
      data.sessionId,

    token:
      data.token,

    toolsUrl:
      joinPaperclipResourceUrl(
        base,
        data.toolsUrl,
      ),

    callUrl:
      joinPaperclipResourceUrl(
        base,
        data.callUrl,
      ),
  };
}

export async function listGatewayTools(
  ctx: AdapterExecutionContext,
  session: ToolGatewaySession,
): Promise<{
  tools: StaplerTool[];
  originalNameBySafeName: Map<
    string,
    string
  >;
}> {
  const response =
    await fetchWithTimeout(
      session.toolsUrl,
      {
        headers: {
          "x-paperclip-tool-gateway-token":
            session.token,

          Accept:
            "application/json",
        },

        timeoutMs:
          GATEWAY_SETUP_TIMEOUT_MS,

        label:
          "Paperclip tool discovery",
      },
    );

  if (!response.ok) {
    const body =
      (
        await response.text()
      ).slice(
        0,
        2000,
      );

    throw new Error(
      `Paperclip tool discovery failed (HTTP ${response.status}): ${body}`,
    );
  }

  const data: unknown =
    await response.json();

  return gatewayToolsFromDiscoveryPayload(data);
}

export async function callGatewayTool(
  session: ToolGatewaySession,
  originalToolName: string,
  parameters: unknown,
): Promise<unknown> {
  let response: Response;

  try {
    response =
    await fetchWithTimeout(
      session.callUrl,
      {
        method: "POST",

        headers: {
          "x-paperclip-tool-gateway-token":
            session.token,

          "Content-Type":
            "application/json",

          Accept:
            "application/json",
        },

        body: JSON.stringify({
          tool:
            originalToolName,

          parameters:
            parameters &&
            typeof parameters ===
              "object"
              ? parameters
              : {},

          timeoutMs:
            120_000,
        }),

        timeoutMs:
          GATEWAY_CALL_TIMEOUT_MS,

        label: `Paperclip tool ${originalToolName}`,
      },
    );
  } catch (error) {
    /*
     * A hung gateway must fail this one tool call, not the whole run: the
     * model can still report or route around a single failed tool.
     */
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }

  const text =
    await response.text();

  let data: unknown =
    text;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    // Keep plain-text upstream responses intact.
  }

  if (!response.ok) {
    return {
      ok: false,

      status:
        response.status,

      error:
        data,
    };
  }

  return {
    ok: true,

    result:
      data,
  };
}

export async function revokeToolGatewaySession(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  session: ToolGatewaySession,
): Promise<void> {
  try {
    const base =
      resolvePaperclipApiUrl(
        config,
      );

    await paperclipFetch(
      ctx,
      buildPaperclipApiUrl(
        base,
        `tool-gateway/sessions/${encodeURIComponent(session.sessionId)}/revoke`,
      ),
      {
        method: "POST",
        config,

        timeoutMs:
          GATEWAY_REVOKE_TIMEOUT_MS,

        label:
          "Paperclip tool gateway revoke",
      },
    );
  } catch {
    // Revocation is best effort. The session is short-lived and expires automatically.
  }
}
