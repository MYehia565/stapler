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

export interface LoadedStaplerSkill {
  key: string;
  runtimeName: string;
  content: string;
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

  for (const key of desired) {
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
