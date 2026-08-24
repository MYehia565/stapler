import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dispatchToolCall } from "../src/server/dispatch.js";
import { isLocalToolName } from "../src/server/local-tools.js";

describe("isLocalToolName", () => {
  it("accepts only the local allowlist", () => {
    assert.equal(isLocalToolName("exec_command"), true);
    assert.equal(isLocalToolName("read_file"), true);
    assert.equal(isLocalToolName("write_file"), true);
    assert.equal(isLocalToolName("str_replace"), true);
    assert.equal(isLocalToolName("grep_search"), true);
    assert.equal(isLocalToolName("glob_files"), true);
    assert.equal(isLocalToolName("http_fetch"), true);
    assert.equal(isLocalToolName("web_search"), true);
    assert.equal(isLocalToolName("list_dir"), true);
    assert.equal(isLocalToolName("list_directory"), true);
  });

  it("does not treat paperclip_* as local tools", () => {
    assert.equal(isLocalToolName("paperclip_get_company"), false);
    assert.equal(isLocalToolName("paperclip_list_issues"), false);
    assert.equal(isLocalToolName("paperclip_get_issue"), false);
  });
});

describe("dispatchToolCall routing", () => {
  it("returns a structured warning for gateway tools without a session", async () => {
    const result = (await dispatchToolCall(
      { context: {} } as any,
      null,
      "paperclip_list_issues",
      {},
    )) as { ok: boolean; warning?: string; error?: string };

    assert.equal(result.ok, false);
    assert.match(String(result.error), /gateway/i);
    assert.match(String(result.warning), /local workspace tools/i);
  });
});
