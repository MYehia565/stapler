import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  actionRoundSignature,
  createLoopProtectionState,
  DEFAULT_LOOP_PROTECTION,
  evaluateLoopProtection,
} from "../src/server/loop-protection.js";

function call(name: string, args: string) {
  return {
    function: {
      name,
      arguments: args,
    },
  };
}

describe("loop protection", () => {
  it("soft-nudges after identical action rounds", () => {
    const state = createLoopProtectionState();
    const tools = [call("list_dir", "{\"path\":\".\"}")];

    const first = evaluateLoopProtection(state, {
      toolCalls: tools,
      toolNames: ["list_dir"],
      results: [{ ok: true }],
      failedRound: false,
      roundSignature: "a",
    });
    assert.equal(first.level, "none");

    const second = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["list_dir"],
        results: [{ ok: true }],
        failedRound: false,
        roundSignature: "a",
      },
      {
        ...DEFAULT_LOOP_PROTECTION,
        softAfter: 2,
        sameCallSoftAfter: 99,
      },
    );
    assert.equal(second.level, "soft");
    assert.match(second.message, /soft/i);
    assert.equal(second.abort, false);
  });

  it("balanced mode hard-stops repeated failures but not repeated successes", () => {
    const state = createLoopProtectionState();
    const tools = [call("grep_search", "{\"pattern\":\"x\"}")];

    let decision = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["grep_search"],
        results: [{ ok: false, error: "same" }],
        failedRound: true,
        roundSignature: "fail-sig",
      },
    );
    assert.equal(decision.level, "none");

    decision = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["grep_search"],
        results: [{ ok: false, error: "same" }],
        failedRound: true,
        roundSignature: "fail-sig",
      },
    );
    assert.equal(decision.level, "none");

    decision = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["grep_search"],
        results: [{ ok: false, error: "same" }],
        failedRound: true,
        roundSignature: "fail-sig",
      },
    );
    assert.equal(decision.level, "soft");

    decision = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["grep_search"],
        results: [{ ok: false, error: "same" }],
        failedRound: true,
        roundSignature: "fail-sig",
      },
    );
    assert.equal(decision.level, "hard");
    assert.equal(decision.abort, true);
  });

  it("firm-blocks tools before hard-aborting when strict success repetition continues", () => {
    const state = createLoopProtectionState();
    const tools = [call("grep_search", "{\"pattern\":\"x\"}")];
    const cfg = {
      ...DEFAULT_LOOP_PROTECTION,
      mode: "strict" as const,
      softAfter: 2,
      firmAfter: 3,
      hardAfter: 4,
      sameCallSoftAfter: 99,
      sameCallFirmAfter: 99,
      sameCallHardAfter: 99,
      abortRepeatedSuccesses: true,
      blockRepeatedTools: true,
    };

    let decision = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["grep_search"],
        results: [{ ok: true }],
        failedRound: false,
        roundSignature: "success-sig",
      },
      cfg,
    );
    assert.equal(decision.level, "none");

    decision = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["grep_search"],
        results: [{ ok: true }],
        failedRound: false,
        roundSignature: "success-sig",
      },
      cfg,
    );
    assert.equal(decision.level, "soft");

    decision = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["grep_search"],
        results: [{ ok: true }],
        failedRound: false,
        roundSignature: "success-sig",
      },
      cfg,
    );
    assert.equal(decision.level, "firm");
    assert.ok(decision.newlyBlocked.includes("grep_search"));
    assert.ok(state.blockedTools.has("grep_search"));

    decision = evaluateLoopProtection(
      state,
      {
        toolCalls: tools,
        toolNames: ["grep_search"],
        results: [{ ok: true }],
        failedRound: false,
        roundSignature: "success-sig",
      },
      cfg,
    );
    assert.equal(decision.level, "hard");
    assert.equal(decision.abort, true);
  });

  it("builds a stable action signature from names and arguments", () => {
    assert.equal(
      actionRoundSignature([
        call("read_file", "{\"path\":\"a.txt\"}"),
        call("read_file", "{\"path\":\"b.txt\"}"),
      ]),
      actionRoundSignature([
        call("read_file", "{\"path\":\"a.txt\"}"),
        call("read_file", "{\"path\":\"b.txt\"}"),
      ]),
    );
  });
});
