import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  agentsFromListPayload,
  formatMentionRewriteWarning,
  rewriteBareAgentMentions,
} from "../src/server/agent-mentions.js";

const roster = [
  { id: "id-acq", name: "Acquisition Engine" },
  { id: "id-ps", name: "Product Strategist" },
  { id: "id-aip", name: "AI / Product Engineer" },
  { id: "id-ga", name: "Growth Analyst" },
  { id: "id-gc", name: "Growth Commander" },
  { id: "id-ce", name: "Content Engine" },
];

describe("agentsFromListPayload", () => {
  it("accepts bare arrays and wrapped shapes", () => {
    assert.equal(agentsFromListPayload(roster).length, 6);
    assert.equal(
      agentsFromListPayload({ agents: roster }).length,
      6,
    );
  });
});

describe("rewriteBareAgentMentions", () => {
  it("rewrites bare @roster names to agent:// links", () => {
    const input =
      "ICP rubric → @Product Strategist + @AI / Product Engineer. Tracking → @Growth Analyst.";
    const result = rewriteBareAgentMentions(input, roster);

    assert.match(
      result.body,
      /\[@Product Strategist\]\(agent:\/\/id-ps\)/,
    );
    assert.match(
      result.body,
      /\[@AI \/ Product Engineer\]\(agent:\/\/id-aip\)/,
    );
    assert.match(
      result.body,
      /\[@Growth Analyst\]\(agent:\/\/id-ga\)/,
    );
    assert.equal(result.resolved.length, 3);
    assert.deepEqual(result.unresolved, []);
  });

  it("leaves already-structured mentions alone", () => {
    const input =
      "Ping [@Growth Analyst](agent://id-ga) and also @Content Engine.";
    const result = rewriteBareAgentMentions(input, roster);

    assert.match(result.body, /\[@Growth Analyst\]\(agent:\/\/id-ga\)/);
    assert.match(
      result.body,
      /\[@Content Engine\]\(agent:\/\/id-ce\)/,
    );
    assert.equal(result.resolved.length, 1);
    assert.equal(result.alreadyStructured, 1);
  });

  it("records unknown bare mentions as unresolved", () => {
    const result = rewriteBareAgentMentions(
      "Ask @Unknown Bot to help.",
      roster,
    );

    assert.match(result.body, /@Unknown Bot/);
    assert.deepEqual(result.unresolved, ["Unknown Bot"]);
    assert.equal(result.resolved.length, 0);
  });

  it("does not wake via bare @ when warning is formatted", () => {
    const result = rewriteBareAgentMentions(
      "Next action: @NoSuch Agent please take this.",
      roster,
    );
    const warning = formatMentionRewriteWarning(result);
    assert.match(String(warning), /Unknown @mention/);
    assert.match(String(warning), /agent:\/\/uuid/);
  });
});
