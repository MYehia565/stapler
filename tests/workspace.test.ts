import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  resolveSandboxedPath,
  resolveWorkspaceRoot,
} from "../src/server/workspace.js";

describe("resolveWorkspaceRoot", () => {
  it("prefers context.paperclipWorkspace.cwd", () => {
    const root = resolveWorkspaceRoot({
      context: {
        paperclipWorkspace: { cwd: "D:/workspaces/issue-1" },
      },
      runtime: { workspace: "D:/workspaces/wrong" },
      agent: { workspace: "D:/workspaces/also-wrong" },
      cwd: "D:/workspaces/cwd",
    });

    assert.equal(
      path.normalize(root),
      path.normalize("D:/workspaces/issue-1"),
    );
  });

  it("falls through runtime then agent then ctx.cwd", () => {
    assert.equal(
      path.normalize(
        resolveWorkspaceRoot({
          runtime: { workspace: "D:/from-runtime" },
          cwd: "D:/from-cwd",
        }),
      ),
      path.normalize("D:/from-runtime"),
    );

    assert.equal(
      path.normalize(
        resolveWorkspaceRoot({
          runtime: { workingDirectory: "D:/from-runtime-wd" },
          cwd: "D:/from-cwd",
        }),
      ),
      path.normalize("D:/from-runtime-wd"),
    );

    assert.equal(
      path.normalize(
        resolveWorkspaceRoot({
          agent: { workspace: "D:/from-agent" },
          cwd: "D:/from-cwd",
        }),
      ),
      path.normalize("D:/from-agent"),
    );

    assert.equal(
      path.normalize(
        resolveWorkspaceRoot({
          cwd: "D:/from-cwd",
        }),
      ),
      path.normalize("D:/from-cwd"),
    );
  });

  it("throws when no workspace root can be resolved", () => {
    assert.throws(
      () => resolveWorkspaceRoot({}),
      /workspace root/i,
    );
  });

  it("uses configured cwd as the final fallback", () => {
    assert.equal(
      path.normalize(
        resolveWorkspaceRoot({
          configuredCwd:
            "D:/configured-workspace",
        }),
      ),
      path.normalize(
        "D:/configured-workspace",
      ),
    );
  });
});

describe("resolveSandboxedPath", () => {
  it("allows relative paths inside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-ws-"));
    await writeFile(path.join(root, "hello.txt"), "hi", "utf8");

    const resolved = await resolveSandboxedPath(root, "hello.txt");
    assert.equal(path.basename(resolved), "hello.txt");
    assert.equal(path.relative(await realpath(root), resolved), "hello.txt");
  });

  it("rejects parent-directory escape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-ws-"));

    await assert.rejects(
      () => resolveSandboxedPath(root, "../outside.txt"),
      /outside the workspace/i,
    );
  });

  it("rejects absolute paths outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-ws-"));
    const outside = path.join(tmpdir(), "outside-stapler.txt");

    await assert.rejects(
      () => resolveSandboxedPath(root, outside),
      /outside the workspace/i,
    );
  });

  it("rejects symlink escape when the target exists", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "stapler-parent-"));
    const root = path.join(parent, "workspace");
    const outsideDir = path.join(parent, "outside");
    await mkdir(root);
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, "secret.txt"), "nope", "utf8");

    const linkPath = path.join(root, "leak");
    try {
      await symlink(outsideDir, linkPath, "junction");
    } catch {
      // Some Windows environments disallow symlinks; skip rather than fail CI.
      return;
    }

    await assert.rejects(
      () => resolveSandboxedPath(root, "leak/secret.txt"),
      /outside the workspace/i,
    );
  });

  it("allows write targets that do not exist yet inside the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-ws-"));
    const rootReal = await realpath(root);
    const resolved = await resolveSandboxedPath(
      root,
      "nested/new-file.txt",
      { allowNonexistent: true },
    );
    assert.equal(
      path.relative(rootReal, resolved),
      path.join("nested", "new-file.txt"),
    );
  });
});
