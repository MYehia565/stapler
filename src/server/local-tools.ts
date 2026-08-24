import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { isIP } from "node:net";

import type {
  AdapterRuntime,
  AdapterAgent,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";

import {
  resolveSandboxedPath,
  resolveWorkspaceRoot,
} from "./workspace.js";
import {
  fetchWithTimeout,
  GATEWAY_CALL_TIMEOUT_MS,
} from "./http.js";

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
  "str_replace",
  "delete_file",
  "move_file",
  "grep_search",
  "glob_files",
  "http_fetch",
  "web_search",
] as const;

export type LocalToolName = (typeof LOCAL_TOOL_NAMES)[number];

export function isLocalToolName(name: string): name is LocalToolName {
  return (LOCAL_TOOL_NAMES as readonly string[]).includes(name);
}

export const LOCAL_MUTATING_TOOL_NAMES = [
  "write_file",
  "str_replace",
  "delete_file",
  "move_file",
  "exec_command",
] as const;

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

const OLD_STRING_ALIASES = [
  "old_string",
  "oldString",
  "search",
  "find",
  "from",
] as const;

const NEW_STRING_ALIASES = [
  "new_string",
  "newString",
  "replace",
  "replacement",
  "to",
] as const;

const DEST_ALIASES = [
  "destination",
  "dest",
  "to_path",
  "toPath",
  "new_path",
  "newPath",
] as const;

const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILES = 400;
const MAX_GLOB_RESULTS = 200;
const MAX_FETCH_BYTES = 512_000;
const MAX_READ_CHARS = 400_000;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-test",
  "coverage",
  ".next",
  ".turbo",
]);

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

function pickOptionalNumber(
  args: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = Number(args[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
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

async function walkFiles(
  root: string,
  dir: string,
  onFile: (absPath: string, relPath: string) => Promise<boolean> | boolean,
): Promise<void> {
  let rootReal = path.resolve(root);
  try {
    rootReal = await realpath(root);
  } catch {
    // Keep resolved root when realpath is unavailable.
  }

  const visit = async (current: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }

    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") {
        continue;
      }

      const abs = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        const keepGoing = await visit(abs);
        if (!keepGoing) {
          return false;
        }
        continue;
      }

      if (entry.isFile()) {
        let absReal = abs;
        try {
          absReal = await realpath(abs);
        } catch {
          // Use the joined path when realpath fails.
        }

        const rel = path.relative(rootReal, absReal).replace(/\\/g, "/");
        if (rel.startsWith("..")) {
          continue;
        }

        const keepGoing = await onFile(absReal, rel);
        if (!keepGoing) {
          return false;
        }
      }
    }

    return true;
  };

  await visit(dir);
}

function matchGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/").trim();

  if (!normalizedPattern || normalizedPattern === "**" || normalizedPattern === "**/*") {
    return true;
  }

  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/{{GLOBSTAR}}/g, ".*");

  return new RegExp(`^${escaped}$`, "i").test(normalized);
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  const ipVersion = isIP(host);
  if (!ipVersion) {
    return false;
  }

  if (ipVersion === 4) {
    const parts = host.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    return false;
  }

  // IPv6 loopback / link-local / unique-local
  return (
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  );
}

function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http: and https: URLs are allowed.");
  }

  if (isBlockedHostname(url.hostname)) {
    throw new Error(
      `Refusing to fetch blocked or private host: ${url.hostname}`,
    );
  }

  return url;
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
      description:
        "Execute a shell command in the agent workspace (bash/cmd/PowerShell via the host shell). Prefer dedicated tools (grep_search, glob_files, str_replace, http_fetch) when they fit.",
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
      name: "list_directory",
      description: "List files and directories at a path.",
      inputSchema: LIST_DIR_SCHEMA,
      execute: listDirectory,
    },
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file. Optional offset/limit (1-based line numbers) return a slice.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to read (relative to workspace).",
          },
          offset: {
            type: "number",
            description: "Optional 1-based start line.",
          },
          limit: {
            type: "number",
            description: "Optional max number of lines to return.",
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
        const raw = await readFile(filePath, "utf8");
        const offset = pickOptionalNumber(args, ["offset", "start_line", "startLine"]);
        const limit = pickOptionalNumber(args, ["limit", "max_lines", "maxLines"]);

        let content = raw;
        let startLine = 1;
        let endLine: number | undefined;

        if (
          (offset !== undefined && offset > 0) ||
          (limit !== undefined && limit > 0)
        ) {
          const lines = raw.split(/\r?\n/);
          const start = Math.max(1, Math.floor(offset ?? 1));
          const count =
            limit !== undefined && limit > 0
              ? Math.floor(limit)
              : lines.length;
          const slice = lines.slice(start - 1, start - 1 + count);
          content = slice.join("\n");
          startLine = start;
          endLine = start + slice.length - 1;
        }

        if (content.length > MAX_READ_CHARS) {
          content =
            content.slice(0, MAX_READ_CHARS) +
            `\n…[truncated ${content.length - MAX_READ_CHARS} chars]`;
        }

        return {
          path: filePath,
          content,
          ...(endLine !== undefined
            ? { startLine, endLine, truncated: raw.length > content.length }
            : { truncated: raw.length > content.length }),
        };
      },
    },
    {
      name: "write_file",
      description:
        "Write a UTF-8 text file (create or overwrite). Prefer str_replace for small edits.",
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
    {
      name: "str_replace",
      description:
        "Replace an exact UTF-8 substring in a file. Fails if old_string is missing or not unique (unless replace_all is true).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File to edit (relative to workspace).",
          },
          old_string: {
            type: "string",
            description: "Exact text to find.",
          },
          new_string: {
            type: "string",
            description: "Replacement text.",
          },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence (default false).",
          },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const workspace = workspaceFromCtx(ctx);
        const requested = requireStringArgument(args, PATH_ALIASES, "path");
        const oldString = requireStringArgument(
          args,
          OLD_STRING_ALIASES,
          "old_string",
        );
        const newString = pickStringArgument(args, NEW_STRING_ALIASES);
        const replaceAll = Boolean(args.replace_all ?? args.replaceAll);

        const filePath = await resolveSandboxedPath(workspace, requested);
        const before = await readFile(filePath, "utf8");
        const occurrences = before.split(oldString).length - 1;

        if (occurrences === 0) {
          throw new Error("old_string not found in file.");
        }

        if (!replaceAll && occurrences > 1) {
          throw new Error(
            `old_string found ${occurrences} times; pass replace_all=true or provide a more unique old_string.`,
          );
        }

        const after = replaceAll
          ? before.split(oldString).join(newString)
          : before.replace(oldString, newString);

        await writeFile(filePath, after, "utf8");

        return {
          path: filePath,
          replacements: replaceAll ? occurrences : 1,
        };
      },
    },
    {
      name: "delete_file",
      description: "Delete a file inside the workspace (not directories).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to delete (relative to workspace).",
          },
        },
        required: ["path"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const workspace = workspaceFromCtx(ctx);
        const requested = requireStringArgument(args, PATH_ALIASES, "path");
        const filePath = await resolveSandboxedPath(workspace, requested);
        const info = await stat(filePath);

        if (!info.isFile()) {
          throw new Error("delete_file only removes files, not directories.");
        }

        await rm(filePath);
        return { path: filePath, deleted: true };
      },
    },
    {
      name: "move_file",
      description: "Move or rename a file within the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Source path (relative to workspace).",
          },
          destination: {
            type: "string",
            description: "Destination path (relative to workspace).",
          },
        },
        required: ["path", "destination"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const workspace = workspaceFromCtx(ctx);
        const from = requireStringArgument(args, PATH_ALIASES, "path");
        const to = requireStringArgument(args, DEST_ALIASES, "destination");

        const fromPath = await resolveSandboxedPath(workspace, from);
        const toPath = await resolveSandboxedPath(workspace, to, {
          allowNonexistent: true,
        });

        await mkdir(path.dirname(toPath), { recursive: true });
        await rename(fromPath, toPath);

        return { from: fromPath, to: toPath, moved: true };
      },
    },
    {
      name: "grep_search",
      description:
        "Search workspace text files with a regex or literal pattern. Prefer this over shell grep.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern (or literal if literal=true).",
          },
          path: {
            type: "string",
            description: "Optional subdirectory to search (default .).",
          },
          literal: {
            type: "boolean",
            description: "Treat pattern as literal string (default false).",
          },
          case_insensitive: {
            type: "boolean",
            description: "Case-insensitive match (default false).",
          },
          max_matches: {
            type: "number",
            description: `Cap matches (default ${MAX_GREP_MATCHES}).`,
          },
        },
        required: ["pattern"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const workspace = workspaceFromCtx(ctx);
        const pattern = requireStringArgument(
          args,
          ["pattern", "query", "regex", "q"],
          "pattern",
        );
        const rootRel = pickStringArgument(args, PATH_ALIASES) || ".";
        const searchRoot = await resolveSandboxedPath(workspace, rootRel);
        const literal = Boolean(args.literal);
        const caseInsensitive = Boolean(
          args.case_insensitive ?? args.caseInsensitive ?? args.i,
        );
        const maxMatches = Math.min(
          Math.max(
            Math.floor(
              pickOptionalNumber(args, ["max_matches", "maxMatches"]) ??
                MAX_GREP_MATCHES,
            ),
            1,
          ),
          MAX_GREP_MATCHES,
        );

        const flags = caseInsensitive ? "i" : "";
        const regex = new RegExp(
          literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern,
          flags,
        );

        const matches: Array<{
          path: string;
          line: number;
          text: string;
        }> = [];
        let filesScanned = 0;
        let truncated = false;

        await walkFiles(workspace, searchRoot, async (absPath, relPath) => {
          if (filesScanned >= MAX_GREP_FILES) {
            truncated = true;
            return false;
          }

          filesScanned += 1;

          let text: string;
          try {
            const buf = await readFile(absPath);
            if (buf.includes(0)) {
              return true;
            }
            text = buf.toString("utf8");
          } catch {
            return true;
          }

          const lines = text.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? "";
            if (!regex.test(line)) {
              continue;
            }

            matches.push({
              path: relPath,
              line: index + 1,
              text: line.slice(0, 500),
            });

            if (matches.length >= maxMatches) {
              truncated = true;
              return false;
            }
          }

          return true;
        });

        return {
          matches,
          filesScanned,
          truncated,
        };
      },
    },
    {
      name: "glob_files",
      description:
        "Find workspace files matching a glob (e.g. **/*.ts, src/**/*.json).",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern relative to workspace.",
          },
          path: {
            type: "string",
            description: "Optional subdirectory to search under (default .).",
          },
        },
        required: ["pattern"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const workspace = workspaceFromCtx(ctx);
        const pattern = requireStringArgument(
          args,
          ["pattern", "glob", "query"],
          "pattern",
        );
        const rootRel = pickStringArgument(args, PATH_ALIASES) || ".";
        const searchRoot = await resolveSandboxedPath(workspace, rootRel);
        const files: string[] = [];
        let truncated = false;

        await walkFiles(workspace, searchRoot, (_abs, relPath) => {
          if (matchGlob(relPath, pattern)) {
            files.push(relPath);
            if (files.length >= MAX_GLOB_RESULTS) {
              truncated = true;
              return false;
            }
          }

          return true;
        });

        return { files, truncated };
      },
    },
    {
      name: "http_fetch",
      description:
        "HTTP GET a public http(s) URL and return text (size-capped). Blocks private/link-local hosts.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute http(s) URL.",
          },
          max_bytes: {
            type: "number",
            description: `Optional response size cap (default ${MAX_FETCH_BYTES}).`,
          },
        },
        required: ["url"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const rawUrl = requireStringArgument(
          args,
          ["url", "uri", "href"],
          "url",
        );
        const url = assertPublicHttpUrl(rawUrl);
        const maxBytes = Math.min(
          Math.max(
            Math.floor(
              pickOptionalNumber(args, ["max_bytes", "maxBytes"]) ??
                MAX_FETCH_BYTES,
            ),
            1_024,
          ),
          MAX_FETCH_BYTES,
        );

        const response = await fetchWithTimeout(url.toString(), {
          method: "GET",
          headers: {
            Accept: "text/*,application/json,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent": "StaplerAdapter/1.0",
          },
          timeoutMs: Math.min(GATEWAY_CALL_TIMEOUT_MS, 60_000),
          label: `http_fetch ${url.hostname}`,
        });

        const buffer = Buffer.from(await response.arrayBuffer());
        const truncated = buffer.length > maxBytes;
        const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
        const text = slice.toString("utf8");

        return {
          ok: response.ok,
          status: response.status,
          url: url.toString(),
          contentType: response.headers.get("content-type"),
          truncated,
          body: text,
          sha1: createHash("sha1").update(slice).digest("hex"),
        };
      },
    },
    {
      name: "web_search",
      description:
        "Search the public web (DuckDuckGo Instant Answer). For richer results set STAPLER_WEB_SEARCH_URL to an OpenAI-compatible search HTTP endpoint if your host provides one.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query.",
          },
        },
        required: ["query"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const query = requireStringArgument(
          args,
          ["query", "q", "search", "prompt"],
          "query",
        );

        const customEndpoint =
          (typeof ctx.config?.webSearchUrl === "string" &&
            ctx.config.webSearchUrl.trim()) ||
          process.env.STAPLER_WEB_SEARCH_URL?.trim() ||
          "";

        if (customEndpoint) {
          const endpoint = assertPublicHttpUrl(customEndpoint);
          const response = await fetchWithTimeout(endpoint.toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "User-Agent": "StaplerAdapter/1.0",
            },
            body: JSON.stringify({ query }),
            timeoutMs: 60_000,
            label: "web_search custom",
          });

          const text = await response.text();
          let data: unknown = text;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            // keep text
          }

          return {
            ok: response.ok,
            status: response.status,
            provider: "custom",
            query,
            result: data,
          };
        }

        const ddg = new URL("https://api.duckduckgo.com/");
        ddg.searchParams.set("q", query);
        ddg.searchParams.set("format", "json");
        ddg.searchParams.set("no_html", "1");
        ddg.searchParams.set("skip_disambig", "1");

        const response = await fetchWithTimeout(ddg.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": "StaplerAdapter/1.0",
          },
          timeoutMs: 60_000,
          label: "web_search duckduckgo",
        });

        const payload = (await response.json()) as Record<string, unknown>;
        const related = Array.isArray(payload.RelatedTopics)
          ? payload.RelatedTopics
          : [];

        const results: Array<{ title: string; url: string; snippet: string }> =
          [];

        for (const entry of related) {
          if (!entry || typeof entry !== "object") {
            continue;
          }
          const row = entry as Record<string, unknown>;
          if (typeof row.FirstURL === "string" && typeof row.Text === "string") {
            results.push({
              title: row.Text.slice(0, 120),
              url: row.FirstURL,
              snippet: row.Text,
            });
          }
        }

        return {
          ok: response.ok,
          status: response.status,
          provider: "duckduckgo",
          query,
          heading: payload.Heading ?? "",
          abstract: payload.AbstractText ?? "",
          abstractUrl: payload.AbstractURL ?? "",
          results: results.slice(0, 8),
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
