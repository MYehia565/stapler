import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type CheckResult,
  ensureBuiltArtifacts,
  findAdapterCopies,
  overallFromChecks,
  PACKAGE_ROOT,
  printReport,
  writeEvidenceFile,
} from "./verify-lib.js";

async function inspectSymlink(target: string): Promise<string> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(target);
      return `${target} -> ${resolved}`;
    }
    return target;
  } catch {
    return `${target} (missing)`;
  }
}

function listCandidateProcesses(): CheckResult {
  if (process.platform === "win32") {
    return {
      name: "Live daemon process",
      status: "SKIP",
      evidence:
        "Process inspection for Paperclip daemon is intended for the Linux VPS host. Run this command on /opt/paperclip.",
    };
  }

  const ps = spawnSync(
    "ps",
    ["-eo", "pid,args"],
    { encoding: "utf8" },
  );

  if (ps.status !== 0) {
    return {
      name: "Live daemon process",
      status: "SKIP",
      evidence: `Unable to list processes: ${ps.stderr || ps.stdout}`,
    };
  }

  const lines = ps.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /paperclip/i.test(line) &&
      !/verify:runtime/i.test(line),
    );

  if (!lines.length) {
    return {
      name: "Live daemon process",
      status: "SKIP",
      evidence:
        "LIVE DAEMON VERIFICATION: NOT AVAILABLE — no paperclip process found in `ps` output.",
    };
  }

  return {
    name: "Live daemon process",
    status: "PASS",
    evidence: lines.join("\n"),
  };
}

async function inspectModuleResolution(): Promise<CheckResult> {
  const artifacts = await ensureBuiltArtifacts();
  const packageJsonPath = path.join(PACKAGE_ROOT, "package.json");
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as {
    name?: string;
    version?: string;
    exports?: Record<string, string>;
  };

  const exportServer =
    packageJson.exports?.["./server"] ??
    "./dist/server/index.js";
  const resolvedExport = path.resolve(
    PACKAGE_ROOT,
    exportServer,
  );

  let importedPath = "NOT DETERMINED";
  try {
    const imported = await import(
      pathToFileURL(artifacts.serverEntry).href
    );
    importedPath =
      typeof imported.createServerAdapter === "function"
        ? artifacts.serverEntry
        : "import succeeded without createServerAdapter";
  } catch (error) {
    return {
      name: "Resolved module path",
      status: "FAIL",
      evidence:
        error instanceof Error ? error.message : String(error),
    };
  }

  return {
    name: "Resolved module path",
    status: "PASS",
    evidence: [
      `package name: ${packageJson.name ?? "unknown"}`,
      `package version: ${packageJson.version ?? "unknown"}`,
      `source package path: ${path.join(PACKAGE_ROOT, "src")}`,
      `compiled package path: ${path.join(PACKAGE_ROOT, "dist")}`,
      `exports['./server']: ${resolvedExport}`,
      `harness import path: ${importedPath}`,
      `NOTE: This is the package under test, not proof of the live Paperclip daemon module graph.`,
    ].join("\n"),
  };
}

async function inspectDuplicates(): Promise<CheckResult> {
  const searchRoot =
    process.env.PAPERCLIP_ROOT?.trim() ||
    (process.platform === "win32" ? "" : "/opt/paperclip");

  if (!searchRoot) {
    return {
      name: "Duplicate adapter copies",
      status: "SKIP",
      evidence:
        "Set PAPERCLIP_ROOT=/opt/paperclip on the host to scan for duplicates.",
    };
  }

  const copies = await findAdapterCopies(searchRoot);
  const details: string[] = [];
  for (const copy of copies) {
    details.push(await inspectSymlink(copy));
    details.push(
      await inspectSymlink(path.join(copy, "dist")),
    );
    details.push(
      await inspectSymlink(path.join(copy, "package.json")),
    );
  }

  return {
    name: "Duplicate adapter copies",
    status: "PASS",
    evidence:
      copies.length === 0
        ? `No copies found under ${searchRoot}`
        : details.join("\n"),
  };
}

async function main(): Promise<number> {
  const artifacts = await ensureBuiltArtifacts();
  const checks: CheckResult[] = [
    await inspectModuleResolution(),
    await inspectDuplicates(),
    listCandidateProcesses(),
  ];

  const live = checks.find(
    (check) => check.name === "Live daemon process",
  );

  const report = {
    title: "STAPLER RUNTIME RESOLUTION",
    adapterSource: path.join(PACKAGE_ROOT, "src"),
    compiledAdapter: path.join(PACKAGE_ROOT, "dist"),
    resolvedModule: artifacts.serverEntry,
    packageVersion: artifacts.packageVersion,
    checks,
    overall: overallFromChecks(checks, {
      liveDaemonStatus: live?.status,
    }),
  };

  printReport(report);
  const evidencePath = path.join(
    PACKAGE_ROOT,
    "verification-runtime.json",
  );
  await writeEvidenceFile(evidencePath, report);
  console.log(`\nWrote ${evidencePath}`);

  if (live?.status === "SKIP") {
    console.log("\nLIVE DAEMON VERIFICATION: NOT AVAILABLE");
    console.log(
      "Operator follow-up on the VPS: inspect the Paperclip daemon PID, cwd, and Node module paths manually if required.",
    );
  }

  return report.overall === "FAILED" ? 1 : 0;
}

const exitCode = await main();
process.exitCode = exitCode;
