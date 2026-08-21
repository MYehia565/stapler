import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fetchWithTimeout,
  HttpTimeoutError,
} from "../src/server/http.js";

describe("fetchWithTimeout", () => {
  const originalFetch = globalThis.fetch;

  const restore = () => {
    globalThis.fetch = originalFetch;
  };

  it("aborts a hung request and names the subject", async () => {
    globalThis.fetch = ((
      _url: string,
      init?: RequestInit,
    ) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;

    try {
      await assert.rejects(
        () =>
          fetchWithTimeout("https://provider.invalid/models", {
            timeoutMs: 30,
            label: "Provider model discovery",
          }),
        (error: unknown) => {
          assert.ok(error instanceof HttpTimeoutError);
          assert.match(
            (error as Error).message,
            /Provider model discovery did not respond within/,
          );
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it("reports a caller abort as AbortError, not a timeout", async () => {
    globalThis.fetch = ((
      _url: string,
      init?: RequestInit,
    ) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    try {
      await assert.rejects(
        () =>
          fetchWithTimeout("https://provider.invalid/models", {
            timeoutMs: 60_000,
            label: "Provider model discovery",
            signal: controller.signal,
          }),
        (error: unknown) => {
          assert.ok(!(error instanceof HttpTimeoutError));
          assert.equal((error as Error).name, "AbortError");
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it("passes a successful response through untouched", async () => {
    globalThis.fetch = (async () =>
      new Response('{"ok":true}', {
        status: 200,
      })) as typeof fetch;

    try {
      const response = await fetchWithTimeout(
        "https://provider.invalid/models",
        {
          timeoutMs: 5_000,
          label: "Provider model discovery",
        },
      );

      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"ok":true}');
    } finally {
      restore();
    }
  });
});
