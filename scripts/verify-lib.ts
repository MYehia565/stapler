import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type CheckStatus = "PASS" | "FAIL" | "SKIP";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  evidence: string;
}

export interface VerificationReport {
  title: string;
  adapterSource: string;
  compiledAdapter: string;
  resolvedModule: string;
  packageVersion: string;
  checks: CheckResult[];
  overall: "VERIFIED" | "PARTIALLY VERIFIED" | "FAILED" | "UNVERIFIABLE";
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");

export function printReport(report: VerificationReport): void {
  const lines = [
    report.title,
    "",
    `Adapter source:`,
    report.adapterSource,
    "",
    `Compiled adapter:`,
    report.compiledAdapter,
    "",
    `Resolved module:`,
    report.resolvedModule,
    "",
    `Package version:`,
    report.packageVersion,
    "",
  ];

  for (const check of report.checks) {
    lines.push(`${check.name}:`);
    lines.push(check.status);
    lines.push(check.evidence);
    lines.push("");
  }

  lines.push("Overall:");
  lines.push(report.overall);
  console.log(lines.join("\n"));
}

export function overallFromChecks(
  checks: CheckResult[],
  options: {
    liveDaemonStatus?: CheckStatus;
  } = {},
): VerificationReport["overall"] {
  if (checks.some((check) => check.status === "FAIL")) {
    return "FAILED";
  }

  if (options.liveDaemonStatus === "SKIP") {
    return "PARTIALLY VERIFIED";
  }

  if (checks.every((check) => check.status === "SKIP")) {
    return "UNVERIFIABLE";
  }

  return "VERIFIED";
}

export async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function ensureBuiltArtifacts(): Promise<{
  packageRoot: string;
  serverEntry: string;
  packageVersion: string;
}> {
  const packageJsonPath = path.join(PACKAGE_ROOT, "package.json");
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as { version?: string };
  const serverEntry = path.join(PACKAGE_ROOT, "dist", "server", "index.js");

  try {
    await stat(serverEntry);
  } catch {
    throw new Error(
      `Missing compiled adapter at ${serverEntry}. Run \`npm run build\` first.`,
    );
  }

  return {
    packageRoot: PACKAGE_ROOT,
    serverEntry,
    packageVersion: packageJson.version ?? "unknown",
  };
}

export async function importCompiledServer(): Promise<Record<string, unknown>> {
  const { serverEntry } = await ensureBuiltArtifacts();
  return import(pathToFileURL(serverEntry).href) as Promise<
    Record<string, unknown>
  >;
}

export async function importCompiledLocalTools(): Promise<
  Record<string, unknown>
> {
  const localToolsEntry = path.join(
    PACKAGE_ROOT,
    "dist",
    "server",
    "local-tools.js",
  );
  return import(pathToFileURL(localToolsEntry).href) as Promise<
    Record<string, unknown>
  >;
}

export async function importCompiledModels(): Promise<Record<string, unknown>> {
  const modelsEntry = path.join(PACKAGE_ROOT, "dist", "server", "models.js");
  return import(pathToFileURL(modelsEntry).href) as Promise<
    Record<string, unknown>
  >;
}

export async function importCompiledExecute(): Promise<Record<string, unknown>> {
  const executeEntry = path.join(PACKAGE_ROOT, "dist", "server", "execute.js");
  return import(pathToFileURL(executeEntry).href) as Promise<
    Record<string, unknown>
  >;
}

export function workspaceContext(root: string) {
  const baseUrl = "https://models.verify.stapler.test/v1";

  return {
    runId: `verify-${Date.now()}`,
    agent: {
      id: "verify-agent",
      companyId: "verify-company",
      name: "Verify Harness",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      workspace: root,
    },
    config: {
      provider: "stapler",
      baseUrl,
      model: "provider/verify-model",
      maxToolRounds: 8,
      timeoutSec: 60,
      env: {
        STAPLER_WEB_URL_1: baseUrl,
        STAPLER_API_KEY_1: "verify-harness-key",
      },
    },
    context: {
      paperclipWorkspace: { cwd: root },
      taskTitle: "Stapler verification harness",
      taskDescription: "Execute local tools through the adapter loop.",
    },
    cwd: root,
    onLog: async () => {},
  };
}

export async function createTempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "stapler-verify-"));
}

export async function findAdapterCopies(
  searchRoot: string,
): Promise<string[]> {
  const matches: string[] = [];
  const queue = [searchRoot];
  const skip = new Set([
    "node_modules",
    ".git",
    "dist-test",
    "dist-verify",
    ".pnpm",
  ]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;

    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (skip.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (
          entry.name === "stapler"
        ) {
          matches.push(fullPath);
        }
        queue.push(fullPath);
      }
    }
  }

  const unique = new Set<string>();
  for (const match of matches) {
    try {
      unique.add(await realpath(match));
    } catch {
      unique.add(path.resolve(match));
    }
  }

  return [...unique].sort();
}

export async function writeEvidenceFile(
  filePath: string,
  report: VerificationReport,
): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify(report, null, 2),
    "utf8",
  );
}
