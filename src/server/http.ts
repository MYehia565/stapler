/**
 * Every outbound request in this adapter must be bounded. An unbounded fetch
 * against a hung endpoint makes a Paperclip run look frozen: the daemon waits
 * on a socket that never returns, no output reaches the run log, and the run
 * only ends when the operator kills it.
 */

/** GET /models lookups block model selection, so they fail fast. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

/** Tool Gateway setup runs before the first provider request. */
export const GATEWAY_SETUP_TIMEOUT_MS = 20_000;

/** Gateway tool calls carry a server-side timeoutMs of 120s; allow margin. */
export const GATEWAY_CALL_TIMEOUT_MS = 130_000;

/** Session revocation is best effort and must not delay run teardown. */
export const GATEWAY_REVOKE_TIMEOUT_MS = 10_000;

export class HttpTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(
      `${label} did not respond within ${Math.round(timeoutMs / 1000)}s.`,
    );

    this.name = "HttpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface TimedFetchInit extends RequestInit {
  /** Milliseconds before this single request is aborted. */
  timeoutMs: number;
  /** Human-readable subject used in the timeout message. */
  label: string;
}

/**
 * fetch with a per-request deadline that still honours a caller-supplied
 * signal. A caller abort propagates as AbortError so run-level timeout
 * handling stays intact; only the local deadline raises HttpTimeoutError.
 */
export async function fetchWithTimeout(
  url: string,
  init: TimedFetchInit,
): Promise<Response> {
  const {
    timeoutMs,
    label,
    signal: callerSignal,
    ...rest
  } = init;

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // A pending timer must never hold the daemon process open.
  (timer as unknown as { unref?: () => void }).unref?.();

  const forwardAbort = () => controller.abort();

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", forwardAbort, {
        once: true,
      });
    }
  }

  try {
    return await fetch(url, {
      ...rest,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut && !callerSignal?.aborted) {
      throw new HttpTimeoutError(label, timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}
