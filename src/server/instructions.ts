import { readFile } from "node:fs/promises";
import { asString } from "@paperclipai/adapter-utils/server-utils";

const MAX_INSTRUCTIONS_CHARS = 48_000;

export interface LoadedInstructions {
  content: string;
  path: string | null;
  warnings: string[];
}

/**
 * Load managed/external instructions from adapterConfig.instructionsFilePath.
 * Missing or unreadable paths warn and return empty content (non-fatal).
 */
export async function loadInstructionsFile(
  config: Record<string, unknown>,
): Promise<LoadedInstructions> {
  const path = asString(config.instructionsFilePath, "").trim();
  if (!path) {
    return { content: "", path: null, warnings: [] };
  }

  try {
    const raw = await readFile(path, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        content: "",
        path,
        warnings: [
          `Configured instructionsFilePath "${path}" is empty.`,
        ],
      };
    }

    if (trimmed.length > MAX_INSTRUCTIONS_CHARS) {
      return {
        content: `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated by Stapler adapter.]`,
        path,
        warnings: [
          `Instructions file "${path}" exceeded ${MAX_INSTRUCTIONS_CHARS} characters and was truncated.`,
        ],
      };
    }

    return { content: trimmed, path, warnings: [] };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error);
    return {
      content: "",
      path,
      warnings: [
        `Could not read instructionsFilePath "${path}": ${reason}`,
      ],
    };
  }
}
