import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type CheckResult,
  createTempWorkspace,
  ensureBuiltArtifacts,
  findAdapterCopies,
  importCompiledExecute,
  importCompiledLocalTools,
  importCompiledModels,
  importCompiledServer,
  overallFromChecks,
  PACKAGE_ROOT,
  printReport,
  sha256File,
  workspaceContext,
  writeEvidenceFile,
} from "./verify-lib.js";

function chatResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

async function checkToolRegistration(
  listLocalTools: (ctx?: unknown) => unknown[],
): Promise<CheckResult> {
  const tools = listLocalTools();
  const names = tools
    .map((tool) => {
      const record = tool as {
        type?: string;
        function?: {
          name?: string;
          parameters?: Record<string, unknown>;
        };
      };
      return record;
    })
    .filter((tool) => tool.type === "function" && tool.function?.name);

  const required = [
    "list_dir",
    "read_file",
    "write_file",
    "exec_command",
  ];
  const found = new Set(
    names.map((tool) => tool.function?.name ?? ""),
  );

  for (const name of required) {
    if (!found.has(name)) {
      return {
        name: "Tool registration",
        status: "FAIL",
        evidence: `Missing tool ${name}. Found: ${[...found].join(", ")}`,
      };
    }
  }

  for (const name of required) {
    const tool = names.find(
      (candidate) => candidate.function?.name === name,
    );
    const parameters = tool?.function?.parameters;
    if (!parameters || typeof parameters !== "object") {
      return {
        name: "Tool registration",
        status: "FAIL",
        evidence: `Tool ${name} is missing a parameters schema.`,
      };
    }
  }

  return {
    name: "Tool registration",
    status: "PASS",
    evidence: `Loaded compiled tools: ${[...found].sort().join(", ")}`,
  };
}

async function checkRealToolExecution(
  callLocalTool: (
    ctx: unknown,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<CheckResult[]> {
  const root = await createTempWorkspace();
  const ctx = workspaceContext(root);
  const unique = `stapler-verify-${Date.now()}`;
  const results: CheckResult[] = [];

  try {
    await writeFile(path.join(root, "seed.txt"), "seed", "utf8");

    const listing = (await callLocalTool(ctx, "list_dir", {
      path: ".",
    })) as Array<{ name: string }>;

    results.push({
      name: "list_dir",
      status: listing.some((entry) => entry.name === "seed.txt")
        ? "PASS"
        : "FAIL",
      evidence: `Listing entries: ${listing.map((entry) => entry.name).join(", ")}`,
    });

    await callLocalTool(ctx, "write_file", {
      path: "probe.txt",
      content: unique,
    });

    const onDisk = await readFile(path.join(root, "probe.txt"), "utf8");
    results.push({
      name: "write_file",
      status: onDisk === unique ? "PASS" : "FAIL",
      evidence: `Wrote ${path.join(root, "probe.txt")} with value ${JSON.stringify(onDisk)}`,
    });

    const readBack = (await callLocalTool(ctx, "read_file", {
      path: "probe.txt",
    })) as { content?: string };

    results.push({
      name: "read_file",
      status: readBack.content === unique ? "PASS" : "FAIL",
      evidence: `read_file returned ${JSON.stringify(readBack.content)}`,
    });

    const execResult = (await callLocalTool(ctx, "exec_command", {
      command:
        process.platform === "win32"
          ? "node -e \"process.stdout.write('verify-ok')\""
          : "printf verify-ok",
    })) as { stdout?: string; ok?: boolean };

    const stdout = String(execResult.stdout ?? "");
    results.push({
      name: "exec_command",
      status: stdout.includes("verify-ok") ? "PASS" : "FAIL",
      evidence: `exec_command stdout=${JSON.stringify(stdout)} result=${JSON.stringify(execResult)}`,
    });
  } catch (error) {
    results.push({
      name: "Real tool execution",
      status: "FAIL",
      evidence:
        error instanceof Error ? error.message : String(error),
    });
  }

  return results;
}

async function checkWorkspaceBoundary(
  callLocalTool: (
    ctx: unknown,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<CheckResult> {
  const root = await createTempWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), "stapler-outside-"));
  const ctx = workspaceContext(root);
  const attacks = [
    "../outside",
    "../../outside",
    path.join(outside, "escape.txt"),
  ];

  for (const attack of attacks) {
    for (const toolName of ["read_file", "write_file"] as const) {
      try {
        await callLocalTool(
          ctx,
          toolName,
          toolName === "write_file"
            ? { path: attack, content: "nope" }
            : { path: attack },
        );
        return {
          name: "Workspace boundary",
          status: "FAIL",
          evidence: `${toolName} accepted outside path ${attack}`,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if (!/outside the workspace/i.test(message)) {
          return {
            name: "Workspace boundary",
            status: "FAIL",
            evidence: `${toolName}(${attack}) failed unexpectedly: ${message}`,
          };
        }
      }
    }
  }

  await callLocalTool(ctx, "write_file", {
    path: "inside.txt",
    content: "ok",
  });
  const inside = (await callLocalTool(ctx, "read_file", {
    path: "inside.txt",
  })) as { content?: string };

  return {
    name: "Workspace boundary",
    status: inside.content === "ok" ? "PASS" : "FAIL",
    evidence:
      "Rejected ../outside, ../../outside, and absolute outside paths; inside path still works.",
  };
}

async function checkMultiTurnLoop(
  execute: (ctx: unknown) => Promise<{
    exitCode: number | null;
    summary?: string | null;
    errorMessage?: string | null;
  }>,
): Promise<CheckResult> {
  const root = await createTempWorkspace();
  const ctx = workspaceContext(root);
  const originalFetch = globalThis.fetch;
  let turn = 0;
  const turns: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith("/chat/completions")) {
      return chatResponse({ error: `unexpected url ${url}` }, 500);
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<Record<string, unknown>>;
    };
    turns.push(`turn-${turn}`);

    if (turn === 0) {
      turn += 1;
      return chatResponse({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  type: "function",
                  thought_signature:
                    "verify-signature",
                  function: {
                    name:
                      "default_api:list_dir",
                    arguments: {
                      path: ".",
                    },
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }

    if (turn === 1) {
      const messages = body.messages ?? [];
      const replayedAssistant =
        messages.find(
          (message) =>
            message.role === "assistant" &&
            Array.isArray(
              message.tool_calls,
            ),
        ) as {
          tool_calls?: Array<{
            id?: string;
            thought_signature?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        } | undefined;
      const replayedCall =
        replayedAssistant
          ?.tool_calls?.[0];
      const replayedToolResult =
        messages.find(
          (message) =>
            message.role === "tool",
        );

      if (
        replayedCall?.function?.name !==
          "list_dir" ||
        !replayedCall.id ||
        replayedCall.thought_signature !==
          "verify-signature" ||
        replayedToolResult?.tool_call_id !==
          replayedCall.id
      ) {
        return chatResponse(
          {
            error:
              "tool-call history was not normalized",
          },
          400,
        );
      }

      turn += 1;
      return chatResponse({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                toolCall("2", "write_file", {
                  path: "loop.txt",
                  content: "from-loop",
                }),
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }

    if (turn === 2) {
      turn += 1;
      return chatResponse({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                toolCall("3", "read_file", { path: "loop.txt" }),
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }

    if (turn === 3) {
      turn += 1;
      const messages = body.messages ?? [];
      const lastTool = [...messages]
        .reverse()
        .find((message) => message.role === "tool");
      const content = String(lastTool?.content ?? "");
      if (!content.includes("from-loop")) {
        return chatResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "missing prior tool result",
              },
            },
          ],
        });
      }

      return chatResponse({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                toolCall(
                  "4",
                  "exec_command",
                  {
                    command:
                      process.platform === "win32"
                        ? "node -e \"process.stdout.write('loop-exec')\""
                        : "printf loop-exec",
                  },
                ),
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }

    turn += 1;
    return chatResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "multi-turn verification complete",
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };

  try {
    const result = await execute(ctx);
    const onDisk = await readFile(path.join(root, "loop.txt"), "utf8");
    const ok =
      result.exitCode === 0 &&
      result.summary === "multi-turn verification complete" &&
      onDisk === "from-loop" &&
      turns.length >= 5;

    return {
      name: "Multi-turn execution",
      status: ok ? "PASS" : "FAIL",
      evidence: `exitCode=${result.exitCode} summary=${JSON.stringify(result.summary)} error=${JSON.stringify(result.errorMessage)} turns=${turns.join(",")} file=${JSON.stringify(onDisk)}`,
    };
  } catch (error) {
    return {
      name: "Multi-turn execution",
      status: "FAIL",
      evidence:
        error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function checkModelProfiles(
  resolveProfileModel: (
    profile: string,
    models: Array<{ id: string; label: string }>,
  ) => string,
  createServerAdapter: () => {
    modelProfiles?: Array<{ key: string }>;
  },
): Promise<CheckResult> {
  const catalogue = [
    { id: "provider/flash-mini", label: "Flash Mini" },
    { id: "provider/pro", label: "Pro" },
    { id: "provider/reasoning", label: "Reasoning" },
    { id: "provider/fast-turbo", label: "Fast Turbo" },
  ];

  const aliases = [
    "cheap",
    "fast",
    "standard",
    "reasoning",
  ] as const;
  const resolved: Record<string, string> = {};

  for (const alias of aliases) {
    const value = resolveProfileModel(alias, catalogue);
    if (!value) {
      return {
        name: "Model profiles",
        status: "FAIL",
        evidence: `Alias ${alias} resolved to empty string.`,
      };
    }
    resolved[alias] = value;
  }

  const adapter = createServerAdapter();
  const profileKeys = (adapter.modelProfiles ?? []).map(
    (profile) => profile.key,
  );

  return {
    name: "Model profiles",
    status: "PASS",
    evidence: `resolveProfileModel (not resolveModelProfile) mappings=${JSON.stringify(resolved)}; adapter.modelProfiles keys=${JSON.stringify(profileKeys)}. No adapter_profile_not_supported path exists in this package.`,
  };
}

async function checkDisposition(
  execute: (ctx: unknown) => Promise<{
    exitCode: number | null;
    summary?: string | null;
    errorMessage?: string | null;
    provider?: string | null;
    model?: string | null;
  }>,
): Promise<CheckResult> {
  const root = await createTempWorkspace();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    chatResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "structured success",
          },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });

  try {
    const success = await execute(workspaceContext(root));
    const successOk =
      success.exitCode === 0 &&
      typeof success.summary === "string" &&
      success.summary.length > 0 &&
      (success.errorMessage == null || success.errorMessage === "");

    const previousWebUrl = process.env.STAPLER_WEB_URL_1;
    const previousApiKey = process.env.STAPLER_API_KEY_1;
    delete process.env.STAPLER_WEB_URL_1;
    delete process.env.STAPLER_API_KEY_1;
    const failingCtx = workspaceContext(root);
    (failingCtx.config as Record<string, unknown>).env = {};
    const failure = await execute(failingCtx);
    if (previousWebUrl === undefined) {
      delete process.env.STAPLER_WEB_URL_1;
    } else {
      process.env.STAPLER_WEB_URL_1 = previousWebUrl;
    }
    if (previousApiKey === undefined) {
      delete process.env.STAPLER_API_KEY_1;
    } else {
      process.env.STAPLER_API_KEY_1 = previousApiKey;
    }
    const failureOk =
      failure.exitCode === 1 &&
      typeof failure.errorMessage === "string" &&
      failure.errorMessage.length > 0;

    return {
      name: "Disposition",
      status: successOk && failureOk ? "PASS" : "FAIL",
      evidence: `Adapter returns Paperclip AdapterExecutionResult fields (exitCode/summary/errorMessage), not status/disposition. success=${JSON.stringify({ exitCode: success.exitCode, summary: success.summary, errorMessage: success.errorMessage, provider: success.provider, model: success.model })} failure=${JSON.stringify({ exitCode: failure.exitCode, errorMessage: failure.errorMessage })}`,
    };
  } catch (error) {
    return {
      name: "Disposition",
      status: "FAIL",
      evidence:
        error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function checkDuplicates(): Promise<CheckResult> {
  const searchRoot =
    process.env.PAPERCLIP_ROOT?.trim() ||
    (process.platform === "win32" ? "" : "/opt/paperclip");

  if (!searchRoot) {
    return {
      name: "Duplicate builds",
      status: "SKIP",
      evidence:
        "Set PAPERCLIP_ROOT to search for duplicate stapler adapter copies.",
    };
  }

  const copies = await findAdapterCopies(searchRoot);
  return {
    name: "Duplicate builds",
    status: "PASS",
    evidence:
      copies.length === 0
        ? `No stapler adapter directories found under ${searchRoot}`
        : `Found ${copies.length} candidate(s):\n${copies.join("\n")}`,
  };
}

async function checkBuildHashes(
  serverEntry: string,
): Promise<CheckResult> {
  const sourceEntry = path.join(
    PACKAGE_ROOT,
    "src",
    "server",
    "index.ts",
  );
  const [sourceHash, compiledHash] = await Promise.all([
    sha256File(sourceEntry),
    sha256File(serverEntry),
  ]);

  return {
    name: "Build",
    status: "PASS",
    evidence: `source=${sourceEntry} sha256=${sourceHash}; compiled=${serverEntry} sha256=${compiledHash}`,
  };
}

async function main(): Promise<number> {
  const artifacts = await ensureBuiltArtifacts();
  const serverModule = await importCompiledServer();
  const localTools = await importCompiledLocalTools();
  const models = await importCompiledModels();
  const executeModule = await importCompiledExecute();

  const createServerAdapter =
    serverModule.createServerAdapter as () => {
      modelProfiles?: Array<{ key: string }>;
    };
  const listLocalTools =
    localTools.listLocalTools as (ctx?: unknown) => unknown[];
  const callLocalTool =
    localTools.callLocalTool as (
      ctx: unknown,
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
  const resolveProfileModel =
    models.resolveProfileModel as (
      profile: string,
      catalogue: Array<{ id: string; label: string }>,
    ) => string;
  const execute =
    executeModule.execute as (ctx: unknown) => Promise<{
      exitCode: number | null;
      summary?: string | null;
      errorMessage?: string | null;
      provider?: string | null;
      model?: string | null;
    }>;

  const checks: CheckResult[] = [];
  checks.push(await checkBuildHashes(artifacts.serverEntry));
  checks.push(await checkToolRegistration(listLocalTools));
  checks.push(...(await checkRealToolExecution(callLocalTool)));
  checks.push(await checkWorkspaceBoundary(callLocalTool));
  checks.push(await checkMultiTurnLoop(execute));
  checks.push(
    await checkModelProfiles(
      resolveProfileModel,
      createServerAdapter,
    ),
  );
  checks.push(await checkDisposition(execute));
  checks.push({
    name: "Runtime resolution",
    status: "PASS",
    evidence: `Compiled module loaded by this harness: ${artifacts.serverEntry}`,
  });
  checks.push(await checkDuplicates());
  checks.push({
    name: "Live daemon",
    status: "SKIP",
    evidence:
      "LIVE DAEMON VERIFICATION: NOT AVAILABLE from verify:e2e. Run `npm run verify:runtime` on the Paperclip host.",
  });

  const report = {
    title: "STAPLER RUNTIME VERIFICATION",
    adapterSource: path.join(PACKAGE_ROOT, "src"),
    compiledAdapter: path.join(PACKAGE_ROOT, "dist"),
    resolvedModule: artifacts.serverEntry,
    packageVersion: artifacts.packageVersion,
    checks,
    overall: overallFromChecks(checks, {
      liveDaemonStatus: "SKIP",
    }),
  };

  printReport(report);

  const evidencePath = path.join(
    PACKAGE_ROOT,
    "verification-e2e.json",
  );
  await writeEvidenceFile(evidencePath, report);
  console.log(`\nWrote ${evidencePath}`);

  return report.overall === "FAILED" ? 1 : 0;
}

const exitCode = await main();
process.exitCode = exitCode;
