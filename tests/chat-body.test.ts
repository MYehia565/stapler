import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChatCompletionsBody,
  mergeChatCompletionExtras,
} from "../src/server/chat-body.js";

describe("mergeChatCompletionExtras", () => {
  it("lets agent extra override slot extra", () => {
    const merged = mergeChatCompletionExtras(
      { model: "gpt-4o", messages: [] },
      { provider: { order: ["A"] }, stream: true },
      { provider: { order: ["B"] } },
    );

    assert.deepEqual(merged.provider, { order: ["B"] });
    assert.equal(merged.stream, true);
  });

  it("does not let extra set reserved keys", () => {
    const merged = mergeChatCompletionExtras(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      { model: "hijack", messages: [], tools: [{ type: "function" }] },
      { tools: [{ type: "function" }] },
    );

    assert.equal(merged.model, "gpt-4o");
    assert.deepEqual(merged.messages, [
      { role: "user", content: "hi" },
    ]);
    assert.equal(merged.tools, undefined);
  });

  it("does not override first-class body fields", () => {
    const merged = mergeChatCompletionExtras(
      { model: "gpt-4o", messages: [], temperature: 0.2 },
      { temperature: 0.9, top_p: 0.5 },
      {},
    );

    assert.equal(merged.temperature, 0.2);
    assert.equal(merged.top_p, 0.5);
  });
});

describe("buildChatCompletionsBody", () => {
  it("omits tools when none are registered so extra cannot inject them", () => {
    const body = buildChatCompletionsBody({
      model: "gpt-4o",
      messages: [],
      tools: [],
      temperature: 0.5,
      maxTokens: 100,
      slotExtra: { tools: [{ type: "function" }] },
      agentExtra: {},
    });

    assert.equal(body.tools, undefined);
    assert.equal(body.temperature, 0.5);
    assert.equal(body.max_tokens, 100);
  });
});
