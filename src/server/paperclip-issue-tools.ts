import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

import { DEFAULT_PAPERCLIP_API_URL } from "./config.js";
import {
  fetchWithTimeout,
  GATEWAY_CALL_TIMEOUT_MS,
} from "./http.js";
import type { StaplerTool } from "./tool-gateway.js";
import {
  resolvePaperclipAuthToken,
  resolvePaperclipRunId,
} from "./tool-gateway.js";

/**
 * Paperclip Tool Gateway `paperclip_self` builtins are mostly read-only.
 * Issue disposition, delegation, and inbox reads are REST contracts on /api.
 * This in-process adapter exposes them as OpenAI tools using the run JWT.
 */
export const PAPERCLIP_ISSUE_TOOL_NAMES = [
  "paperclip_checkout_issue",
  "paperclip_update_issue",
  "paperclip_add_comment",
  "paperclip_create_issue",
  "paperclip_get_issue",
  "paperclip_list_my_issues",
  "paperclip_list_agents",
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

const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;

/** Tools that do not require an issueId argument / wake issue. */
const ISSUE_ID_OPTIONAL_TOOLS = new Set<PaperclipIssueToolName>([
  "paperclip_create_issue",
  "paperclip_list_my_issues",
  "paperclip_list_agents",
]);

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

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((entry) => String(entry).trim())
    .filter(Boolean);

  return items;
}

function resolveCompanyId(
  ctx: AdapterExecutionContext,
  args: Record<string, unknown> = {},
): string {
  const context = (ctx.context ?? {}) as Record<string, unknown>;
  const issue = parseObject(context.issue);

  return (
    firstString(args, ["companyId", "company_id"]) ||
    asString((ctx.agent as { companyId?: unknown })?.companyId, "").trim() ||
    asString(context.companyId, "").trim() ||
    asString(issue.companyId, "").trim() ||
    asString(process.env.PAPERCLIP_COMPANY_ID, "").trim() ||
    ""
  );
}

function resolveAgentId(
  ctx: AdapterExecutionContext,
  args: Record<string, unknown> = {},
): string {
  return (
    firstString(args, ["agentId", "agent_id"]) ||
    asString((ctx.agent as { id?: unknown })?.id, "").trim() ||
    asString(process.env.PAPERCLIP_AGENT_ID, "").trim() ||
    ""
  );
}

export function listPaperclipIssueTools(): StaplerTool[] {
  return [
    {
      type: "function",
      function: {
        name: "paperclip_list_my_issues",
        description:
          "List this agent's assigned Paperclip issues/inbox (GET /api/agents/me/inbox-lite, with company issues fallback). Use this at the start of a heartbeat when no wake issue is already scoped.",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description:
                'Optional comma-separated statuses for the fallback list. Default: "todo,in_progress,in_review,blocked".',
            },
          },
          additionalProperties: true,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "paperclip_list_agents",
        description:
          "List company agents (GET /api/companies/{companyId}/agents) so you can resolve ids for assigneeAgentId and structured @mentions [@Name](agent://uuid).",
        parameters: {
          type: "object",
          properties: {
            companyId: {
              type: "string",
              description: "Company UUID. Defaults to this agent's company.",
            },
          },
          additionalProperties: true,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "paperclip_get_issue",
        description:
          "Fetch one Paperclip issue plus recent comments (GET /api/issues/{issueId} and /comments). Use for wake handoffs and before acting on referred work.",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description:
                "Issue UUID or key. Defaults to the wake/context issue when omitted.",
            },
            includeComments: {
              type: "boolean",
              description: "When true (default), also fetch comments.",
            },
          },
          additionalProperties: true,
        },
      },
    },
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
        name: "paperclip_create_issue",
        description:
          "Create a Paperclip issue and optionally assign another agent (POST /api/companies/{companyId}/issues). Prefer this over free-text \"Next action: agent-name\" — assignment wakes the assignee. Always set parentId (and goalId when known) for delegated subtasks.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Issue title.",
            },
            description: {
              type: "string",
              description: "Markdown description / acceptance criteria.",
            },
            assigneeAgentId: {
              type: "string",
              description:
                "Agent UUID to assign. Required for automatic inter-agent handoff.",
            },
            parentId: {
              type: "string",
              description: "Parent issue UUID when creating a subtask.",
            },
            goalId: {
              type: "string",
              description: "Goal UUID when available.",
            },
            projectId: {
              type: "string",
              description: "Project UUID when available.",
            },
            status: {
              type: "string",
              description: "Initial status. Default: todo.",
              enum: [...ISSUE_STATUSES],
            },
            priority: {
              type: "string",
              description: "Priority: critical, high, medium, or low.",
              enum: [...ISSUE_PRIORITIES],
            },
            blockedByIssueIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Issue ids that block this new issue. Prefer this over prose blockers.",
            },
            companyId: {
              type: "string",
              description: "Company UUID. Defaults to this agent's company.",
            },
          },
          required: ["title"],
          additionalProperties: true,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "paperclip_update_issue",
        description:
          "Update a Paperclip issue (PATCH /api/issues/{issueId}): status, comment, assigneeAgentId, blockedByIssueIds, priority, title, description, parentId, goalId. Use assigneeAgentId to reassign/handoff; use blockedByIssueIds for automatic unblock wakes. Always set a final status when finishing a heartbeat.",
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
                "Markdown comment. For waking another agent without reassignment, include a structured mention [@Name](agent://uuid).",
            },
            assigneeAgentId: {
              type: "string",
              description:
                "Reassign to this agent UUID (or empty string to clear agent assignee).",
            },
            assigneeUserId: {
              type: "string",
              description:
                "Reassign to a board/user UUID (set assigneeAgentId null/empty when handing back to a human).",
            },
            blockedByIssueIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Replace blocker set. Send [] to clear. Prefer issue ids over free-text blockers.",
            },
            priority: {
              type: "string",
              enum: [...ISSUE_PRIORITIES],
            },
            title: { type: "string" },
            description: { type: "string" },
            parentId: { type: "string" },
            goalId: { type: "string" },
            projectId: { type: "string" },
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
          "Post a comment on a Paperclip issue (POST /api/issues/{issueId}/comments). Free-text \"Next action: agent-name\" does NOT wake anyone. To wake another agent, include a structured mention: [@Agent Name](agent://<agent-uuid>). Resolve uuids via paperclip_list_agents.",
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

export async function paperclipApiRequest(
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
        "Paperclip auth token is unavailable; cannot call Paperclip issue APIs. Ensure supportsLocalAgentJwt so the host mints ctx.authToken.",
    };
  }

  const url = `${apiRoot(resolvePaperclipApiUrl(config))}/${path.replace(/^\/+/, "")}`;
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  });

  const runId = resolvePaperclipRunId(ctx);

  if (runId) {
    headers.set("X-Paperclip-Run-Id", runId);
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

function buildUpdatePayload(
  args: Record<string, unknown>,
): { payload: Record<string, unknown>; error?: string } {
  const status = asString(args.status, "").trim().toLowerCase();
  const comment =
    firstString(args, ["comment", "body", "message"]) || undefined;
  const title = firstString(args, ["title"]);
  const description = firstString(args, ["description"]);
  const priority = asString(args.priority, "").trim().toLowerCase();
  const parentId = firstString(args, ["parentId", "parent_id"]);
  const goalId = firstString(args, ["goalId", "goal_id"]);
  const projectId = firstString(args, ["projectId", "project_id"]);
  const blockedByIssueIds = asStringArray(args.blockedByIssueIds);

  const hasAssigneeAgentKey =
    Object.prototype.hasOwnProperty.call(args, "assigneeAgentId") ||
    Object.prototype.hasOwnProperty.call(args, "assignee_agent_id");
  const hasAssigneeUserKey =
    Object.prototype.hasOwnProperty.call(args, "assigneeUserId") ||
    Object.prototype.hasOwnProperty.call(args, "assignee_user_id");

  const assigneeAgentRaw = firstString(args, [
    "assigneeAgentId",
    "assignee_agent_id",
  ]);
  const assigneeUserRaw = firstString(args, [
    "assigneeUserId",
    "assignee_user_id",
  ]);

  if (status && !(ISSUE_STATUSES as readonly string[]).includes(status as never)) {
    return {
      payload: {},
      error: `Invalid status "${status}". Use one of: ${ISSUE_STATUSES.join(", ")}.`,
    };
  }

  if (
    priority &&
    !(ISSUE_PRIORITIES as readonly string[]).includes(priority as never)
  ) {
    return {
      payload: {},
      error: `Invalid priority "${priority}". Use one of: ${ISSUE_PRIORITIES.join(", ")}.`,
    };
  }

  const payload: Record<string, unknown> = {};

  if (status) payload.status = status;
  if (comment) payload.comment = comment;
  if (title) payload.title = title;
  if (description) payload.description = description;
  if (priority) payload.priority = priority;
  if (parentId) payload.parentId = parentId;
  if (goalId) payload.goalId = goalId;
  if (projectId) payload.projectId = projectId;
  if (blockedByIssueIds) payload.blockedByIssueIds = blockedByIssueIds;

  if (hasAssigneeAgentKey) {
    payload.assigneeAgentId = assigneeAgentRaw || null;
  }

  if (hasAssigneeUserKey) {
    payload.assigneeUserId = assigneeUserRaw || null;
  }

  if (Object.keys(payload).length === 0) {
    return {
      payload: {},
      error:
        "Provide at least one update field (status, comment, assigneeAgentId, blockedByIssueIds, …).",
    };
  }

  return { payload };
}

export async function callPaperclipIssueTool(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  name: PaperclipIssueToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const issueId = resolveIssueId(ctx, args);

  if (!ISSUE_ID_OPTIONAL_TOOLS.has(name) && !issueId) {
    return {
      ok: false,
      error:
        "issueId is required (pass issueId or rely on wake context issue id).",
    };
  }

  const agentId = resolveAgentId(ctx, args);
  const companyId = resolveCompanyId(ctx, args);

  if (name === "paperclip_list_my_issues") {
    const inbox = await paperclipApiRequest(
      ctx,
      config,
      "GET",
      "agents/me/inbox-lite",
    );

    if ((inbox as { ok?: boolean }).ok) {
      return inbox;
    }

    if (!companyId || !agentId) {
      return {
        ok: false,
        error:
          "inbox-lite failed and companyId/agentId are unavailable for the fallback assignment list.",
        inbox,
      };
    }

    const status =
      firstString(args, ["status"]) ||
      "todo,in_progress,in_review,blocked";
    const query = new URLSearchParams({
      assigneeAgentId: agentId,
      status,
    });

    return paperclipApiRequest(
      ctx,
      config,
      "GET",
      `companies/${encodeURIComponent(companyId)}/issues?${query.toString()}`,
    );
  }

  if (name === "paperclip_list_agents") {
    if (!companyId) {
      return {
        ok: false,
        error: "companyId is required to list agents.",
      };
    }

    return paperclipApiRequest(
      ctx,
      config,
      "GET",
      `companies/${encodeURIComponent(companyId)}/agents`,
    );
  }

  if (name === "paperclip_create_issue") {
    if (!companyId) {
      return {
        ok: false,
        error: "companyId is required to create an issue.",
      };
    }

    const title = firstString(args, ["title"]);
    if (!title) {
      return {
        ok: false,
        error: "title is required to create an issue.",
      };
    }

    const status = asString(args.status, "todo").trim().toLowerCase() || "todo";
    if (!(ISSUE_STATUSES as readonly string[]).includes(status as never)) {
      return {
        ok: false,
        error: `Invalid status "${status}".`,
      };
    }

    const priority = asString(args.priority, "").trim().toLowerCase();
    if (
      priority &&
      !(ISSUE_PRIORITIES as readonly string[]).includes(priority as never)
    ) {
      return {
        ok: false,
        error: `Invalid priority "${priority}".`,
      };
    }

    const payload: Record<string, unknown> = {
      title,
      status,
    };

    const description = firstString(args, ["description"]);
    const assigneeAgentId = firstString(args, [
      "assigneeAgentId",
      "assignee_agent_id",
    ]);
    const parentId = firstString(args, ["parentId", "parent_id"]);
    const goalId = firstString(args, ["goalId", "goal_id"]);
    const projectId = firstString(args, ["projectId", "project_id"]);
    const blockedByIssueIds = asStringArray(args.blockedByIssueIds);

    if (description) payload.description = description;
    if (assigneeAgentId) payload.assigneeAgentId = assigneeAgentId;
    if (parentId) payload.parentId = parentId;
    if (goalId) payload.goalId = goalId;
    if (projectId) payload.projectId = projectId;
    if (priority) payload.priority = priority;
    if (blockedByIssueIds) payload.blockedByIssueIds = blockedByIssueIds;

    const result = await paperclipApiRequest(
      ctx,
      config,
      "POST",
      `companies/${encodeURIComponent(companyId)}/issues`,
      payload,
    );

    if (
      (result as { ok?: boolean }).ok &&
      !assigneeAgentId
    ) {
      return {
        ...(result as object),
        warning:
          "Issue created without assigneeAgentId. Free-text next-action comments do not wake other agents — set assigneeAgentId or @mention [@Name](agent://uuid).",
      };
    }

    return result;
  }

  if (name === "paperclip_get_issue") {
    const issueResult = await paperclipApiRequest(
      ctx,
      config,
      "GET",
      `issues/${encodeURIComponent(issueId)}`,
    );

    const includeComments = args.includeComments !== false;
    if (!includeComments || !(issueResult as { ok?: boolean }).ok) {
      return issueResult;
    }

    const commentsResult = await paperclipApiRequest(
      ctx,
      config,
      "GET",
      `issues/${encodeURIComponent(issueId)}/comments`,
    );

    return {
      ok: true,
      status: (issueResult as { status?: number }).status,
      data: {
        issue: (issueResult as { data?: unknown }).data,
        comments: (commentsResult as { ok?: boolean }).ok
          ? (commentsResult as { data?: unknown }).data
          : null,
        commentsError: (commentsResult as { ok?: boolean }).ok
          ? undefined
          : commentsResult,
      },
    };
  }

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
    const { payload, error } = buildUpdatePayload(args);
    if (error) {
      return { ok: false, error };
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

  const hasStructuredMention = /\[@[^\]]+\]\(agent:\/\/[^)]+\)/.test(body);
  const looksLikeProseHandoff =
    /\bnext action\b/i.test(body) &&
    !hasStructuredMention &&
    !/\bagent:\/\//i.test(body);

  const result = await paperclipApiRequest(
    ctx,
    config,
    "POST",
    `issues/${encodeURIComponent(issueId)}/comments`,
    { body },
  );

  if ((result as { ok?: boolean }).ok && looksLikeProseHandoff) {
    return {
      ...(result as object),
      warning:
        "Comment posted, but free-text \"Next action\" does not wake another agent. Use paperclip_create_issue with assigneeAgentId, or include [@Agent Name](agent://uuid) from paperclip_list_agents.",
    };
  }

  return result;
}
