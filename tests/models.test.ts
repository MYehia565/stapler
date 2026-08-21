import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createServerAdapter } from "../src/server/index.js";

const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  "STAPLER_WEB_URL_1",
  "STAPLER_API_KEY_1",
  "STAPLER_WEB_URL_2",
  "STAPLER_API_KEY_2",
  "STAPLER_PROVIDER",
  "STAPLER_MODEL",
  "OPENAI_API_KEY",
];

const originalEnv = new Map<string, string | undefined>();

for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

afterEach(() => {
  globalThis.fetch = originalFetch;

  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("Stapler model hooks", () => {
  it("preserves vendor-prefixed catalogue ids", async () => {
    clearEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://openrouter.ai/api/v1";
    process.env.STAPLER_API_KEY_1 = "test-key";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "openai/gpt-4o" }],
        }),
        { status: 200 },
      );

    const discovered =
      await createServerAdapter().listModels?.();

    assert.deepEqual(
      discovered?.map((model) => model.id),
      ["openai/gpt-4o"],
    );
  });

  it("returns a single-slot catalogue unprefixed", async () => {
    clearEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://models.stapler.test/v1/";
    process.env.STAPLER_API_KEY_1 = "test-key";

    const catalogue = Array.from(
      { length: 3 },
      (_, index) => ({
        id: `model-${index + 1}`,
        display_name: `Model ${index + 1}`,
      }),
    );

    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        "https://models.stapler.test/v1/models",
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-key",
      );

      return new Response(
        JSON.stringify({ data: catalogue }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    };

    const discovered =
      await createServerAdapter().listModels?.();

    assert.equal(discovered?.length, 3);
    assert.deepEqual(
      discovered?.map((model) => model.id),
      catalogue.map((model) => model.id),
    );
  });

  it("unions prefixed models from multiple slots", async () => {
    clearEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY_1 = "openai-key";
    process.env.STAPLER_WEB_URL_2 =
      "https://api.groq.com/openai/v1";
    process.env.STAPLER_API_KEY_2 = "groq-key";

    globalThis.fetch = async (input) => {
      const url = String(input);

      if (url.includes("openai.com")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          data: [{ id: "llama-3.3-70b-versatile" }],
        }),
        { status: 200 },
      );
    };

    const discovered =
      await createServerAdapter().listModels?.();

    assert.deepEqual(
      discovered?.map((model) => model.id).sort(),
      ["groq::llama-3.3-70b-versatile", "openai::gpt-4o"],
    );
  });

  it("detects a configured model and exposes union candidates", async () => {
    clearEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://models.stapler.test/v1";
    process.env.STAPLER_API_KEY_1 = "test-key";
    process.env.STAPLER_MODEL = "model-b";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "model-a" },
            { id: "model-b" },
          ],
        }),
        { status: 200 },
      );

    const detected =
      await createServerAdapter().detectModel?.();

    assert.equal(detected?.model, "model-b");
    assert.equal(detected?.provider, "stapler");
    assert.match(detected?.source ?? "", /STAPLER_MODEL/);
    assert.deepEqual(detected?.candidates, [
      "model-a",
      "model-b",
    ]);
  });

  it("does not claim live detection without Stapler slots", async () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "unrelated";

    const detected =
      await createServerAdapter().detectModel?.();

    assert.equal(detected, null);
  });
});
