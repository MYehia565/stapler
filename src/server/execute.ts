import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

import {
  asString,
} from "@paperclipai/adapter-utils/server-utils";

import { inferOpenAiCompatibleBiller } from "@paperclipai/adapter-utils";

import {
  DEFAULT_MAX_TOOL_ROUNDS,
  MAX_MAX_TOOL_ROUNDS,
  resolveLoopProtectionConfig,
  resolveRequestTimeoutSec,
  resolveRunTimeoutSec,
  validateStaplerConfig,
} from "./config.js";
import {
  fetchWithTimeout,
  HttpTimeoutError,
} from "./http.js";
import {
  providerApiKeyEnvName,
  resolveBareModelId,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  resolveProviderId,
  resolveProviderLabel,
  resolveSlotExtra,
} from "./providers.js";
import { loadInstructionsFile } from "./instructions.js";
import {
  buildSignalCommanderPrompt,
  buildToolAvailabilityMessage,
} from "./prompt.js";
import {
  discoverModels,
  resolveProfileModel,
} from "./models.js";
import { buildChatCompletionsBody } from "./chat-body.js";
import {
  hostCwd,
  hostModel,
  hostSystemPrompt,
} from "./host-execution.js";
import {
  listLocalTools,
  LOCAL_MUTATING_TOOL_NAMES,
  toolContextFromExecution,
  workspaceRootWarning,
} from "./local-tools.js";
import {
  listPaperclipIssueTools,
  PAPERCLIP_ISSUE_TOOL_NAMES,
} from "./paperclip-issue-tools.js";
import { loadDesiredStaplerSkills } from "./skill-content.js";
import {
  isToolResultFailure,
  looksLikeTextToolCall,
  normalizeReturnedToolCalls,
  parseToolArguments,
  toolRoundSignature,
} from "./tool-call-protocol.js";
import {
  createLoopProtectionState,
  evaluateLoopProtection,
  loopBlockedToolResult,
} from "./loop-protection.js";

import {
  createToolGatewaySession,
  listGatewayTools,
  resolvePaperclipAuthToken,
  resolvePaperclipRunId,
  revokeToolGatewaySession,
} from "./tool-gateway.js";

import type { StaplerTool } from "./tool-gateway.js";
import { dispatchToolCall } from "./dispatch.js";
import { enrichPaperclipWakeContext } from "./wake-context.js";

function firstText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item === "object") {
        const object = item as Record<string, unknown>;

        if (typeof object.text === "string") {
          return object.text;
        }
      }

      return "";
    })
    .filter(Boolean)
    .join("");
}

/** Interval between "still waiting" lines while a request is in flight. */
const HEARTBEAT_MS = 15_000;

/**
 * A run that produces no output looks hung to an operator even when it is
 * working, so progress is written to the run log as it happens. Logging is
 * best effort and must never fail the run.
 */
function createProgressLogger(
  ctx: AdapterExecutionContext,
): (message: string) => Promise<void> {
  const startedAt = Date.now();

  return async (message: string) => {
    const elapsed = (
      (Date.now() - startedAt) /
      1000
    ).toFixed(1);

    try {
      await ctx.onLog?.(
        "stdout",
        `[stapler +${elapsed}s] ${message}\n`,
      );
    } catch {
      // Ignore log transport failures.
    }
  };
}

async function withHeartbeat<T>(
  progress: (message: string) => Promise<void>,
  describe: (elapsedSec: number) => string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();

  const heartbeat = setInterval(() => {
    void progress(
      describe(
        Math.round(
          (Date.now() - startedAt) / 1000,
        ),
      ),
    );
  }, HEARTBEAT_MS);

  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
  }
}

interface ResolvedModel {
  model: string;
  warning: string;
}

async function resolveModel(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): Promise<ResolvedModel> {
  const baseUrl = resolveProviderBaseUrl(config);
  const configuredRaw =
    hostModel(ctx) ||
    resolveBareModelId(config) ||
    asString(config.model, "standard").trim();
  const configured = configuredRaw.trim();
  const aliases =
    new Set([
      "cheap",
      "fast",
      "standard",
      "reasoning",
    ]);

  if (!aliases.has(configured.toLowerCase())) {
    return { model: configured, warning: "" };
  }

  const apiKey =
    resolveProviderApiKey(config);

  if (!apiKey) {
    return { model: "", warning: "" };
  }

  try {
    const discovered = await discoverModels(
      baseUrl,
      {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    );

    return {
      model: resolveProfileModel(
        configured,
        discovered,
      ),
      warning: "",
    };
  } catch (error) {
    /*
     * Surface the discovery failure. Reporting only "no models" hides a
     * timeout or auth error behind a configuration-looking message.
     */
    return {
      model: "",
      warning: `Model discovery for profile "${configured}" failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    };
  }
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config =
    (ctx.config ?? {}) as Record<string, unknown>;

  const configErrors =
    validateStaplerConfig(config);

  if (configErrors.length) {
    return {
      exitCode: 1,
      errorMessage:
        `Invalid configuration: ${configErrors.join(" ")}`,
      provider: resolveProviderId(config),
      model: null,
      signal: null,
      timedOut: false,
    };
  }

  const apiKey =
    resolveProviderApiKey(config);

  const progress =
    createProgressLogger(ctx);

  const requestTimeoutSec =
    resolveRequestTimeoutSec(
      config.timeoutSec,
    );

  const runTimeoutSec =
    resolveRunTimeoutSec(
      config.runTimeoutSec,
      requestTimeoutSec,
    );
  const loopProtectionConfig =
    resolveLoopProtectionConfig(config);

  const runDeadline =
    Date.now() + runTimeoutSec * 1000;

  const maxToolRounds = Math.min(
    Math.max(
      Math.floor(
        Number(
          config.maxToolRounds,
        ) || DEFAULT_MAX_TOOL_ROUNDS,
      ),
      1,
    ),
    MAX_MAX_TOOL_ROUNDS,
  );

  const providerId =
    resolveProviderId(config);
  const providerLabel =
    resolveProviderLabel(config);
  const apiKeyEnv =
    providerApiKeyEnvName(config);

  await progress(
    `provider=${providerId} baseUrl=${resolveProviderBaseUrl(config)}`,
  );

  await progress(
    `run budget: ${runTimeoutSec}s wall clock, ${requestTimeoutSec}s per request, ${maxToolRounds} tool rounds`,
  );

  await progress("resolving model");

  const resolvedModel = await resolveModel(
    ctx,
    config,
  );

  const model = resolvedModel.model;

  const baseUrl =
    resolveProviderBaseUrl(config);

  if (!apiKey) {
    return {
      exitCode: 1,
      errorMessage:
        `${providerLabel} API key is not configured. Bind ${apiKeyEnv} through Environment variables / Secret access.`,
      provider: providerId,
      model,
      signal: null,
      timedOut: false,
    };
  }

  if (!model) {
    return {
      exitCode: 1,
      errorMessage:
        resolvedModel.warning ||
        `No model is configured and ${providerLabel} returned no available models from /models.`,
      provider: providerId,
      model: null,
      signal: null,
      timedOut: false,
    };
  }

  await progress(`model: ${model}`);

  let prompt: string;
  let skillWarnings: string[] = [];

  try {
    const loadedSkills =
      await loadDesiredStaplerSkills(config);
    const loadedInstructions =
      await loadInstructionsFile(config);

    skillWarnings = [
      ...loadedSkills.warnings,
      ...loadedInstructions.warnings,
    ];

    const wakeEnrichment = await enrichPaperclipWakeContext(ctx, config);
    skillWarnings.push(...wakeEnrichment.warnings);

    for (const warning of wakeEnrichment.warnings) {
      try {
        await ctx.onLog?.(
          "stderr",
          `[stapler] wake context: ${warning}\n`,
        );
      } catch {
        // Ignore log transport failures.
      }
    }

    prompt = buildSignalCommanderPrompt({
      promptTemplate: asString(
        config.promptTemplate,
        "",
      ),

      instructionsFileContent:
        loadedInstructions.content,

      instructionsFilePath:
        loadedInstructions.path,

      agent:
        (ctx.agent ?? {}) as unknown as Record<
          string,
          unknown
        >,

      context: wakeEnrichment.context,

      runId: resolvePaperclipRunId(ctx),

      skills: loadedSkills.skills,

      maxToolRounds,

      runTimeoutSec,
    });
  } catch (error) {
    return {
      exitCode: 1,
      errorMessage:
        error instanceof Error
          ? error.message
          : String(error),
      provider: providerId,
      model,
      signal: null,
      timedOut: false,
    };
  }

  const systemPrompt =
    hostSystemPrompt(ctx) ||
    "You are SignalCommander, an autonomous execution agent operating inside Paperclip. Execute the supplied task; do not ask generic clarification questions when the task context already contains the requested work.";

  const messages: any[] = [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: prompt,
    },
  ];

  // Local workspace tools (OpenAI function schemas).
  const toolCtx = toolContextFromExecution(ctx);
  const localTools = listLocalTools(toolCtx) as StaplerTool[];

  /*
   * Gateway paperclip_self tools are read-only. Expose REST-backed disposition
   * helpers whenever the run JWT is available so agents can checkout / mark
   * done|blocked|in_review without curling the API through exec_command.
   */
  const paperclipIssueTools =
    resolvePaperclipAuthToken(ctx, config).length > 0
      ? listPaperclipIssueTools()
      : [];

  const workspaceWarning = workspaceRootWarning(toolCtx);
  if (workspaceWarning) {
    skillWarnings.push(workspaceWarning);
  }

  let gatewaySession:
    Awaited<
      ReturnType<typeof createToolGatewaySession>
    > = null;

  let gatewayTools: {
    tools: StaplerTool[];
    originalNameBySafeName: Map<
      string,
      string
    >;
  } = {
    tools: [],
    originalNameBySafeName: new Map(),
  };

  const gatewayWarnings: string[] = [];

  try {
    await progress(
      "creating Paperclip Tool Gateway session",
    );

    const paperclipAuth =
      resolvePaperclipAuthToken(ctx, config);

    if (!paperclipAuth) {
      gatewayWarnings.push(
        "The Paperclip Tool Gateway session was not created because no Paperclip auth token was available (checked ctx.authToken, runtime.paperclipApiKey, config.paperclipApiKey, config.env.PAPERCLIP_API_KEY, and PAPERCLIP_API_KEY). Ensure this adapter is loaded with supportsLocalAgentJwt so Paperclip mints a run JWT into ctx.authToken.",
      );
    } else {
      gatewaySession =
        await createToolGatewaySession(
          ctx,
          config,
        );

      if (gatewaySession) {
        gatewayTools =
          await listGatewayTools(
            ctx,
            gatewaySession,
          );

        if (!gatewayTools.tools.length) {
          gatewayWarnings.push(
            "The Paperclip Tool Gateway session was created but returned no tools after policy filtering (or the connection catalog is empty/unhealthy). Confirm the connection is active+healthy, catalog refreshed, installed on this agent, and included by a bound tool profile — then check GET …/tools/profiles/effective/agents/{agentId}.",
          );
        }
      } else {
        gatewayWarnings.push(
          "The Paperclip Tool Gateway is not exposed on this host (session create returned 404/501). Auth was present, but governed Paperclip tools are unavailable.",
        );
      }
    }
  } catch (error) {
    gatewayWarnings.push(
      `The Paperclip Tool Gateway is unavailable: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  /*
   * A missing gateway silently downgrades the run to local tools only, which
   * looks like the agent refusing to work when the task needs Paperclip data.
   * Report it on stderr so it appears in the run log, not only in metadata.
   */
  for (const warning of gatewayWarnings) {
    skillWarnings.push(
      `${warning} Continuing with local workspace tools only.`,
    );

    try {
      await ctx.onLog?.(
        "stderr",
        `[stapler] ${warning}\n`,
      );
    } catch {
      // Ignore log transport failures.
    }
  }

  // MCP first so providers that truncate the tools array keep Composio.
  const tools: StaplerTool[] = [
    ...gatewayTools.tools,
    ...paperclipIssueTools,
    ...localTools,
  ];
  const declaredToolNames =
    new Set(
      tools.map(
        (tool) => tool.function.name,
      ),
    );

  /*
   * Map the safe function name exposed to the provider back
   * to the actual Paperclip tool name.
   */
  const originalToolNameBySafeName =
    new Map(
      gatewayTools.originalNameBySafeName,
    );

  for (const tool of [...localTools, ...paperclipIssueTools]) {
    const name =
      tool?.function?.name;

    if (name) {
      originalToolNameBySafeName.set(
        name,
        name,
      );
    }
  }

  /*
   * State the real tool inventory. The prompt is built before gateway
   * discovery, so availability is delivered as its own system message.
   */
  messages.splice(1, 0, {
    role: "system",
    content: buildToolAvailabilityMessage({
      workspaceToolNames: localTools.map(
        (tool) => tool.function.name,
      ),

      paperclipIssueToolNames:
        paperclipIssueTools.map(
          (tool) => tool.function.name,
        ),

      paperclipToolNames:
        gatewayTools.tools.map(
          (tool) => tool.function.name,
        ),

      gatewayWarnings,
    }),
  });

  await progress(
    gatewayTools.tools.length || paperclipIssueTools.length
      ? `tools: ${localTools.length} workspace, ${paperclipIssueTools.length} issue disposition, ${gatewayTools.tools.length} Paperclip governed`
      : `tools: ${localTools.length} workspace, no Paperclip governed tools`,
  );

  const buildBody =
    (): Record<string, unknown> =>
      buildChatCompletionsBody({
        model,
        messages,
        tools,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        slotExtra: resolveSlotExtra(config),
        agentExtra: config.extraBody,
      });

  /*
   * Progress is tracked so an exhausted budget can report the work that was
   * actually performed instead of a bare "timed out" with no detail.
   */
  const toolCallCounts =
    new Map<string, number>();
  let roundsCompleted = 0;
  let mutatingToolCalls = 0;
  let lastAssistantText = "";

  const MUTATING_TOOLS =
    new Set<string>([
      ...LOCAL_MUTATING_TOOL_NAMES,
      ...PAPERCLIP_ISSUE_TOOL_NAMES,
    ]);

  const describeWork = (): string => {
    if (!toolCallCounts.size) {
      return "no tools were called";
    }

    return [...toolCallCounts.entries()]
      .map(
        ([name, count]) =>
          `${name}×${count}`,
      )
      .join(", ");
  };

  const progressJson = () => ({
    roundsCompleted,
    toolCalls:
      Object.fromEntries(
        toolCallCounts,
      ),
    mutatingToolCalls,
    lastAssistantText:
      lastAssistantText.slice(0, 4000),
  });

  try {
    if (ctx.onMeta) {
      await ctx.onMeta({
        adapterType: "stapler",

        command:
          "POST /chat/completions",

        cwd: hostCwd(ctx),

        commandNotes: [
          "Built deterministic Paperclip execution prompt.",

          `Prompt length: ${prompt.length} characters.`,

          `Tools exposed to Stapler: ${tools.length}.`,

          `Local workspace tools exposed: ${localTools.length}.`,

          `Gateway tools exposed: ${gatewayTools.tools.length}.`,

          gatewaySession
            ? "Paperclip Tool Gateway session: active."
            : "Paperclip Tool Gateway session: unavailable (local tools only).",

          ...skillWarnings.slice(
            0,
            10,
          ),
        ],

        commandArgs: [
          `model=${model}`,
          `<prompt ${prompt.length} chars>`,
        ],

        env: {},

        prompt,

        promptMetrics: {
          promptChars: prompt.length,
        },

        context: ctx.context,
      });
    }

    let data: any = {};

    let responseText = "";
    let nudged = false;
    const loopState = createLoopProtectionState();

    for (
      let round = 0;
      round <= maxToolRounds;
      round += 1
    ) {
      const remainingMs =
        runDeadline - Date.now();

      if (remainingMs <= 0) {
        return {
          exitCode: 1,

          errorMessage:
            `Stapler run exceeded its ${runTimeoutSec}s budget after ${roundsCompleted} tool rounds (${describeWork()}). Raise "Run timeout (seconds)" for long tasks.`,

          provider: providerId,

          model,

          signal: null,

          timedOut: true,

          resultJson: {
            ...progressJson(),
            runTimeoutSec,
            lastResponse: data,
          },
        };
      }

      const roundsRemaining =
        maxToolRounds - round;

      /*
       * Once the budget is nearly spent, exploration has to stop. Without this
       * the model keeps inspecting the workspace and the run ends on a limit
       * with the requested change never made.
       */
      if (
        round > 0 &&
        !nudged &&
        (roundsRemaining <= 2 ||
          remainingMs <
            runTimeoutSec * 1000 * 0.4)
      ) {
        nudged = true;

        messages.push({
          role: "user",
          content: [
            `Budget notice: ${roundsRemaining} tool round(s) and about ${Math.round(remainingMs / 1000)}s remain.`,
            "Stop inspecting the workspace. Perform the remaining work now with write_file, str_replace, or exec_command in this round.",
            "Then reply with a summary of exactly what you changed, or state precisely what blocked you.",
          ].join(" "),
        });

        await progress(
          `budget notice sent (${roundsRemaining} rounds, ${Math.round(remainingMs / 1000)}s left)`,
        );
      }

      await progress(
        `round ${round + 1}/${maxToolRounds + 1}: POST /chat/completions (${messages.length} messages)`,
      );

      const res = await withHeartbeat(
        progress,

        (elapsedSec) =>
          `waiting for Stapler (round ${round + 1}, ${elapsedSec}s elapsed, request limit ${requestTimeoutSec}s)`,

        () =>
          fetchWithTimeout(
            `${baseUrl}/chat/completions`,
            {
              method: "POST",

              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type":
                  "application/json",
              },

              body: JSON.stringify(
                buildBody(),
              ),

              timeoutMs: Math.min(
                requestTimeoutSec * 1000,
                remainingMs,
              ),

              label: `${providerLabel} /chat/completions (round ${round + 1})`,
            },
          ),
      );

      responseText =
        await res.text();

      try {
        data = responseText
          ? JSON.parse(responseText)
          : {};
      } catch {
        data = {};
      }

      if (!res.ok) {
        return {
          exitCode: 1,

          errorMessage:
            `Stapler API HTTP ${res.status}: ${responseText.slice(
              0,
              4000,
            )}`,

          provider: providerId,

          model,

          signal: null,

          timedOut: false,

          resultJson: {
            status: res.status,
            body: responseText,
          },
        };
      }

      const message =
        data?.choices?.[0]
          ?.message;

      const toolCalls =
        Array.isArray(
          message?.tool_calls,
        )
          ? message.tool_calls
          : [];

      const assistantText =
        firstText(
          message?.content,
        ).trim();

      if (assistantText) {
        lastAssistantText =
          assistantText;
      }

      /*
       * No tool calls means the model
       * has completed the turn.
       */
      if (!toolCalls.length) {
        await progress(
          `round ${round + 1}: final message received (${assistantText.length} chars)`,
        );

        break;
      }

      await progress(
        `round ${round + 1}: ${toolCalls.length} tool call(s) requested`,
      );

      if (round === maxToolRounds) {
        return {
          exitCode: 1,

          errorMessage:
            `Stapler used all ${maxToolRounds} tool rounds without finishing (${describeWork()}). Raise "Max tool rounds" or narrow the task.`,

          provider: providerId,

          model,

          signal: null,

          timedOut: false,

          resultJson: {
            ...progressJson(),
            maxToolRounds,
            lastResponse: data,
          },
        };
      }

      /*
       * Replay a valid OpenAI assistant tool-call message. Provider metadata
       * (including Gemini thought signatures) is preserved while missing IDs
       * and provider-namespaced function names are normalized.
       */
      const normalizedToolCalls =
        normalizeReturnedToolCalls(
          toolCalls,
          declaredToolNames,
          round,
        );
      messages.push({
        ...message,
        tool_calls:
          normalizedToolCalls,
      });

      const roundResults: unknown[] = [];

      for (
        const toolCall of
          normalizedToolCalls
      ) {
        const returnedName =
          asString(
            toolCall?.function
              ?.name,
            "",
          ).trim();

        if (!returnedName) {
          const missingNameResult = {
            ok: false,
            error:
              "Tool call did not contain a function name.",
          };
          const toolCallId =
            asString(
              toolCall?.id,
              `tool-${round}-unknown`,
            );
          roundResults.push(
            missingNameResult,
          );
          messages.push({
            role: "tool",
            tool_call_id:
              toolCallId,
            content:
              JSON.stringify(
                missingNameResult,
              ),
          });
          await ctx.onLog(
            "stderr",
            `[tool-failed] unknown id=${toolCallId} ${JSON.stringify(missingNameResult)}\n`,
          );

          continue;
        }

        const originalName =
          originalToolNameBySafeName.get(
            returnedName,
          ) || returnedName;

        toolCallCounts.set(
          returnedName,
          (toolCallCounts.get(
            returnedName,
          ) ?? 0) + 1,
        );

        if (
          MUTATING_TOOLS.has(returnedName)
        ) {
          mutatingToolCalls += 1;
        }

        await progress(
          `running ${returnedName}`,
        );

        const parsedArguments =
          parseToolArguments(
            toolCall?.function
              ?.arguments,
          );

        let result: unknown;

        if (!parsedArguments.ok) {
          result = {
            ok: false,
            error:
              parsedArguments.error,
          };
        } else if (
          loopState.blockedTools.has(returnedName) ||
          loopState.blockedTools.has(originalName)
        ) {
          result = loopBlockedToolResult(returnedName);
        } else {
          try {
            result =
              await dispatchToolCall(
                ctx,
                gatewaySession,
                originalName,
                parsedArguments.args,
                config,
              );
          } catch (error) {
            result = {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            };
          }
        }

        roundResults.push(result);

        const toolCallId =
          asString(
            toolCall?.id,
            `tool-${round}-${returnedName}`,
          );

        messages.push({
          role: "tool",
          tool_call_id:
            toolCallId,
          content:
            JSON.stringify(result),
        });

        await ctx.onLog(
          isToolResultFailure(result)
            ? "stderr"
            : "stdout",
          `[tool-${isToolResultFailure(result) ? "failed" : "done"}] ${returnedName} id=${toolCallId}${
            isToolResultFailure(result)
              ? ` ${JSON.stringify(result)}`
              : ""
          }\n`,
        );
      }

      roundsCompleted += 1;

      const failedRound =
        roundResults.some(
          isToolResultFailure,
        );
      const currentToolRoundSignature =
        toolRoundSignature(
          normalizedToolCalls,
          roundResults,
        );

      const loopDecision =
        evaluateLoopProtection(
          loopState,
          {
            toolCalls: normalizedToolCalls,
            toolNames: normalizedToolCalls.map(
              (call) =>
                asString(call.function?.name, "").trim(),
            ),
            results: roundResults,
            failedRound,
            roundSignature:
              currentToolRoundSignature,
          },
          loopProtectionConfig,
        );

      if (loopDecision.level !== "none" && loopDecision.message) {
        try {
          await ctx.onLog?.(
            "stderr",
            `[stapler] ${loopDecision.message}\n`,
          );
        } catch {
          // Ignore log transport failures.
        }

        await progress(loopDecision.message);
      }

      if (loopDecision.abort) {
        return {
          exitCode: 1,
          errorMessage: loopDecision.message,
          provider: providerId,
          model,
          signal: null,
          timedOut: false,
          resultJson: {
            ...progressJson(),
            response: data,
            loopProtection: {
              level: loopDecision.level,
              blockedTools: [...loopState.blockedTools],
              actionSignature: currentToolRoundSignature,
              results: roundResults,
            },
          },
        };
      }

      if (
        loopDecision.level === "soft" ||
        loopDecision.level === "firm"
      ) {
        messages.push({
          role: "user",
          content: loopDecision.message,
        });
      }
    }

    const summary =
      firstText(
        data?.choices?.[0]
          ?.message?.content,
      ) ||
      firstText(
        data?.choices?.[0]
          ?.text,
      ) ||
      "";

    /*
     * Do not treat legacy text-based tool calls
     * as successful execution.
     */
    if (looksLikeTextToolCall(summary)) {
      return {
        exitCode: 1,

        errorMessage:
          "Stapler emitted a tool call as text instead of an OpenAI function call. Tool execution was not performed.",

        provider: providerId,

        model,

        signal: null,

        timedOut: false,

        resultJson: data,
      };
    }

    const usage =
      data?.usage ?? {};

    return {
      exitCode: 0,

      errorMessage: null,

      summary,

      usage: {
        inputTokens:
          Number(
            usage.prompt_tokens,
          ) || 0,

        outputTokens:
          Number(
            usage.completion_tokens,
          ) || 0,

        cachedInputTokens:
          Number(
            usage
              .prompt_tokens_details
              ?.cached_tokens,
          ) || 0,
      },

      provider: providerId,

      biller:
        inferOpenAiCompatibleBiller(
          process.env,
          providerId,
        ) ?? providerId,

      model,

      signal: null,

      timedOut: false,

      billingType: "unknown",

      costUsd:
        typeof data?.usage
          ?.cost === "number"
          ? data.usage.cost
          : undefined,

      resultJson: data,
    };
  } catch (error: any) {
    const timedOut =
      error instanceof HttpTimeoutError ||
      error?.name === "AbortError";

    const detail =
      error instanceof HttpTimeoutError
        ? `${error.message} Completed ${roundsCompleted} tool rounds (${describeWork()}).`
        : error?.message ||
          String(error);

    return {
      exitCode: 1,

      errorMessage: detail,

      provider: providerId,

      model,

      signal: null,

      timedOut,

      resultJson: {
        ...progressJson(),
        requestTimeoutSec,
        runTimeoutSec,
      },
    };
  } finally {
    if (gatewaySession) {
      await revokeToolGatewaySession(
        ctx,
        config,
        gatewaySession,
      );
    }
  }
}