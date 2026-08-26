import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { staplerSkillsModuleDir } from "./skills.js";

const MAX_SKILL_CHARS = 48_000;
const MAX_TOTAL_SKILL_CHARS = 180_000;

export const BUNDLED_STAPLER_SKILL_KEY = "stapler";

export interface LoadedStaplerSkill {
  key: string;
  runtimeName: string;
  content: string;
}

function packageRootFromModuleDir(moduleDir: string): string {
  // dist/server or src/server → package root
  return path.resolve(moduleDir, "..", "..");
}

export function bundledStaplerSkillPath(moduleDir = staplerSkillsModuleDir): string {
  return path.join(
    packageRootFromModuleDir(moduleDir),
    "skills",
    "stapler",
    "SKILL.md",
  );
}

/** Strip YAML frontmatter so the prompt gets the operating body. */
export function stripSkillFrontmatter(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return trimmed;
  }

  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) {
    return trimmed;
  }

  return trimmed.slice(end + 4).trim();
}

export async function loadBundledStaplerSkill(
  moduleDir = staplerSkillsModuleDir,
): Promise<LoadedStaplerSkill | null> {
  const skillFile = bundledStaplerSkillPath(moduleDir);
  try {
    const raw = await readFile(skillFile, "utf8");
    const body = stripSkillFrontmatter(raw);
    if (!body) {
      return null;
    }

    const limited =
      body.length > MAX_SKILL_CHARS
        ? `${body.slice(0, MAX_SKILL_CHARS)}\n\n[Skill content truncated by Stapler adapter.]`
        : body;

    return {
      key: BUNDLED_STAPLER_SKILL_KEY,
      runtimeName: BUNDLED_STAPLER_SKILL_KEY,
      content: limited,
    };
  } catch {
    return null;
  }
}

export async function loadDesiredStaplerSkills(
  config: Record<string, unknown>,
): Promise<{ skills: LoadedStaplerSkill[]; warnings: string[] }> {
  const available = await readPaperclipRuntimeSkillEntries(config, staplerSkillsModuleDir);
  const desired = resolvePaperclipDesiredSkillNames(config, available);
  const byKey = new Map(available.map((entry) => [entry.key, entry]));
  const skills: LoadedStaplerSkill[] = [];
  const warnings: string[] = [];
  let total = 0;

  // Always inject the adapter-bundled Stapler operating skill first so every
  // Stapler agent knows tools + handoff rules without a manual Skills sync.
  const bundled = await loadBundledStaplerSkill();
  if (bundled) {
    skills.push(bundled);
    total += bundled.content.length;
  } else {
    warnings.push(
      `Bundled Stapler skill missing at ${bundledStaplerSkillPath()}. Agents will rely on the built-in prompt handoff section only.`,
    );
  }

  for (const key of desired) {
    // Skip company copies of the same stapler skill to avoid duplicate context.
    if (
      key === BUNDLED_STAPLER_SKILL_KEY ||
      key.endsWith("/stapler") ||
      key.includes("/stapler/")
    ) {
      continue;
    }

    const entry = byKey.get(key);
    if (!entry) {
      warnings.push(`Selected Paperclip skill "${key}" is not available to Stapler.`);
      continue;
    }
    if (entry.sourceStatus === "missing") {
      warnings.push(`Selected Paperclip skill "${key}" has a missing source.`);
      continue;
    }

    const skillFile = path.join(entry.source, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillFile, "utf8");
    } catch {
      warnings.push(`Could not read SKILL.md for selected skill "${key}".`);
      continue;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      warnings.push(`Selected Paperclip skill "${key}" has an empty SKILL.md.`);
      continue;
    }

    const limited = trimmed.length > MAX_SKILL_CHARS
      ? `${trimmed.slice(0, MAX_SKILL_CHARS)}\n\n[Skill content truncated by Stapler adapter.]`
      : trimmed;

    if (total + limited.length > MAX_TOTAL_SKILL_CHARS) {
      warnings.push(
        `Skill context limit reached; skipped remaining selected skills after "${key}".`,
      );
      break;
    }

    skills.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      content: limited,
    });
    total += limited.length;
  }

  return { skills, warnings };
}

export async function loadDesiredStaplerSkillsForContext(
  ctx: AdapterSkillContext,
) {
  return loadDesiredStaplerSkills(ctx.config);
}
