import {
  asString,
  parseObject,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function section(title: string, value: string): string {
  return value ? `## ${title}\n${value}` : "";
}

function stringifySafe(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface SignalCommanderPromptInput {
  /** Optional adapterConfig.promptTemplate; rendered then prepended. */
  promptTemplate?: string;
  /** Contents loaded from adapterConfig.instructionsFilePath. */
  instructionsFileContent?: string;
  instructionsFilePath?: string | null;
  agent?: Record<string, unknown>;
  context?: Record<string, unknown>;
  runId?: string;
  skills?: Array<{ key: string; runtimeName: string; content: string }>;
  /** Tool rounds available for this run, so the model can budget them. */
  maxToolRounds?: number;
  /** Wall-clock budget for this run, in seconds. */
  runTimeoutSec?: number;
}

export interface ToolAvailabilityInput {
  workspaceToolNames: string[];
  /** Adapter-backed checkout / update / comment tools (REST via run JWT). */
  paperclipIssueToolNames?: string[];
  paperclipToolNames: string[];
  /** Reasons the Tool Gateway session or tool list was unavailable. */
  gatewayWarnings?: string[];
}

/**
 * The model cannot see why a tool is missing. Told nothing, it spends the run
 * shell-probing for an alternative route to Paperclip data; told plainly that
 * the capability is absent, it reports the blocker instead.
 *
 * Lead with MCP when present. If "Workspace tools" is the first heading,
 * models treat it as the only callable namespace and ignore Composio even
 * when those functions are in the request.
 */
export function buildToolAvailabilityMessage(
  input: ToolAvailabilityInput,
): string {
  const workspaceTools = input.workspaceToolNames.filter(Boolean);
  const issueTools = (input.paperclipIssueToolNames ?? []).filter(Boolean);
  const paperclipTools = input.paperclipToolNames.filter(Boolean);
  const warnings = (input.gatewayWarnings ?? []).filter(Boolean);

  const lines = ["## Tool Availability"];

  if (paperclipTools.length) {
    const listed =
      paperclipTools.length > 80
        ? `${paperclipTools.slice(0, 80).join(", ")}, … and ${
            paperclipTools.length - 80
          } more in the tools array`
        : paperclipTools.join(", ");

    lines.push(
      `MCP / Composio / governed tools ARE callable OpenAI functions in this run (${paperclipTools.length}): ${listed}.`,
      "Call them by the exact function name in the tools array (often prefixed, e.g. COMPOSIO_SEARCH_TOOLS or a name ending in NOTION_SEARCH). They are not limited to the workspace helpers.",
      "Do not report MCP tools as unavailable when this list is non-empty.",
    );
  } else {
    lines.push(
      "Paperclip governed / MCP tools are NOT available in this run.",
      "Do not attempt to reach the Paperclip API through exec_command, curl, wget, ssh, or any other HTTP client.",
      "Do not search the workspace for an alternative route to that data.",
    );

    if (!issueTools.length) {
      lines.push(
        "If the assigned task requires Paperclip data or MCP apps, stop on the first round and report that the Paperclip Tool Gateway / issue tools were unavailable, quoting the reason below. Do not spend tool rounds working around it.",
      );
    }

    if (warnings.length) {
      lines.push(
        `Reason reported by the adapter: ${warnings.join(" ")}`,
      );
    }
  }

  if (issueTools.length) {
    lines.push(
      `Paperclip issue / handoff tools (also callable functions): ${issueTools.join(", ")}.`,
      "Use paperclip_checkout_issue when you need ownership.",
      "To hand work to another agent: paperclip_create_issue with assigneeAgentId (+ parentId), or paperclip_update_issue with assigneeAgentId, or comment with [@Name](agent://uuid) from paperclip_list_agents. Free-text \"Next action: agent-name\" does NOT wake anyone.",
      "Before ending the run, call paperclip_update_issue with status done, blocked, or in_review (and blockedByIssueIds when blocked) so the issue does not stay in_progress.",
    );
  } else if (paperclipTools.length) {
    lines.push(
      "Paperclip issue disposition tools are NOT available (no run JWT). You cannot mark issues done/blocked/in_review through adapter tools in this run.",
    );
  }

  lines.push(
    workspaceTools.length
      ? `Workspace filesystem tools (files/shell/search/network helpers, not MCP): ${workspaceTools.join(", ")}.`
      : "No workspace filesystem tools are available in this run.",
  );

  lines.push(
    "Do not repeat the same tool with the same arguments when the previous result already answered the question. Loop protection will soft-warn, then block repeated tools, then abort the run.",
  );

  return lines.join("\n");
}

export function buildSignalCommanderPrompt(input: SignalCommanderPromptInput): string {
  const context = input.context ?? {};
  const agent = input.agent ?? {};

  const issue = parseObject(context.issue);
  const task = parseObject(context.task);
  const wake = parseObject(context.paperclipWake);
  const workspace = parseObject(context.paperclipWorkspace);

  const taskTitle =
    clean(context.taskTitle) ||
    clean(context.title) ||
    clean(task.title) ||
    clean(issue.title);

  const taskDescription =
    clean(context.taskDescription) ||
    clean(context.description) ||
    clean(task.description) ||
    clean(issue.description);

  const issueId =
    clean(context.issueId) ||
    clean(context.issueID) ||
    clean(issue.id);

  const issueComments = Array.isArray(issue.comments)
    ? issue.comments
    : Array.isArray(issue.recentComments)
      ? issue.recentComments
      : [];
  const commentSource = Array.isArray(context.comments)
    ? context.comments
    : issueComments;

  const comments = commentSource
    .map((comment) => {
      if (typeof comment === "string") return comment.trim();
      if (!comment || typeof comment !== "object") return "";
      const c = comment as Record<string, unknown>;
      const author =
        clean(c.authorName) ||
        clean(c.author) ||
        clean(c.userName) ||
        clean(c.agentName);
      const body = clean(c.body) || clean(c.content) || clean(c.text);
      return author && body ? `${author}: ${body}` : body;
    })
    .filter(Boolean)
    .join("\n");

  const handoff = clean(context.paperclipSessionHandoffMarkdown);
  const workMode = clean(context.issueWorkMode) || clean(context.paperclipIssueWorkMode);
  const wakeReason = clean(context.wakeReason);
  const wakeCommentId = clean(context.wakeCommentId) || clean(context.commentId);
  const wakeCommentBody =
    clean(context.wakeCommentBody) ||
    (() => {
      const wakeComment = parseObject(context.wakeComment);
      return (
        clean(wakeComment.body) ||
        clean(wakeComment.content) ||
        clean(wakeComment.text)
      );
    })();
  const wakePayload =
    context.paperclipWakePayload ??
    context.wakePayload ??
    null;

  const agentName = clean(agent.name);
  const contextInstructions =
    clean(context.agentInstructions) ||
    clean(context.instructions) ||
    clean(context.systemInstructions);
  const fileInstructions = clean(input.instructionsFileContent);
  const instructionsPath = clean(input.instructionsFilePath);
  const agentInstructions = [
    fileInstructions
      ? [
          instructionsPath
            ? `Loaded from ${instructionsPath}. Prefer this file for relative references.`
            : "",
          fileInstructions,
        ]
          .filter(Boolean)
          .join("\n\n")
      : "",
    // Keep context instructions when they add something the file did not.
    contextInstructions && contextInstructions !== fileInstructions
      ? contextInstructions
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const workspaceSummary = [
    clean(workspace.cwd) ? `cwd: ${clean(workspace.cwd)}` : "",
    clean(workspace.repoUrl) ? `repo: ${clean(workspace.repoUrl)}` : "",
    clean(workspace.repoRef) ? `ref: ${clean(workspace.repoRef)}` : "",
  ].filter(Boolean).join("\n");

  const rawContext = stringifySafe(context);

  const skills = input.skills ?? [];
  const skillContext = skills.length
    ? skills
        .map((skill) => `### ${skill.key}\n${skill.content}`)
        .join("\n\n")
    : "";

  const templateRaw = asString(input.promptTemplate, "").trim();
  const renderedTemplate = templateRaw
    ? renderTemplate(templateRaw, {
        agent,
        context,
        runId: input.runId ?? "",
      }).trim()
    : "";

  /*
   * Without a stated budget the model treats exploration as free and can spend
   * every round listing and reading files, so the run ends on a limit without
   * the requested change ever being made.
   */
  const maxToolRounds =
    Number.isFinite(input.maxToolRounds) && Number(input.maxToolRounds) > 0
      ? Math.floor(Number(input.maxToolRounds))
      : 0;

  const runTimeoutSec =
    Number.isFinite(input.runTimeoutSec) && Number(input.runTimeoutSec) > 0
      ? Math.floor(Number(input.runTimeoutSec))
      : 0;

  const budget = maxToolRounds
    ? [
        `You have at most ${maxToolRounds} tool rounds${
          runTimeoutSec ? ` and ${runTimeoutSec} seconds` : ""
        } for this entire run.`,
        "Budget them for the work itself: inspect only what you must, then perform the change with write_file or exec_command.",
        "Exploring the workspace is not an outcome. A run that only lists and reads files has failed the task.",
        "Batch independent tool calls into the same round instead of spending one round per call.",
      ]
    : [];

  const parts = [
    renderedTemplate,
    section("Paperclip Execution Contract", [
      "You are an autonomous execution agent running inside Paperclip.",
      "Execute the assigned work immediately when the supplied context is sufficient.",
      "Do not ask the user to restate a task that is already present in the context.",
      "Do not reply with generic readiness questions such as 'what task should I execute?'",
      "Use the issue/task description, comments, wake context, and session handoff as authoritative inputs.",
      "When a Triggering Wake Comment or Wake Payload is present, treat it as the highest-priority instruction for this heartbeat before generic inbox scanning.",
      "Every name in this run's tools array is a callable OpenAI function: MCP/Composio tools, issue disposition tools, and workspace filesystem tools.",
      "Workspace helpers (list_dir, read_file, write_file, str_replace, grep_search, glob_files, http_fetch, web_search, exec_command, …) cover files, search, and public HTTP. They are not the full tool set when MCP tools are also listed.",
      "If an MCP/Composio function is in the tools array, call it. The declared name may be prefixed (mcp_… or COMPOSIO_…) rather than a short slug like NOTION_SEARCH.",
      "Paperclip company data may be available through governed tools. Use those tools instead of guessing.",
      "When paperclip_update_issue is available, set a final issue disposition before ending the run (done, blocked, or in_review with a comment).",
      "Tool calls are real OpenAI function calls. Never emit XML, DSML, <tool_calls>, <invoke>, or a textual exec_command block as a substitute for calling a tool.",
      "Treat tool results as the current source of truth.",
      "Only report a required tool as unavailable when Tool Availability says MCP / governed tools are NOT available. If that list is non-empty, execute with the declared names.",
      "If execution is genuinely blocked, state the exact missing information and why it blocks the task.",
      "Do not invent requirements, facts, files, permissions, or completed work.",
      "Return a concise result describing what you actually completed or exactly what blocked execution.",
      ...budget,
    ].join("\n")),
    section("Inter-Agent Handoff Protocol", [
      "Paperclip only auto-wakes other agents through formal handoffs — never through prose like \"Next action: signal-commander …\".",
      "Preferred handoffs:",
      "1) paperclip_create_issue with title, description, assigneeAgentId, and parentId (and goalId when known).",
      "2) paperclip_update_issue with assigneeAgentId to reassign the current issue.",
      "3) paperclip_add_comment / update comment containing a structured mention [@Agent Name](agent://<agent-uuid>).",
      "4) paperclip_update_issue with blockedByIssueIds when waiting on other issues (unblocks auto-wake the assignee).",
      "Resolve agent uuids with paperclip_list_agents before mentioning or assigning.",
      "Asking a human to relay work between agents is a last resort when tools are unavailable — not the default path.",
    ].join("\n")),
    section("Agent", agentName),
    section("Task", [taskTitle ? `Title: ${taskTitle}` : "", taskDescription].filter(Boolean).join("\n")),
    section("Issue", issueId ? `ID: ${issueId}` : ""),
    section("Issue Work Mode", workMode),
    section("Wake Context", [
      wakeReason ? `Reason: ${wakeReason}` : "",
      wakeCommentId ? `Comment ID: ${wakeCommentId}` : "",
      Object.keys(wake).length ? stringifySafe(wake) : "",
    ].filter(Boolean).join("\n")),
    section("Triggering Wake Comment", wakeCommentBody),
    section(
      "Wake Payload",
      wakePayload ? stringifySafe(wakePayload) : "",
    ),
    section("Previous Session Handoff", handoff),
    section("Comments / Conversation Context", comments),
    section("Agent Instructions", agentInstructions),
    section("Selected Paperclip Skills", skillContext),
    section("Workspace", workspaceSummary),
    section("Paperclip Run ID", clean(input.runId)),
    section("Raw Paperclip Context", rawContext),
  ];

  const prompt = parts.filter(Boolean).join("\n\n").trim();

  // Never send an effectively empty/generic execution request.
  if (
    !taskTitle &&
    !taskDescription &&
    !issueId &&
    !comments &&
    !handoff &&
    !wakeCommentBody &&
    !wakePayload &&
    Object.keys(context).length === 0
  ) {
    throw new Error(
      "SignalCommander received no actionable Paperclip task context. Refusing to send a generic prompt."
    );
  }

  return prompt;
}
