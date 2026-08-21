import { parseExtraBody } from "./config.js";

export const RESERVED_CHAT_COMPLETION_KEYS = [
  "model",
  "messages",
  "tools",
] as const;

const reserved = new Set<string>(RESERVED_CHAT_COMPLETION_KEYS);

/**
 * Merge slot extra JSON then agent extraBody onto a /chat/completions body.
 * Reserved keys cannot be introduced or overridden from extra.
 * First-class body fields (temperature, max_tokens, …) win over extra.
 */
export function mergeChatCompletionExtras(
  body: Record<string, unknown>,
  slotExtra: Record<string, unknown>,
  agentExtra: unknown,
): Record<string, unknown> {
  const merged = { ...body };
  const extra = {
    ...slotExtra,
    ...parseExtraBody(agentExtra),
  };

  for (const [key, value] of Object.entries(extra)) {
    if (reserved.has(key) || key in merged) {
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

export function buildChatCompletionsBody(input: {
  model: string;
  messages: unknown[];
  tools: unknown[];
  temperature: unknown;
  maxTokens: unknown;
  slotExtra: Record<string, unknown>;
  agentExtra: unknown;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
  };

  if (input.tools.length > 0) {
    body.tools = input.tools;
  }

  const temperature = Number(input.temperature);

  if (
    Number.isFinite(temperature) &&
    temperature >= 0 &&
    temperature <= 2
  ) {
    body.temperature = temperature;
  }

  const maxTokens = Number(input.maxTokens);

  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_tokens = Math.min(Math.floor(maxTokens), 200_000);
  }

  return mergeChatCompletionExtras(
    body,
    input.slotExtra,
    input.agentExtra,
  );
}
