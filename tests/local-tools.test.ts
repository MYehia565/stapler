import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  callLocalTool,
  listLocalTools,
} from "../src/server/local-tools.js";

function ctxFor(workspace: string) {
  return {
    runtime: { workspace },
    agent: {},
    cwd: workspace,
    context: { paperclipWorkspace: { cwd: workspace } },
  } as any;
}

describe("local tools sandbox", () => {
  it("lists OpenAI function schemas for the local tool suite", () => {
    const tools = listLocalTools();
    const names = tools.map((tool) => tool.function.name).sort();
    assert.deepEqual(names, [
      "delete_file",
      "exec_command",
      "glob_files",
      "grep_search",
      "http_fetch",
      "list_dir",
      "list_directory",
      "move_file",
      "read_file",
      "str_replace",
      "web_search",
      "write_file",
    ]);
    for (const tool of tools) {
      assert.equal(tool.type, "function");
      assert.equal(typeof tool.function.parameters, "object");
    }
  });

  it("reads and lists files inside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));
    await writeFile(path.join(root, "hello.txt"), "hello-world", "utf8");

    const listing = (await callLocalTool(ctxFor(root), "list_dir", {
      path: ".",
    })) as Array<{ name: string; type: string }>;

    assert.ok(listing.some((entry) => entry.name === "hello.txt"));

    const file = (await callLocalTool(ctxFor(root), "read_file", {
      path: "hello.txt",
    })) as { content: string };

    assert.equal(file.content, "hello-world");
  });

  it("writes files inside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));
    await callLocalTool(ctxFor(root), "write_file", {
      path: "out.txt",
      content: "written",
    });

    assert.equal(await readFile(path.join(root, "out.txt"), "utf8"), "written");
  });

  it("writes nested files by creating parent directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));
    await callLocalTool(ctxFor(root), "write_file", {
      path: "nested/dir/out.txt",
      content: "nested-ok",
    });

    assert.equal(
      await readFile(path.join(root, "nested", "dir", "out.txt"), "utf8"),
      "nested-ok",
    );
  });

  it("accepts renamed path arguments from provider dialects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));
    await writeFile(path.join(root, "aliased.txt"), "alias-ok", "utf8");

    for (const key of [
      "file_path",
      "absolute_path",
      "target_file",
      "filename",
    ]) {
      const file = (await callLocalTool(ctxFor(root), "read_file", {
        [key]: "aliased.txt",
      })) as { content: string };

      assert.equal(file.content, "alias-ok");
    }

    const listing = (await callLocalTool(ctxFor(root), "list_dir", {
      directory: ".",
    })) as Array<{ name: string }>;
    assert.ok(listing.some((entry) => entry.name === "aliased.txt"));

    await callLocalTool(ctxFor(root), "write_file", {
      file_path: "aliased-out.txt",
      contents: "alias-written",
    });
    assert.equal(
      await readFile(path.join(root, "aliased-out.txt"), "utf8"),
      "alias-written",
    );

    const exec = (await callLocalTool(ctxFor(root), "exec_command", {
      cmd: "node -e \"process.stdout.write('alias-exec')\"",
    })) as { stdout: string };
    assert.match(exec.stdout, /alias-exec/);
  });

  it("names the received keys when a path argument is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));

    await assert.rejects(
      () => callLocalTool(ctxFor(root), "read_file", { pathh: "x.txt" }),
      /path is required.*Received argument keys: pathh/s,
    );
  });

  it("rejects read_file paths outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));

    await assert.rejects(
      () =>
        callLocalTool(ctxFor(root), "read_file", {
          path: "../outside.txt",
        }),
      /outside the workspace/i,
    );
  });

  it("rejects exec_command cwd outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));

    await assert.rejects(
      () =>
        callLocalTool(ctxFor(root), "exec_command", {
          command: "echo hi",
          cwd: path.join(root, ".."),
        }),
      /outside the workspace/i,
    );
  });

  it("times out long-running exec_command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));
    await writeFile(
      path.join(root, "hang.js"),
      "setTimeout(() => {}, 10000);\n",
      "utf8",
    );

    await assert.rejects(
      () =>
        callLocalTool(
          { ...ctxFor(root), execTimeoutMs: 300 },
          "exec_command",
          { command: "node hang.js" },
        ),
      /timed out/i,
    );
  });

  it("edits, searches, and globs inside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));
    await writeFile(path.join(root, "a.ts"), "const alpha = 1;\n", "utf8");
    await writeFile(path.join(root, "b.ts"), "const beta = 2;\n", "utf8");

    const replaced = (await callLocalTool(ctxFor(root), "str_replace", {
      path: "a.ts",
      old_string: "alpha",
      new_string: "gamma",
    })) as { replacements: number };
    assert.equal(replaced.replacements, 1);
    assert.match(await readFile(path.join(root, "a.ts"), "utf8"), /gamma/);

    const grep = (await callLocalTool(ctxFor(root), "grep_search", {
      pattern: "gamma",
    })) as { matches: Array<{ path: string }> };
    assert.ok(grep.matches.some((row) => row.path === "a.ts"));

    const glob = (await callLocalTool(ctxFor(root), "glob_files", {
      pattern: "*.ts",
    })) as { files: string[] };
    assert.ok(glob.files.includes("a.ts"));
    assert.ok(glob.files.includes("b.ts"));
  });

  it("rejects http_fetch to private hosts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stapler-local-"));

    await assert.rejects(
      () =>
        callLocalTool(ctxFor(root), "http_fetch", {
          url: "http://127.0.0.1:9/",
        }),
      /blocked or private host/i,
    );
  });
});
