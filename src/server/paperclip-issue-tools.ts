import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

import { DEFAULT_PAPERCLIP_API_URL } from "./config.js";
import {
  fetchWithTimeout,
  GATEWAY_CALL_TIMEOUT_MS,
} from "./http.js";
import type { StaplerTool } from "./tool-gateway.js";
import { resolvePaperclipAuthToken } from "./tool-gateway.js";

/**
 * Paperclip’s Tool Gateway `paperclip_self` builtins are read-only
 * (list_my_issues / get_issue_context). Issue disposition (done, blocked,
 * in_review, comments, checkout) is a REST contract on /api/issues. CLI
 * adapters get PAPERCLIP_API_KEY in the shell; this in-process adapter must
 * expose the same mutations as OpenAI tools using the run JWT.
 */
export const PAPERCLIP_ISSUE_TOOL_NAMES = [
  "paperclip_checkout_issue",
  "paperclip_update_issue",
  "paperclip_add_comment",
] as const;

export type PaperclipIssueToolName =
  (typeof PAPERCLIP_ISSUE_TOOL_NAMES)[number];

export function isPaperclipIssueToolName(
  name: string,
): name is PaperclipIssueToolName {
  return (PAPERCLIP_ISSUE_TOOL_NAMES as readonly string[]).includes(name);
}

const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;

function resolvePaperclipApiUrl(
  config: Record<string, unknown>,
): string {
  return (
    asString(config.paperclipApiUrl, "").trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    DEFAULT_PAPERCLIP_API_URL
  ).replace(/\/+$/, "");
}

function apiRoot(baseUrl: string): string {
  return baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`;
}

function firstString(
  args: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = asString(args[key], "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

export function listPaperclipIssueTools(): StaplerTool[] {
  return [
    {
      type: "function",
      function: {
        name: "paperclip_checkout_issue",
        description:
          "Checkout a Paperclip issue/task before working on it (POST /api/issues/{issueId}/checkout). Required before disposition mutations when the issue is not already owned by this agent. Never retry a 409 Conflict — another agent owns the issue.",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description:
                "Issue UUID or key. Defaults to the wake/context issue when omitted.",
            },
            expectedStatuses: {
              type: "array",
              items: { type: "string" },
              description:
                'Statuses allowed to checkout from. Default: ["todo","backlog","blocked","in_review"].',
            },
          },
          additionalProperties: true,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "paperclip_update_issue",
        description:
          "Update a Paperclip issue status and/or leave a progress comment (PATCH /api/issues/{issueId}). Use this to mark work done, blocked, in_review, or in_progress. Always set status when finishing a heartbeat so the issue does not stay stuck in_progress.",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description:
                "Issue UUID or key. Defaults to the wake/context issue when omitted.",
            },
            status: {
              type: "string",
              description:
                "New status: backlog, todo, in_progress, in_review, blocked, done, or cancelled.",
              enum: [...ISSUE_STATUSES],
            },
            comment: {
              type: "string",
              description:
                "Markdown comment describing what was done, what is blocked, or the next step.",
            },
          },
          additionalProperties: true,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "paperclip_add_comment",
        description:
          "Post a comment on a Paperclip issue without changing status (POST /api/issues/{issueId}/comments).",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description:
                "Issue UUID or key. Defaults to the wake/context issue when omitted.",
            },
            body: {
              type: "string",
              description: "Markdown comment body.",
            },
            comment: {
              type: "string",
              description: "Alias for body.",
            },
          },
          required: [],
          additionalProperties: true,
        },
      },
    },
  ];
}

function resolveIssueId(
  ctx: AdapterExecutionContext,
  args: Record<string, unknown>,
): string {
  const fromArgs = firstString(args, [
    "issueId",
    "issue_id",
    "taskId",
    "task_id",
    "id",
  ]);

  if (fromArgs) {
    return fromArgs;
  }

  const context = (ctx.context ?? {}) as Record<string, unknown>;
  const issue = parseObject(context.issue);

  return (
    asString(context.issueId, "").trim() ||
    asString(context.issueID, "").trim() ||
    asString(context.taskId, "").trim() ||
    asString(issue.id, "").trim() ||
    asString(process.env.PAPERCLIP_TASK_ID, "").trim() ||
    ""
  );
}

async function paperclipApiRequest(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const token = resolvePaperclipAuthToken(ctx, config);

  if (!token) {
    return {
      ok: false,
      error:
        "Paperclip auth token is unavailable; cannot mutate issues. Ensure supportsLocalAgentJwt so the host mints ctx.authToken.",
    };
  }

  const url = `${apiRoot(resolvePaperclipApiUrl(config))}/${path.replace(/^\/+/, "")}`;
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  });

  if (ctx.runId) {
    headers.set("X-Paperclip-Run-Id", String(ctx.runId));
  }

  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetchWithTimeout(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    timeoutMs: GATEWAY_CALL_TIMEOUT_MS,
    label: `Paperclip ${method} ${path}`,
  });

  const text = await response.text();
  let data: unknown = text;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text.
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error:
        typeof data === "object" && data && "error" in data
          ? String((data as { error: unknown }).error)
          : text.slice(0, 2000) || `HTTP ${response.status}`,
      data,
    };
  }

  return {
    ok: true,
    status: response.status,
    data,
  };
}

export async function callPaperclipIssueTool(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  name: PaperclipIssueToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const issueId = resolveIssueId(ctx, args);

  if (!issueId) {
    return {
      ok: false,
      error:
        "issueId is required (pass issueId or rely on wake context issue id).",
    };
  }

  const agentId =
    asString((ctx.agent as { id?: unknown })?.id, "").trim() ||
    asString(args.agentId, "").trim() ||
    asString(process.env.PAPERCLIP_AGENT_ID, "").trim();

  if (name === "paperclip_checkout_issue") {
    if (!agentId) {
      return {
        ok: false,
        error: "agentId is required for checkout.",
      };
    }

    const expectedStatuses = Array.isArray(args.expectedStatuses)
      ? args.expectedStatuses.map((value) => String(value))
      : ["todo", "backlog", "blocked", "in_review"];

    return paperclipApiRequest(
      ctx,
      config,
      "POST",
      `issues/${encodeURIComponent(issueId)}/checkout`,
      {
        agentId,
        expectedStatuses,
      },
    );
  }

  if (name === "paperclip_update_issue") {
    const status = asString(args.status, "").trim().toLowerCase();
    const comment =
      firstString(args, ["comment", "body", "message"]) || undefined;

    if (!status && !comment) {
      return {
        ok: false,
        error:
          "Provide status and/or comment. Example: { status: \"done\", comment: \"Completed work.\" }",
      };
    }

    if (status && !(ISSUE_STATUSES as readonly string[]).includes(status)) {
      return {
        ok: false,
        error: `Invalid status "${status}". Use one of: ${ISSUE_STATUSES.join(", ")}.`,
      };
    }

    const payload: Record<string, unknown> = {};

    if (status) {
      payload.status = status;
    }

    if (comment) {
      payload.comment = comment;
    }

    return paperclipApiRequest(
      ctx,
      config,
      "PATCH",
      `issues/${encodeURIComponent(issueId)}`,
      payload,
    );
  }

  const body = firstString(args, ["body", "comment", "message"]);

  if (!body) {
    return {
      ok: false,
      error: "Comment body is required (body or comment).",
    };
  }

  return paperclipApiRequest(
    ctx,
    config,
    "POST",
    `issues/${encodeURIComponent(issueId)}/comments`,
    { body },
  );
}
