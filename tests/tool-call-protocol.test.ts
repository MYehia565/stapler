import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isToolResultFailure,
  looksLikeTextToolCall,
  normalizeReturnedToolCalls,
  parseToolArguments,
  resolveDeclaredToolName,
  toolRoundSignature,
} from "../src/server/tool-call-protocol.js";

describe("tool-call protocol", () => {
  const declared =
    new Set([
      "read_file",
      "exec_command",
      "paperclip_get_issue",
    ]);

  it("preserves exact declared function names", () => {
    assert.equal(
      resolveDeclaredToolName(
        "read_file",
        declared,
      ),
      "read_file",
    );
  });

  it("removes provider namespaces only for a declared function", () => {
    assert.equal(
      resolveDeclaredToolName(
        "default_api:read_file",
        declared,
      ),
      "read_file",
    );
    assert.equal(
      resolveDeclaredToolName(
        "cmd:default_api:read_file",
        declared,
      ),
      "read_file",
    );
    assert.equal(
      resolveDeclaredToolName(
        "unknown_api:delete_everything",
        declared,
      ),
      "unknown_api:delete_everything",
    );
  });

  it("creates stable signatures for repeated-round detection", () => {
    const calls = [
      {
        function: {
          name: "default_api:read_file",
          arguments: "{\"path\":\"README.md\"}",
        },
      },
    ];

    assert.equal(
      toolRoundSignature(calls, [{ ok: false, error: "missing" }]),
      toolRoundSignature(calls, [{ ok: false, error: "missing" }]),
    );
    assert.notEqual(
      toolRoundSignature(calls, [{ ok: false, error: "missing" }]),
      toolRoundSignature(calls, [{ ok: true, content: "present" }]),
    );
  });

  it("normalizes replay IDs and names while preserving provider metadata", () => {
    const normalized = normalizeReturnedToolCalls(
      [
        {
          thought_signature: "gemini-signature",
          function: {
            name: "default_api:read_file",
            arguments: { path: "README.md" },
            provider_meta: "keep-me",
          },
        },
      ],
      declared,
      2,
    );

    assert.deepEqual(normalized, [
      {
        id: "tool-2-0-read_file",
        type: "function",
        thought_signature: "gemini-signature",
        function: {
          name: "read_file",
          arguments: "{\"path\":\"README.md\"}",
          provider_meta: "keep-me",
        },
      },
    ]);
  });

  it("reports malformed arguments instead of silently using an empty object", () => {
    assert.deepEqual(
      parseToolArguments("{path:README.md}"),
      {
        ok: false,
        error:
          "Tool arguments must be a valid JSON object.",
      },
    );
    assert.deepEqual(
      parseToolArguments({ path: "README.md" }),
      {
        ok: true,
        args: { path: "README.md" },
      },
    );
  });

  it("recognizes structured tool failures", () => {
    assert.equal(
      isToolResultFailure({
        ok: false,
        error: "path is required",
      }),
      true,
    );
    assert.equal(
      isToolResultFailure({
        path: "README.md",
        content: "ok",
      }),
      false,
    );
  });

  it("recognizes namespaced text pretending to be a tool call", () => {
    assert.equal(
      looksLikeTextToolCall(
        "cmd:default_api:read_file{path:README.md}",
      ),
      true,
    );
    assert.equal(
      looksLikeTextToolCall(
        "I read the file and completed the task.",
      ),
      false,
    );
    assert.equal(
      looksLikeTextToolCall(
        "I used exec_command to run the tests.",
      ),
      false,
    );
  });
});
