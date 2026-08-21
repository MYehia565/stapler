import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceResolutionInput {
  context?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  cwd?: string;
  configuredCwd?: string;
}

export interface SandboxOptions {
  /**
   * When true, resolve a path that may not exist yet (e.g. write_file).
   * Existing ancestors are realpath'd; the final segment may be new.
   */
  allowNonexistent?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function cleanPath(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const cleaned = cleanPath(value);
    if (cleaned) {
      return cleaned;
    }
  }
  return "";
}

/**
 * Resolve the agent workspace root for a Paperclip run.
 *
 * Priority:
 * paperclipWorkspace.cwd → runtime.workspace → runtime.workingDirectory →
 * agent.workspace → agent.workingDirectory → ctx.cwd → config.cwd
 */
export function resolveWorkspaceRoot(
  input: WorkspaceResolutionInput,
): string {
  const context = asRecord(input.context);
  const paperclipWorkspace = asRecord(context.paperclipWorkspace);
  const runtime = asRecord(input.runtime);
  const agent = asRecord(input.agent);

  const root = firstNonEmpty(
    paperclipWorkspace.cwd,
    runtime.workspace,
    runtime.workingDirectory,
    agent.workspace,
    agent.workingDirectory,
    input.cwd,
    input.configuredCwd,
  );

  if (!root) {
    throw new Error(
      "No Paperclip workspace root was provided. Set context.paperclipWorkspace.cwd (or runtime/agent workspace) before using local tools.",
    );
  }

  return path.normalize(path.resolve(root));
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function realpathIfExists(target: string): Promise<string | null> {
  try {
    await lstat(target);
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * Resolve a user-supplied path under workspaceRoot.
 * Rejects `..` escapes and symlink escapes outside the root.
 */
export async function resolveSandboxedPath(
  workspaceRoot: string,
  requestedPath: string,
  options: SandboxOptions = {},
): Promise<string> {
  const rootAbsolute = path.normalize(path.resolve(workspaceRoot));
  const rootReal =
    (await realpathIfExists(rootAbsolute)) ?? rootAbsolute;

  const raw = cleanPath(requestedPath) || ".";
  const candidateAbsolute = path.normalize(
    path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(rootAbsolute, raw),
  );

  if (!options.allowNonexistent) {
    const candidateReal =
      (await realpathIfExists(candidateAbsolute)) ?? candidateAbsolute;

    if (!isInsideRoot(rootReal, candidateReal)) {
      throw new Error(
        `Path escapes outside the workspace root: ${requestedPath}`,
      );
    }

    return candidateReal;
  }

  // For nonexistent write targets: walk up to the nearest existing ancestor,
  // realpath it, then rejoin the remaining segments under the sandbox.
  let cursor = candidateAbsolute;
  const missing: string[] = [];

  while (true) {
    const existing = await realpathIfExists(cursor);
    if (existing) {
      if (!isInsideRoot(rootReal, existing)) {
        throw new Error(
          `Path escapes outside the workspace root: ${requestedPath}`,
        );
      }

      const resolved = path.normalize(path.join(existing, ...missing.reverse()));
      if (!isInsideRoot(rootReal, resolved)) {
        throw new Error(
          `Path escapes outside the workspace root: ${requestedPath}`,
        );
      }
      return resolved;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    missing.push(path.basename(cursor));
    cursor = parent;
  }

  if (!isInsideRoot(rootReal, candidateAbsolute)) {
    throw new Error(
      `Path escapes outside the workspace root: ${requestedPath}`,
    );
  }

  return candidateAbsolute;
}
