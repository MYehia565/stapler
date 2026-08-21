export interface ReturnedToolCall {
  id?: unknown;
  type?: unknown;
  [key: string]: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
    [key: string]: unknown;
  };
}

/**
 * Some OpenAI-compatible hosts namespace a function name in responses
 * (for example, "default_api:read_file"). Resolve the suffix only when it
 * exactly matches a function that was declared in the request.
 */
export function resolveDeclaredToolName(
  returnedName: string,
  declaredNames: ReadonlySet<string>,
): string {
  if (declaredNames.has(returnedName)) {
    return returnedName;
  }

  const segments =
    returnedName.split(":");

  for (
    let index = 1;
    index < segments.length;
    index += 1
  ) {
    const candidate =
      segments.slice(index).join(":");

    if (declaredNames.has(candidate)) {
      return candidate;
    }
  }

  return returnedName;
}

export function toolRoundSignature(
  toolCalls: ReturnedToolCall[],
  results: unknown[] = [],
): string {
  return JSON.stringify(
    {
      calls: toolCalls.map((call) => ({
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "",
      })),
      results,
    },
  );
}

export function normalizeReturnedToolCalls(
  toolCalls: ReturnedToolCall[],
  declaredNames: ReadonlySet<string>,
  round: number,
): ReturnedToolCall[] {
  return toolCalls.map((call, index) => {
    const returnedName =
      typeof call.function?.name === "string"
        ? call.function.name.trim()
        : "";
    const name =
      resolveDeclaredToolName(
        returnedName,
        declaredNames,
      );
    const rawArguments =
      call.function?.arguments;
    const argumentsValue =
      rawArguments &&
      typeof rawArguments === "object" &&
      !Array.isArray(rawArguments)
        ? JSON.stringify(rawArguments)
        : typeof rawArguments === "string"
          ? rawArguments
          : "{}";
    const id =
      typeof call.id === "string" &&
      call.id.trim()
        ? call.id.trim()
        : `tool-${round}-${index}-${name || "unknown"}`;

    return {
      ...call,
      id,
      type: "function",
      function: {
        ...call.function,
        name,
        arguments: argumentsValue,
      },
    };
  });
}

export type ParsedToolArguments =
  | {
      ok: true;
      args: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

export function parseToolArguments(
  value: unknown,
): ParsedToolArguments {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return {
      ok: true,
      args: value as Record<string, unknown>,
    };
  }

  if (typeof value === "string") {
    try {
      const parsed: unknown =
        JSON.parse(value);

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return {
          ok: true,
          args:
            parsed as Record<string, unknown>,
        };
      }
    } catch {
      // Return a protocol error below.
    }
  }

  return {
    ok: false,
    error:
      "Tool arguments must be a valid JSON object.",
  };
}

export function isToolResultFailure(
  result: unknown,
): boolean {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    return false;
  }

  const record =
    result as Record<string, unknown>;

  return (
    record.ok === false ||
    (
      typeof record.error === "string" &&
      record.error.length > 0
    )
  );
}

export function looksLikeTextToolCall(
  value: string,
): boolean {
  return (
    /<(?:tool_calls|invoke)\b/i.test(value) ||
    /(?:^|\n)\s*exec_command\s*(?:\(|\{)/.test(value) ||
    /\bcmd:(?:[a-zA-Z0-9_-]+:)+[a-zA-Z0-9_-]+\s*\{/.test(value)
  );
}
