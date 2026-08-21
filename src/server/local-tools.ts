import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AdapterRuntime,
  AdapterAgent,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";

import {
  resolveSandboxedPath,
  resolveWorkspaceRoot,
} from "./workspace.js";

const execAsync = promisify(exec);

export interface LocalToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface StaplerFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const LOCAL_TOOL_NAMES = [
  "exec_command",
  "list_dir",
  "list_directory",
  "read_file",
  "write_file",
] as const;

export type LocalToolName = (typeof LOCAL_TOOL_NAMES)[number];

export function isLocalToolName(name: string): name is LocalToolName {
  return (LOCAL_TOOL_NAMES as readonly string[]).includes(name);
}

export type ToolContext = {
  runtime?: AdapterRuntime;
  agent?: AdapterAgent;
  cwd?: string;
  context?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** Override for exec_command timeout (milliseconds). */
  execTimeoutMs?: number;
};

const LIST_DIR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Directory path to inspect (relative to workspace).",
    },
  },
  required: ["path"],
  additionalProperties: true,
};

/**
 * Models and provider translation layers rename path/content/command arguments
 * (`file_path`, `absolute_path`, `target_file`, ...). Accept the known aliases
 * so a renamed argument does not become an endless "path is required" loop.
 */
const PATH_ALIASES = [
  "path",
  "file_path",
  "filePath",
  "filepath",
  "absolute_path",
  "absolutePath",
  "relative_path",
  "relativePath",
  "target_file",
  "targetFile",
  "file",
  "filename",
  "file_name",
  "fileName",
  "dir",
  "dir_path",
  "dirPath",
  "directory",
  "directory_path",
  "directoryPath",
] as const;

const CONTENT_ALIASES = [
  "content",
  "contents",
  "text",
  "data",
  "body",
  "file_content",
  "fileContent",
] as const;

const COMMAND_ALIASES = [
  "command",
  "cmd",
  "shell_command",
  "shellCommand",
  "script",
] as const;

function pickStringArgument(
  args: Record<string, unknown>,
  aliases: readonly string[],
): string {
  for (const alias of aliases) {
    const value = args[alias];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function describeReceivedArguments(
  args: Record<string, unknown>,
): string {
  const keys = Object.keys(args);
  return keys.length
    ? `Received argument keys: ${keys.join(", ")}.`
    : "No arguments were received.";
}

function requireStringArgument(
  args: Record<string, unknown>,
  aliases: readonly string[],
  label: string,
): string {
  const value = pickStringArgument(args, aliases);

  if (!value) {
    throw new Error(
      `${label} is required. Provide it as "${aliases[0]}" (accepted aliases: ${aliases.join(", ")}). ${describeReceivedArguments(args)}`,
    );
  }

  return value;
}

export function toolContextFromExecution(
  ctx: AdapterExecutionContext & { execTimeoutMs?: number },
): ToolContext {
  return {
    runtime: ctx.runtime,
    agent: ctx.agent,
    cwd: String((ctx as { cwd?: string }).cwd ?? ""),
    context: (ctx.context ?? {}) as Record<string, unknown>,
    config: (ctx.config ?? {}) as Record<string, unknown>,
    execTimeoutMs: ctx.execTimeoutMs,
  };
}

function workspaceFromCtx(ctx: ToolContext): string {
  return resolveWorkspaceRoot({
    context: ctx.context,
    runtime: ctx.runtime as unknown as Record<string, unknown>,
    agent: ctx.agent as unknown as Record<string, unknown>,
    cwd: ctx.cwd,
    configuredCwd:
      typeof ctx.config?.cwd === "string"
        ? ctx.config.cwd
        : undefined,
  });
}

/** Resolve workspace root or return the error message (does not throw). */
export function workspaceRootWarning(ctx: ToolContext): string | null {
  try {
    workspaceFromCtx(ctx);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function resolveExecTimeoutMs(ctx: ToolContext): number {
  if (
    typeof ctx.execTimeoutMs === "number" &&
    Number.isFinite(ctx.execTimeoutMs) &&
    ctx.execTimeoutMs > 0
  ) {
    return Math.min(Math.floor(ctx.execTimeoutMs), 3_600_000);
  }

  const timeoutSec = Number(ctx.config?.timeoutSec);
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
    return Math.min(Math.max(Math.floor(timeoutSec), 5), 3600) * 1000;
  }

  return 300_000;
}

function createExecutableTools(ctx: ToolContext): LocalToolDefinition[] {
  const listDirectory = async (
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const workspace = workspaceFromCtx(ctx);
    const dirPath = await resolveSandboxedPath(
      workspace,
      pickStringArgument(args, PATH_ALIASES) || ".",
    );

    const entries = await readdir(dirPath, { withFileTypes: true });

    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));
  };

  return [
    {
      name: "exec_command",
      description: "Execute a shell command in the agent workspace.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute.",
          },
          cwd: {
            type: "string",
            description:
              "Optional working directory (must stay inside the workspace).",
          },
        },
        required: ["command"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const workspace = workspaceFromCtx(ctx);
        const command = requireStringArgument(
          args,
          COMMAND_ALIASES,
          "command",
        );

        const commandCwd = await resolveSandboxedPath(
          workspace,
          typeof args.cwd === "string" && args.cwd.trim()
            ? args.cwd.trim()
            : ".",
          { allowNonexistent: false },
        );

        const timeout = resolveExecTimeoutMs(ctx);

        try {
          const result = await execAsync(command, {
            cwd: commandCwd,
            maxBuffer: 20 * 1024 * 1024,
            timeout,
            killSignal: "SIGTERM",
          });

          return {
            stdout: result.stdout,
            stderr: result.stderr,
            cwd: commandCwd,
          };
        } catch (error: unknown) {
          const execError = error as {
            killed?: boolean;
            signal?: string;
            message?: string;
          };

          if (
            execError.killed ||
            execError.signal === "SIGTERM" ||
            /ETIMEDOUT|timed out/i.test(String(execError.message ?? error))
          ) {
            throw new Error(
              `exec_command timed out after ${Math.round(timeout / 1000)}s.`,
            );
          }
          throw error;
        }
      },
    },
    {
      name: "list_dir",
      description: "List files and directories at a path.",
      inputSchema: LIST_DIR_SCHEMA,
      execute: listDirectory,
    },
    {
      /*
       * Keep this alias because some existing
       * Paperclip/agent configurations may already
       * refer to list_directory.
       */
      name: "list_directory",
      description: "List files and directories at a path.",
      inputSchema: LIST_DIR_SCHEMA,
      execute: listDirectory,
    },
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file. Pass the workspace-relative path as \"path\".",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to read (relative to workspace).",
          },
        },
        required: ["path"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const workspace = workspaceFromCtx(ctx);
        const requested = requireStringArgument(
          args,
          PATH_ALIASES,
          "path",
        );

        const filePath = await resolveSandboxedPath(workspace, requested);

        return {
          path: filePath,
          content: await readFile(filePath, "utf8"),
        };
      },
    },
    {
      name: "write_file",
      description:
        "Write a UTF-8 text file. Pass the workspace-relative path as \"path\" and the body as \"content\".",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to write (relative to workspace).",
          },
          content: {
            type: "string",
            description: "UTF-8 content to write.",
          },
        },
        required: ["path", "content"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const workspace = workspaceFromCtx(ctx);
        const requested = requireStringArgument(
          args,
          PATH_ALIASES,
          "path",
        );

        const filePath = await resolveSandboxedPath(workspace, requested, {
          allowNonexistent: true,
        });

        await mkdir(path.dirname(filePath), { recursive: true });

        const content = pickStringArgument(args, CONTENT_ALIASES);
        await writeFile(filePath, content, "utf8");

        return {
          path: filePath,
          written: true,
        };
      },
    },
  ];
}

/**
 * Return executable local tools.
 */
export function createLocalTools(ctx: ToolContext): LocalToolDefinition[] {
  return createExecutableTools(ctx);
}

/**
 * Return local tools in OpenAI function-calling format.
 */
export function listLocalTools(ctx?: ToolContext): StaplerFunctionTool[] {
  const tools = createExecutableTools(ctx ?? {});

  return tools.map(
    (tool): StaplerFunctionTool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }),
  );
}

/**
 * Execute a local tool by name.
 */
export async function callLocalTool(
  ctx: AdapterExecutionContext & { execTimeoutMs?: number },
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tools = createExecutableTools(toolContextFromExecution(ctx));
  const tool = tools.find((candidate) => candidate.name === name);

  if (!tool) {
    throw new Error(`Unknown local tool: ${name}`);
  }

  return tool.execute(args);
}
