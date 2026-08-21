import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_REQUEST_TIMEOUT_SEC,
  DEFAULT_RUN_TIMEOUT_SEC,
  MAX_RUN_TIMEOUT_SEC,
  resolveRequestTimeoutSec,
  resolveRunTimeoutSec,
  validateStaplerConfig,
} from "../src/server/config.js";

import { getConfigSchema } from "../src/server/config-schema.js";

const ENV_KEYS = ["STAPLER_WEB_URL_1", "STAPLER_API_KEY_1"];
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

function seedSlot(): void {
  process.env.STAPLER_WEB_URL_1 =
    "https://example.stapler.test/v1";
  process.env.STAPLER_API_KEY_1 = "k";
}

describe("Stapler timeout resolution", () => {
  it("separates the per-request deadline from the run budget", () => {
    assert.equal(
      resolveRequestTimeoutSec(undefined),
      DEFAULT_REQUEST_TIMEOUT_SEC,
    );

    assert.equal(
      resolveRunTimeoutSec(undefined, DEFAULT_REQUEST_TIMEOUT_SEC),
      DEFAULT_RUN_TIMEOUT_SEC,
    );

    assert.ok(
      DEFAULT_RUN_TIMEOUT_SEC > DEFAULT_REQUEST_TIMEOUT_SEC,
      "a tool-using run must outlive a single request",
    );
  });

  it("clamps values into the supported range", () => {
    assert.equal(resolveRequestTimeoutSec(1), 5);
    assert.equal(resolveRequestTimeoutSec(99999), 3600);
    assert.equal(resolveRequestTimeoutSec("120"), 120);
    assert.equal(
      resolveRunTimeoutSec(99999999, 300),
      MAX_RUN_TIMEOUT_SEC,
    );
  });

  it("never lets the run budget undercut one request", () => {
    assert.equal(resolveRunTimeoutSec(60, 900), 900);
  });

  it("validates both timeout fields", () => {
    seedSlot();

    assert.deepEqual(
      validateStaplerConfig({ timeoutSec: 300, runTimeoutSec: 1800 }),
      [],
    );

    assert.match(
      validateStaplerConfig({ timeoutSec: 0 }).join(" "),
      /Request timeout must be an integer/,
    );

    assert.match(
      validateStaplerConfig({ runTimeoutSec: 5 }).join(" "),
      /Run timeout must be an integer/,
    );
  });

  it("exposes both timeouts in the UI schema", () => {
    const keys = getConfigSchema().fields.map((field) => field.key);

    assert.ok(keys.includes("timeoutSec"));
    assert.ok(keys.includes("runTimeoutSec"));
  });
});
