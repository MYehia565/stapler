import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_PAPERCLIP_API_URL,
  validateStaplerConfig,
} from "../src/server/config.js";
import {
  resolveProfileModel,
} from "../src/server/models.js";
import {
  resolveProviderApiKey,
  resolveProviderBaseUrl,
} from "../src/server/providers.js";
import {
  buildPaperclipApiUrl,
} from "../src/server/tool-gateway.js";

const ENV_KEYS = [
  "STAPLER_WEB_URL_1",
  "STAPLER_API_KEY_1",
  "STAPLER_EXTRA_1",
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

describe("Stapler UI config resolution", () => {
  it("uses the public Signalpost API by default", () => {
    assert.equal(
      DEFAULT_PAPERCLIP_API_URL,
      "https://agent.signalpost.net/api",
    );
    assert.equal(
      buildPaperclipApiUrl(
        DEFAULT_PAPERCLIP_API_URL,
        "tool-gateway/sessions",
      ),
      "https://agent.signalpost.net/api/tool-gateway/sessions",
    );
    assert.equal(
      buildPaperclipApiUrl(
        "http://localhost:3100",
        "tool-gateway/sessions",
      ),
      "http://localhost:3100/api/tool-gateway/sessions",
    );
  });

  it("resolves base URL and removes trailing slashes", () => {
    process.env.STAPLER_WEB_URL_1 =
      "https://example.stapler.test/v1";
    process.env.STAPLER_API_KEY_1 = "k";

    assert.equal(
      resolveProviderBaseUrl({
        baseUrl: "https://example.stapler.test/v1///",
      }),
      "https://example.stapler.test/v1",
    );
  });

  it("resolves a secret-backed STAPLER_API_KEY binding", () => {
    assert.equal(
      resolveProviderApiKey({
        env: {
          STAPLER_WEB_URL_1: "https://example.stapler.test/v1",
          STAPLER_API_KEY_1: "secret-backed-value",
        },
      }),
      "secret-backed-value",
    );
  });

  it("validates schema field boundaries", () => {
    process.env.STAPLER_WEB_URL_1 =
      "https://example.stapler.test/v1";
    process.env.STAPLER_API_KEY_1 = "k";

    assert.deepEqual(
      validateStaplerConfig({
        temperature: 3,
        maxTokens: 0,
        maxToolRounds: 21,
        extraBody: "[1, 2, 3]",
      }),
      [
        "Temperature must be between 0 and 2.",
        "Max output tokens must be a positive integer.",
        "Max tool rounds must be an integer between 1 and 20.",
        "Extra request body must be a JSON object.",
      ],
    );
  });

  it("accepts valid JSON text for extraBody", () => {
    process.env.STAPLER_WEB_URL_1 =
      "https://example.stapler.test/v1";
    process.env.STAPLER_API_KEY_1 = "k";

    assert.deepEqual(
      validateStaplerConfig({
        temperature: 0.5,
        maxTokens: 4096,
        maxToolRounds: 8,
        extraBody: "{\"reasoning_effort\":\"medium\"}",
      }),
      [],
    );
  });

  it("rejects invalid STAPLER_EXTRA_n JSON", () => {
    process.env.STAPLER_WEB_URL_1 =
      "https://example.stapler.test/v1";
    process.env.STAPLER_API_KEY_1 = "k";
    process.env.STAPLER_EXTRA_1 = "[1, 2]";

    assert.match(
      validateStaplerConfig({}).join(" "),
      /STAPLER_EXTRA_1 must be a JSON object/,
    );
  });

  it("accepts a valid STAPLER_EXTRA_n object", () => {
    process.env.STAPLER_WEB_URL_1 =
      "https://example.stapler.test/v1";
    process.env.STAPLER_API_KEY_1 = "k";
    process.env.STAPLER_EXTRA_1 =
      '{"provider":{"order":["Anthropic"]}}';

    assert.deepEqual(validateStaplerConfig({}), []);
  });

  it("resolves stable aliases to discovered model IDs", () => {
    const catalogue = [
      {
        id: "provider/flash-mini",
        label: "Flash Mini",
      },
      {
        id: "provider/pro",
        label: "Pro",
      },
      {
        id: "provider/reasoning",
        label: "Reasoning",
      },
    ];

    assert.equal(
      resolveProfileModel(
        "cheap",
        catalogue,
      ),
      "provider/flash-mini",
    );
    assert.equal(
      resolveProfileModel(
        "standard",
        catalogue,
      ),
      "provider/pro",
    );
    assert.equal(
      resolveProfileModel(
        "reasoning",
        catalogue,
      ),
      "provider/reasoning",
    );
  });
});
