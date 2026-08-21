import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { validateStaplerConfig } from "../src/server/config.js";
import {
  discoverStaplerSlots,
  parsePrefixedModelId,
  providerNameFromWebUrl,
  resolveActiveSlot,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  resolveProviderId,
  resolveProviderIdSource,
  resolveSlotExtra,
} from "../src/server/providers.js";

const ENV_KEYS = [
  "STAPLER_WEB_URL_1",
  "STAPLER_API_KEY_1",
  "STAPLER_WEB_URL_2",
  "STAPLER_API_KEY_2",
  "STAPLER_WEB_URL",
  "STAPLER_API_KEY",
  "STAPLER_PROVIDER",
  "STAPLER_MODEL",
  "STAPLER_EXTRA_1",
  "OPENAI_API_KEY",
];

const originalEnv = new Map<string, string | undefined>();

for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function clearStaplerEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("providerNameFromWebUrl", () => {
  it("extracts brand names from common hosts", () => {
    assert.equal(
      providerNameFromWebUrl("https://api.openai.com/v1"),
      "openai",
    );
    assert.equal(
      providerNameFromWebUrl("https://openrouter.ai/api/v1"),
      "openrouter",
    );
    assert.equal(
      providerNameFromWebUrl("https://api.groq.com/openai/v1"),
      "groq",
    );
    assert.equal(
      providerNameFromWebUrl("http://localhost:4000/v1"),
      "localhost",
    );
    assert.equal(
      providerNameFromWebUrl("http://127.0.0.1:11434/v1"),
      "slot1",
    );
  });
});

describe("discoverStaplerSlots", () => {
  it("discovers numbered slots from STAPLER_* env", () => {
    clearStaplerEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY_1 = "key-1";
    process.env.STAPLER_WEB_URL_2 =
      "https://api.groq.com/openai/v1";
    process.env.STAPLER_API_KEY_2 = "key-2";

    const slots = discoverStaplerSlots({});

    assert.equal(slots.length, 2);
    assert.equal(slots[0]?.id, "openai");
    assert.equal(slots[1]?.id, "groq");
  });

  it("accepts unnumbered slot 1 when _1 is absent", () => {
    clearStaplerEnv();
    process.env.STAPLER_WEB_URL =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY = "openai-key";

    const slots = discoverStaplerSlots({});

    assert.equal(slots.length, 1);
    assert.equal(slots[0]?.id, "openai");
  });

  it("ignores unrelated provider env names", () => {
    clearStaplerEnv();
    process.env.OPENAI_API_KEY = "sk-unrelated";

    assert.deepEqual(discoverStaplerSlots({}), []);
  });

  it("deduplicates colliding provider ids", () => {
    clearStaplerEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY_1 = "k1";
    process.env.STAPLER_WEB_URL_2 =
      "https://proxy.openai.com/v1";
    process.env.STAPLER_API_KEY_2 = "k2";

    const slots = discoverStaplerSlots({});

    assert.equal(slots[0]?.id, "openai");
    assert.equal(slots[1]?.id, "openai-2");
  });
});

describe("active slot resolution", () => {
  function seedTwoSlots(): void {
    clearStaplerEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY_1 = "openai-key";
    process.env.STAPLER_WEB_URL_2 =
      "https://api.groq.com/openai/v1";
    process.env.STAPLER_API_KEY_2 = "groq-key";
  }

  it("prefers model prefix over config.provider", () => {
    seedTwoSlots();
    const resolved = resolveActiveSlot({
      provider: "openai",
      model: "groq::llama-3.3-70b-versatile",
    });

    assert.equal(resolved.slot?.id, "groq");
    assert.equal(resolved.bareModelId, "llama-3.3-70b-versatile");
    assert.equal(resolved.source, "model prefix");
  });

  it("prefers config.provider over STAPLER_PROVIDER", () => {
    seedTwoSlots();
    process.env.STAPLER_PROVIDER = "groq";

    assert.equal(
      resolveProviderId({ provider: "openai" }),
      "openai",
    );
    assert.equal(
      resolveProviderIdSource({ provider: "openai" }),
      "agent config",
    );
  });

  it("uses STAPLER_PROVIDER when agent provider is unset", () => {
    seedTwoSlots();
    process.env.STAPLER_PROVIDER = "groq";

    assert.equal(resolveProviderId({}), "groq");
    assert.equal(
      resolveProviderIdSource({}),
      "STAPLER_PROVIDER",
    );
  });

  it("does not cross-fallback API keys between slots", () => {
    seedTwoSlots();
    assert.equal(
      resolveProviderApiKey({ provider: "openai" }),
      "openai-key",
    );
    assert.equal(
      resolveProviderApiKey({ provider: "groq" }),
      "groq-key",
    );
  });

  it("ignores stale baseUrl from another slot", () => {
    seedTwoSlots();
    assert.equal(
      resolveProviderBaseUrl({
        provider: "groq",
        baseUrl: "https://api.openai.com/v1",
      }),
      "https://api.groq.com/openai/v1",
    );
  });

  it("keeps an intentional custom baseUrl override", () => {
    seedTwoSlots();
    assert.equal(
      resolveProviderBaseUrl({
        provider: "groq",
        baseUrl: "https://proxy.example.test/v1///",
      }),
      "https://proxy.example.test/v1",
    );
  });

  it("reads STAPLER_API_KEY_n from config.env bindings", () => {
    clearStaplerEnv();

    assert.equal(
      resolveProviderApiKey({
        provider: "openai",
        env: {
          STAPLER_WEB_URL_1: "https://api.openai.com/v1",
          STAPLER_API_KEY_1: "bound-key",
        },
      }),
      "bound-key",
    );
  });
});

describe("parsePrefixedModelId", () => {
  it("splits slot::model ids", () => {
    assert.deepEqual(
      parsePrefixedModelId("groq::llama-3.3-70b-versatile"),
      {
        providerId: "groq",
        bareModelId: "llama-3.3-70b-versatile",
      },
    );
    assert.deepEqual(
      parsePrefixedModelId("gpt-4o"),
      {
        providerId: null,
        bareModelId: "gpt-4o",
      },
    );
  });
});

describe("validateStaplerConfig", () => {
  it("requires at least one configured slot", () => {
    clearStaplerEnv();

    assert.match(
      validateStaplerConfig({}).join(" "),
      /STAPLER_WEB_URL_n/,
    );
  });

  it("rejects unknown provider ids", () => {
    process.env.STAPLER_WEB_URL_1 =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY_1 = "k";

    assert.match(
      validateStaplerConfig({ provider: "missing" }).join(" "),
      /not among configured Stapler slots/,
    );
  });
});

describe("resolveSlotExtra", () => {
  it("parses STAPLER_EXTRA_n for the active slot", () => {
    clearStaplerEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY_1 = "k";
    process.env.STAPLER_EXTRA_1 =
      '{"provider":{"order":["Anthropic"]}}';

    assert.deepEqual(resolveSlotExtra({}), {
      provider: { order: ["Anthropic"] },
    });
  });

  it("ignores plaintext runtime.apiKey", () => {
    clearStaplerEnv();
    process.env.STAPLER_WEB_URL_1 =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY_1 = "bound-key";

    assert.equal(
      resolveProviderApiKey({}, { apiKey: "plaintext" }),
      "bound-key",
    );
  });
});
