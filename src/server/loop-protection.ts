import type { ReturnedToolCall } from "./tool-call-protocol.js";
import { createHash } from "node:crypto";

export type LoopProtectionLevel = "none" | "soft" | "firm" | "hard";
export type LoopProtectionMode =
  | "off"
  | "advisory"
  | "balanced"
  | "strict"
  | "custom";

export const LOOP_PROTECTION_MODES: LoopProtectionMode[] = [
  "off",
  "advisory",
  "balanced",
  "strict",
  "custom",
];

export interface LoopProtectionConfig {
  mode: LoopProtectionMode;
  /** Identical successful rounds (same calls + same results) before soft nudge. */
  softAfter: number;
  /** Identical successful rounds before blocking repeated tools. */
  firmAfter: number;
  /** Identical failing rounds before aborting. */
  hardAfter: number;
  /** Same tool name + args invocations before soft nudge. */
  sameCallSoftAfter: number;
  /** Same tool name + args before firm-blocking that tool. */
  sameCallFirmAfter: number;
  /** Same failing tool name + args before hard abort. */
  sameCallHardAfter: number;
  /** Whether firm level may block repeated tools for the rest of the run. */
  blockRepeatedTools: boolean;
  /** Whether repeated successful/no-op rounds may hard-abort. */
  abortRepeatedSuccesses: boolean;
}

const LOOP_PROTECTION_PRESETS: Record<
  Exclude<LoopProtectionMode, "custom">,
  LoopProtectionConfig
> = {
  off: {
    mode: "off",
    softAfter: 0,
    firmAfter: 0,
    hardAfter: 0,
    sameCallSoftAfter: 0,
    sameCallFirmAfter: 0,
    sameCallHardAfter: 0,
    blockRepeatedTools: false,
    abortRepeatedSuccesses: false,
  },
  advisory: {
    mode: "advisory",
    softAfter: 3,
    firmAfter: 99,
    hardAfter: 6,
    sameCallSoftAfter: 5,
    sameCallFirmAfter: 99,
    sameCallHardAfter: 12,
    blockRepeatedTools: false,
    abortRepeatedSuccesses: false,
  },
  balanced: {
    mode: "balanced",
    softAfter: 3,
    firmAfter: 5,
    hardAfter: 4,
    sameCallSoftAfter: 5,
    sameCallFirmAfter: 8,
    sameCallHardAfter: 8,
    blockRepeatedTools: true,
    abortRepeatedSuccesses: false,
  },
  strict: {
    mode: "strict",
    softAfter: 2,
    firmAfter: 3,
    hardAfter: 4,
    sameCallSoftAfter: 3,
    sameCallFirmAfter: 5,
    sameCallHardAfter: 8,
    blockRepeatedTools: true,
    abortRepeatedSuccesses: true,
  },
};

export const DEFAULT_LOOP_PROTECTION =
  LOOP_PROTECTION_PRESETS.balanced;

export interface LoopProtectionState {
  previousSuccessSignature: string;
  identicalSuccessCount: number;
  previousFailSignature: string;
  identicalFailCount: number;
  callCounts: Map<string, number>;
  failedCallCounts: Map<string, number>;
  blockedTools: Set<string>;
  lastLevel: LoopProtectionLevel;
}

export interface LoopRoundInput {
  toolCalls: ReturnedToolCall[];
  toolNames: string[];
  results: unknown[];
  failedRound: boolean;
  roundSignature: string;
}

export interface LoopRoundDecision {
  level: LoopProtectionLevel;
  message: string;
  abort: boolean;
  newlyBlocked: string[];
}

export function createLoopProtectionState(): LoopProtectionState {
  return {
    previousSuccessSignature: "",
    identicalSuccessCount: 0,
    previousFailSignature: "",
    identicalFailCount: 0,
    callCounts: new Map(),
    failedCallCounts: new Map(),
    blockedTools: new Set(),
    lastLevel: "none",
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function actionRoundSignature(toolCalls: ReturnedToolCall[]): string {
  return JSON.stringify(
    toolCalls.map((call) => ({
      name: String(call.function?.name ?? ""),
      arguments: String(call.function?.arguments ?? ""),
    })),
  );
}

export function toolCallKey(name: string, argsJson: string): string {
  const digest = createHash("sha1")
    .update(name)
    .update("\0")
    .update(argsJson)
    .digest("hex")
    .slice(0, 12);
  return `${name}#${digest}`;
}

function rank(level: LoopProtectionLevel): number {
  switch (level) {
    case "hard":
      return 3;
    case "firm":
      return 2;
    case "soft":
      return 1;
    default:
      return 0;
  }
}

function maxLevel(
  a: LoopProtectionLevel,
  b: LoopProtectionLevel,
): LoopProtectionLevel {
  return rank(a) >= rank(b) ? a : b;
}

export function getLoopProtectionPreset(
  mode: LoopProtectionMode,
): LoopProtectionConfig {
  if (mode === "custom") {
    return { ...DEFAULT_LOOP_PROTECTION, mode };
  }
  return { ...LOOP_PROTECTION_PRESETS[mode] };
}

export function evaluateLoopProtection(
  state: LoopProtectionState,
  input: LoopRoundInput,
  config: LoopProtectionConfig = DEFAULT_LOOP_PROTECTION,
): LoopRoundDecision {
  if (config.mode === "off") {
    return {
      level: "none",
      message: "",
      abort: false,
      newlyBlocked: [],
    };
  }

  const newlyBlocked: string[] = [];
  let level: LoopProtectionLevel = "none";
  let message = "";
  let abort = false;

  if (input.failedRound && input.roundSignature) {
    if (input.roundSignature === state.previousFailSignature) {
      state.identicalFailCount += 1;
    } else {
      state.previousFailSignature = input.roundSignature;
      state.identicalFailCount = 1;
    }
    state.previousSuccessSignature = "";
    state.identicalSuccessCount = 0;
  } else if (input.roundSignature) {
    if (input.roundSignature === state.previousSuccessSignature) {
      state.identicalSuccessCount += 1;
    } else {
      state.previousSuccessSignature = input.roundSignature;
      state.identicalSuccessCount = 1;
    }
    state.previousFailSignature = "";
    state.identicalFailCount = 0;
  }

  let maxSameCall = 0;
  let maxSameFailedCall = 0;
  const hotTools = new Set<string>();

  for (const call of input.toolCalls) {
    const name = String(call.function?.name ?? "").trim();
    if (!name) {
      continue;
    }

    const key = toolCallKey(name, String(call.function?.arguments ?? ""));
    const next = (state.callCounts.get(key) ?? 0) + 1;
    state.callCounts.set(key, next);
    maxSameCall = Math.max(maxSameCall, next);

    if (input.failedRound) {
      const failedNext =
        (state.failedCallCounts.get(key) ?? 0) + 1;
      state.failedCallCounts.set(key, failedNext);
      maxSameFailedCall = Math.max(
        maxSameFailedCall,
        failedNext,
      );
    }

    if (
      config.blockRepeatedTools &&
      next >= config.sameCallFirmAfter
    ) {
      hotTools.add(name);
    }
  }

  if (
    config.hardAfter > 0 &&
    (state.identicalFailCount >= config.hardAfter ||
      maxSameFailedCall >= config.sameCallHardAfter ||
      (config.abortRepeatedSuccesses &&
        state.identicalSuccessCount >= config.hardAfter))
  ) {
    level = "hard";
    abort = true;
    message =
      state.identicalFailCount >= config.hardAfter
        ? `Loop protection (hard): the same failing tool round repeated ${state.identicalFailCount} times.`
        : maxSameFailedCall >= config.sameCallHardAfter
          ? `Loop protection (hard): the same failing tool call repeated ${maxSameFailedCall} times without changing arguments.`
          : `Loop protection (hard): the same successful tool round repeated ${state.identicalSuccessCount} times without any new result.`;
  } else if (
    config.firmAfter > 0 &&
    (state.identicalFailCount >= config.firmAfter ||
      state.identicalSuccessCount >= config.firmAfter ||
      maxSameCall >= config.sameCallFirmAfter)
  ) {
    level = "firm";
    const toBlock =
      config.blockRepeatedTools
        ? hotTools.size > 0
          ? [...hotTools]
          : [...new Set(input.toolNames.filter(Boolean))]
        : [];

    for (const name of toBlock) {
      if (!state.blockedTools.has(name)) {
        state.blockedTools.add(name);
        newlyBlocked.push(name);
      }
    }

    message =
      newlyBlocked.length > 0
        ? `Loop protection (firm): blocked repeated tools for the rest of this run: ${newlyBlocked.join(", ")}. Use a different approach or finish with a text answer.`
        : `Loop protection (firm): repeated tool usage is no longer helping. Change arguments, switch tools, or conclude.`;
  } else if (
    config.softAfter > 0 &&
    (state.identicalFailCount >= config.softAfter ||
      state.identicalSuccessCount >= config.softAfter ||
      maxSameCall >= config.sameCallSoftAfter)
  ) {
    level = "soft";
    message =
      `Loop protection (soft): repeated tool usage is not producing new progress. Avoid the same tool with the same arguments unless the next result should differ.`;
  }

  state.lastLevel = maxLevel(state.lastLevel, level);

  return {
    level,
    message,
    abort,
    newlyBlocked,
  };
}

export function loopBlockedToolResult(toolName: string): unknown {
  return {
    ok: false,
    error:
      `Tool "${toolName}" is blocked for the rest of this run by loop protection (repeated identical calls).`,
    warning:
      "Choose a different tool, change arguments meaningfully, or finish with a text answer.",
  };
}

export function hashLoopPayload(value: unknown): string {
  return createHash("sha1").update(stableStringify(value)).digest("hex");
}
