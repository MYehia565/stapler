import {
  discoverStaplerSlots,
  isValidProviderId,
  resolveProviderBaseUrl,
  slotExtraValidationErrors,
} from "./providers.js";
import {
  getLoopProtectionPreset,
  LOOP_PROTECTION_MODES,
  type LoopProtectionConfig,
  type LoopProtectionMode,
} from "./loop-protection.js";

export const DEFAULT_PAPERCLIP_API_URL =
  "https://agent.signalpost.net/api";

export const DEFAULT_REQUEST_TIMEOUT_SEC = 300;
export const MIN_REQUEST_TIMEOUT_SEC = 5;
export const MAX_REQUEST_TIMEOUT_SEC = 3600;

export const DEFAULT_RUN_TIMEOUT_SEC = 7200;
export const MIN_RUN_TIMEOUT_SEC = 30;
export const MAX_RUN_TIMEOUT_SEC = 21600;

export const DEFAULT_MAX_TOOL_ROUNDS = 1000;
export const MIN_MAX_TOOL_ROUNDS = 1;
export const MAX_MAX_TOOL_ROUNDS = 1000;

function parsePositiveInt(
  value: unknown,
): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseBooleanLike(
  value: unknown,
): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized =
    value.trim().toLowerCase();
  if (
    normalized === "true" ||
    normalized === "on" ||
    normalized === "yes"
  ) {
    return true;
  }
  if (
    normalized === "false" ||
    normalized === "off" ||
    normalized === "no"
  ) {
    return false;
  }
  return null;
}

export function resolveLoopProtectionMode(
  value: unknown,
): LoopProtectionMode {
  const mode =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  return (
    LOOP_PROTECTION_MODES.find(
      (entry) => entry === mode,
    ) ?? "balanced"
  );
}

export function resolveLoopProtectionConfig(
  config: Record<string, unknown>,
): LoopProtectionConfig {
  const mode =
    resolveLoopProtectionMode(
      config.loopProtectionMode,
    );
  const base =
    getLoopProtectionPreset(mode);

  return {
    ...base,
    mode,
    softAfter:
      parsePositiveInt(config.loopSoftAfter) ??
      base.softAfter,
    firmAfter:
      parsePositiveInt(config.loopFirmAfter) ??
      base.firmAfter,
    hardAfter:
      parsePositiveInt(config.loopHardAfter) ??
      base.hardAfter,
    sameCallSoftAfter:
      parsePositiveInt(
        config.loopSameCallSoftAfter,
      ) ?? base.sameCallSoftAfter,
    sameCallFirmAfter:
      parsePositiveInt(
        config.loopSameCallFirmAfter,
      ) ?? base.sameCallFirmAfter,
    sameCallHardAfter:
      parsePositiveInt(
        config.loopSameCallHardAfter,
      ) ?? base.sameCallHardAfter,
    blockRepeatedTools:
      parseBooleanLike(
        config.loopBlockRepeatedTools,
      ) ?? base.blockRepeatedTools,
    abortRepeatedSuccesses:
      parseBooleanLike(
        config.loopAbortRepeatedSuccesses,
      ) ?? base.abortRepeatedSuccesses,
  };
}

export function resolveRequestTimeoutSec(
  value: unknown,
): number {
  const timeoutSec = Math.floor(Number(value));

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_SEC;
  }

  return Math.min(
    Math.max(timeoutSec, MIN_REQUEST_TIMEOUT_SEC),
    MAX_REQUEST_TIMEOUT_SEC,
  );
}

export function resolveRunTimeoutSec(
  value: unknown,
  requestTimeoutSec: number,
): number {
  const runTimeoutSec = Math.floor(Number(value));

  const resolved =
    !Number.isFinite(runTimeoutSec) || runTimeoutSec <= 0
      ? DEFAULT_RUN_TIMEOUT_SEC
      : Math.min(
          Math.max(runTimeoutSec, MIN_RUN_TIMEOUT_SEC),
          MAX_RUN_TIMEOUT_SEC,
        );

  return Math.max(resolved, requestTimeoutSec);
}

export function parseExtraBody(
  value: unknown,
): Record<string, unknown> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  try {
    const parsed: unknown =
      JSON.parse(value);

    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function validateStaplerConfig(
  config: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const slots = discoverStaplerSlots(config);

  if (!slots.length) {
    errors.push(
      "No LLM provider slots configured. Bind STAPLER_WEB_URL_n and STAPLER_API_KEY_n on the Paperclip server (or in Secret access), then restart.",
    );
  }

  errors.push(...slotExtraValidationErrors(config));

  if (
    config.provider !== undefined &&
    config.provider !== "" &&
    !isValidProviderId(config.provider, config)
  ) {
    errors.push(
      `Provider "${String(config.provider)}" is not among configured Stapler slots.`,
    );
  }

  const baseUrl = resolveProviderBaseUrl(config);

  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);

      if (
        parsed.protocol !== "http:" &&
        parsed.protocol !== "https:"
      ) {
        errors.push(
          "Base URL must use http or https.",
        );
      }
    } catch {
      errors.push(
        "Base URL must be a valid URL.",
      );
    }
  }

  if (config.temperature !== undefined) {
    const temperature =
      Number(config.temperature);

    if (
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      errors.push(
        "Temperature must be between 0 and 2.",
      );
    }
  }

  if (config.maxTokens !== undefined) {
    const maxTokens =
      Number(config.maxTokens);

    if (
      !Number.isInteger(maxTokens) ||
      maxTokens <= 0
    ) {
      errors.push(
        "Max output tokens must be a positive integer.",
      );
    }
  }

  if (config.maxToolRounds !== undefined) {
    const maxToolRounds =
      Number(config.maxToolRounds);

    if (
      !Number.isInteger(maxToolRounds) ||
      maxToolRounds < MIN_MAX_TOOL_ROUNDS ||
      maxToolRounds > MAX_MAX_TOOL_ROUNDS
    ) {
      errors.push(
        `Max tool rounds must be an integer between ${MIN_MAX_TOOL_ROUNDS} and ${MAX_MAX_TOOL_ROUNDS}.`,
      );
    }
  }

  if (config.timeoutSec !== undefined) {
    const timeoutSec =
      Number(config.timeoutSec);

    if (
      !Number.isInteger(timeoutSec) ||
      timeoutSec < MIN_REQUEST_TIMEOUT_SEC ||
      timeoutSec > MAX_REQUEST_TIMEOUT_SEC
    ) {
      errors.push(
        `Request timeout must be an integer between ${MIN_REQUEST_TIMEOUT_SEC} and ${MAX_REQUEST_TIMEOUT_SEC} seconds.`,
      );
    }
  }

  if (config.runTimeoutSec !== undefined) {
    const runTimeoutSec =
      Number(config.runTimeoutSec);

    if (
      !Number.isInteger(runTimeoutSec) ||
      runTimeoutSec < MIN_RUN_TIMEOUT_SEC ||
      runTimeoutSec > MAX_RUN_TIMEOUT_SEC
    ) {
      errors.push(
        `Run timeout must be an integer between ${MIN_RUN_TIMEOUT_SEC} and ${MAX_RUN_TIMEOUT_SEC} seconds.`,
      );
    }
  }

  if (
    config.loopProtectionMode !== undefined &&
    !LOOP_PROTECTION_MODES.includes(
      String(config.loopProtectionMode)
        .trim()
        .toLowerCase() as LoopProtectionMode,
    )
  ) {
    errors.push(
      `Loop protection mode must be one of: ${LOOP_PROTECTION_MODES.join(", ")}.`,
    );
  }

  const loopThresholdFields = [
    "loopSoftAfter",
    "loopFirmAfter",
    "loopHardAfter",
    "loopSameCallSoftAfter",
    "loopSameCallFirmAfter",
    "loopSameCallHardAfter",
  ] as const;

  for (const field of loopThresholdFields) {
    if (
      config[field] !== undefined &&
      parsePositiveInt(config[field]) === null
    ) {
      errors.push(
        `${field} must be a positive integer.`,
      );
    }
  }

  for (const field of [
    "loopBlockRepeatedTools",
    "loopAbortRepeatedSuccesses",
  ] as const) {
    if (
      config[field] !== undefined &&
      parseBooleanLike(config[field]) === null
    ) {
      errors.push(
        `${field} must be on/off (or true/false).`,
      );
    }
  }

  const loopConfig =
    resolveLoopProtectionConfig(config);

  const ordering = [
    loopConfig.softAfter <= loopConfig.firmAfter,
    loopConfig.sameCallSoftAfter <=
      loopConfig.sameCallFirmAfter,
    loopConfig.sameCallFirmAfter <=
      loopConfig.sameCallHardAfter,
  ];

  if (loopConfig.abortRepeatedSuccesses) {
    ordering.push(
      loopConfig.firmAfter <= loopConfig.hardAfter,
    );
  }

  if (!ordering.every(Boolean)) {
    errors.push(
      "Loop protection thresholds must increase from soft to firm to hard.",
    );
  }

  if (
    typeof config.extraBody === "string" &&
    config.extraBody.trim()
  ) {
    try {
      const parsed: unknown =
        JSON.parse(config.extraBody);

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        errors.push(
          "Extra request body must be a JSON object.",
        );
      }
    } catch {
      errors.push(
        "Extra request body must be valid JSON.",
      );
    }
  } else if (
    config.extraBody !== undefined &&
    (
      !config.extraBody ||
      typeof config.extraBody !== "object" ||
      Array.isArray(config.extraBody)
    )
  ) {
    errors.push(
      "Extra request body must be a JSON object.",
    );
  }

  return errors;
}
