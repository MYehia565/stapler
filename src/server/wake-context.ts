import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

import { paperclipApiRequest } from "./paperclip-issue-tools.js";

export interface WakeEnrichmentResult {
  context: Record<string, unknown>;
  warnings: string[];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseWakePayloadJson(raw: string): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function commentBody(value: unknown): string {
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.trim() : "";
  }

  const row = value as Record<string, unknown>;
  return (
    clean(row.body) ||
    clean(row.content) ||
    clean(row.text) ||
    clean(row.markdown)
  );
}

function resolveWakeCommentId(context: Record<string, unknown>): string {
  const wake = parseObject(context.paperclipWake);

  return (
    clean(context.wakeCommentId) ||
    clean(context.commentId) ||
    clean(wake.commentId) ||
    clean(wake.wakeCommentId) ||
    clean(process.env.PAPERCLIP_WAKE_COMMENT_ID) ||
    ""
  );
}

function resolveWakeReason(context: Record<string, unknown>): string {
  const wake = parseObject(context.paperclipWake);

  return (
    clean(context.wakeReason) ||
    clean(wake.reason) ||
    clean(wake.wakeReason) ||
    clean(process.env.PAPERCLIP_WAKE_REASON) ||
    ""
  );
}

function resolveIssueId(context: Record<string, unknown>): string {
  const issue = parseObject(context.issue);

  return (
    clean(context.issueId) ||
    clean(context.issueID) ||
    clean(context.taskId) ||
    clean(issue.id) ||
    clean(process.env.PAPERCLIP_TASK_ID) ||
    ""
  );
}

/**
 * Enrich wake context before prompt build:
 * - Promote PAPERCLIP_WAKE_PAYLOAD_JSON / context wake payload
 * - Fetch the triggering comment body when wakeCommentId is present
 * - Merge nested issue.comments into top-level comments for the prompt
 */
export async function enrichPaperclipWakeContext(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): Promise<WakeEnrichmentResult> {
  const warnings: string[] = [];
  const context: Record<string, unknown> = {
    ...((ctx.context ?? {}) as Record<string, unknown>),
  };

  const wakeReason = resolveWakeReason(context);
  if (wakeReason && !clean(context.wakeReason)) {
    context.wakeReason = wakeReason;
  }

  const wakeCommentId = resolveWakeCommentId(context);
  if (wakeCommentId && !clean(context.wakeCommentId)) {
    context.wakeCommentId = wakeCommentId;
  }

  const envWakePayload = clean(process.env.PAPERCLIP_WAKE_PAYLOAD_JSON);
  const existingPayload =
    context.paperclipWakePayload ??
    context.wakePayload ??
    parseObject(context.paperclipWake).payload;

  if (!existingPayload && envWakePayload) {
    const parsed = parseWakePayloadJson(envWakePayload);
    if (parsed) {
      context.paperclipWakePayload = parsed;
    } else {
      warnings.push(
        "PAPERCLIP_WAKE_PAYLOAD_JSON was set but could not be parsed as JSON.",
      );
    }
  }

  const issue = parseObject(context.issue);
  const nestedComments = Array.isArray(issue.comments)
    ? issue.comments
    : Array.isArray(issue.recentComments)
      ? issue.recentComments
      : null;

  if (!Array.isArray(context.comments) && nestedComments) {
    context.comments = nestedComments;
  }

  if (wakeCommentId) {
    const issueId = resolveIssueId(context);
    if (!issueId) {
      warnings.push(
        `Wake comment id ${wakeCommentId} was present but no issue id was available to fetch it.`,
      );
    } else {
      const result = (await paperclipApiRequest(
        ctx,
        config,
        "GET",
        `issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(wakeCommentId)}`,
      )) as { ok?: boolean; data?: unknown; error?: string };

      if (result.ok && result.data) {
        context.wakeComment = result.data;
        const body = commentBody(result.data);
        if (body) {
          context.wakeCommentBody = body;
        }
      } else {
        // Fallback: list comments and find the id locally.
        const list = (await paperclipApiRequest(
          ctx,
          config,
          "GET",
          `issues/${encodeURIComponent(issueId)}/comments`,
        )) as { ok?: boolean; data?: unknown; error?: string };

        if (list.ok) {
          const rows = Array.isArray(list.data)
            ? list.data
            : Array.isArray((list.data as { comments?: unknown })?.comments)
              ? ((list.data as { comments: unknown[] }).comments)
              : [];

          const match = rows.find((row) => {
            if (!row || typeof row !== "object") return false;
            const id = clean((row as Record<string, unknown>).id);
            return id === wakeCommentId;
          });

          if (match) {
            context.wakeComment = match;
            const body = commentBody(match);
            if (body) {
              context.wakeCommentBody = body;
            }
          } else {
            warnings.push(
              `Could not locate wake comment ${wakeCommentId} on issue ${issueId}.`,
            );
          }

          if (!Array.isArray(context.comments) && rows.length) {
            context.comments = rows;
          }
        } else {
          warnings.push(
            `Could not fetch wake comment ${wakeCommentId}: ${
              result.error || list.error || "unknown error"
            }`,
          );
        }
      }
    }
  }

  return { context, warnings };
}
