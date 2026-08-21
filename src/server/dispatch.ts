import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import {
  callLocalTool,
  isLocalToolName,
} from "./local-tools.js";

import {
  callPaperclipIssueTool,
  isPaperclipIssueToolName,
} from "./paperclip-issue-tools.js";

import {
  callGatewayTool,
  type ToolGatewaySession,
} from "./tool-gateway.js";

/**
 * Route a tool call to local workspace tools, Paperclip issue disposition
 * helpers, or the Paperclip gateway.
 *
 * Only the local allowlist hits callLocalTool. Issue disposition tools use the
 * run JWT against /api/issues. Everything else uses the gateway when a session
 * exists; otherwise returns a structured failure without aborting the whole run.
 */
export async function dispatchToolCall(
  ctx: AdapterExecutionContext,
  session: ToolGatewaySession | null,
  name: string,
  args: Record<string, unknown>,
  config: Record<string, unknown> = {},
): Promise<unknown> {
  if (isLocalToolName(name)) {
    return callLocalTool(ctx, name, args);
  }

  if (isPaperclipIssueToolName(name)) {
    return callPaperclipIssueTool(ctx, config, name, args);
  }

  if (!session) {
    return {
      ok: false,
      error:
        "Paperclip tool gateway is unavailable for this tool.",
      warning:
        "Continuing with local workspace tools only. Configure Paperclip API auth to enable governed tools.",
    };
  }

  return callGatewayTool(session, name, args);
}
