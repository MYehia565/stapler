import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  modelProfiles,
  models,
  type,
  label,
} from "../src/index.js";
import { getConfigSchema } from "../src/server/config-schema.js";
import { createServerAdapter } from "../src/server/index.js";

const ENV_KEYS = [
  "STAPLER_WEB_URL_1",
  "STAPLER_API_KEY_1",
  "STAPLER_WEB_URL_2",
  "STAPLER_API_KEY_2",
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

describe("Stapler Paperclip UI contract", () => {
  it("uses standard as the primary default and exposes a cheap profile", () => {
    assert.equal(models[0]?.id, "standard");
    assert.equal(type, "stapler");
    assert.equal(label, "Stapler");
    assert.deepEqual(modelProfiles, [
      {
        key: "cheap",
        label: "Cheap",
        description:
          "Use the active slot's cost-efficient model lane while preserving the primary model.",
        adapterConfig: {
          model: "cheap",
        },
        source: "adapter_default",
      },
    ]);
  });

  it("returns a dynamic declarative schema from configured slots", () => {
    delete process.env.STAPLER_WEB_URL_1;
    delete process.env.STAPLER_API_KEY_1;
    delete process.env.STAPLER_WEB_URL_2;
    delete process.env.STAPLER_API_KEY_2;

    process.env.STAPLER_WEB_URL_1 =
      "https://api.openai.com/v1";
    process.env.STAPLER_API_KEY_1 = "k1";
    process.env.STAPLER_WEB_URL_2 =
      "https://api.groq.com/openai/v1";
    process.env.STAPLER_API_KEY_2 = "k2";

    const schema = getConfigSchema();
    const keys = schema.fields.map((field) => field.key);

    assert.deepEqual(keys, [
      "provider",
      "baseUrl",
      "cwd",
      "instructionsFilePath",
      "promptTemplate",
      "temperature",
      "maxTokens",
      "maxToolRounds",
      "loopProtectionMode",
      "timeoutSec",
      "runTimeoutSec",
      "loopSoftAfter",
      "loopFirmAfter",
      "loopHardAfter",
      "loopSameCallSoftAfter",
      "loopSameCallFirmAfter",
      "loopSameCallHardAfter",
      "loopBlockRepeatedTools",
      "loopAbortRepeatedSuccesses",
      "extraBody",
      "paperclipApiUrl",
    ]);

    const providerField = schema.fields.find(
      (field) => field.key === "provider",
    );
    assert.equal(providerField?.type, "select");
    assert.equal(providerField?.default, "openai");
    assert.deepEqual(
      providerField?.options?.map((option) => option.value),
      ["openai", "groq"],
    );
    assert.match(
      providerField?.hint ?? "",
      /STAPLER_WEB_URL_n/,
    );

    const baseUrlField = schema.fields.find(
      (field) => field.key === "baseUrl",
    );

    assert.equal(baseUrlField?.default, "");
    assert.deepEqual(
      baseUrlField?.options?.map((option) => option.value),
      [
        "https://api.openai.com/v1",
        "https://api.groq.com/openai/v1",
      ],
    );
  });

  it("registers schema and model-profile hooks on the server module", () => {
    const adapter = createServerAdapter();

    assert.equal(adapter.type, "stapler");
    assert.equal(typeof adapter.getConfigSchema, "function");
    assert.deepEqual(adapter.modelProfiles, modelProfiles);
    assert.equal(adapter.models?.[0]?.id, "standard");
  });

  it("enables instructions bundle, skills, and local agent JWT", () => {
    const adapter = createServerAdapter();

    assert.equal(adapter.supportsInstructionsBundle, true);
    assert.equal(adapter.supportsLocalAgentJwt, true);
    assert.equal(
      adapter.instructionsPathKey,
      "instructionsFilePath",
    );
    assert.equal(typeof adapter.listSkills, "function");
    assert.equal(typeof adapter.syncSkills, "function");
  });

  it("does not expose Claude-only controls", () => {
    const keys = new Set(getConfigSchema().fields.map((field) => field.key));

    for (const key of [
      "command",
      "engine",
      "chrome",
      "dangerouslySkipPermissions",
      "extraArgs",
      "graceSec",
    ]) {
      assert.equal(keys.has(key), false);
    }
  });
});
