import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { EMBEDDED_STAPLER_SKILL_BODY } from "./bundled-stapler-skill.js";
import { staplerSkillsModuleDir } from "./skills.js";

const MAX_SKILL_CHARS = 48_000;
const MAX_TOTAL_SKILL_CHARS = 180_000;

export const BUNDLED_STAPLER_SKILL_KEY = "stapler";

export interface LoadedStaplerSkill {
  key: string;
  runtimeName: string;
  content: string;
  /** Where the bundled skill body came from (disk or embedded). */
  source?: "disk" | "embedded";
}

function packageRootFromModuleDir(moduleDir: string): string {
  // dist/server or src/server → package root
  return path.resolve(moduleDir, "..", "..");
}

export function bundledStaplerSkillCandidates(
  moduleDir = staplerSkillsModuleDir,
): string[] {
  const packageRoot = packageRootFromModuleDir(moduleDir);
  return [
    path.join(packageRoot, "skills", "stapler", "SKILL.md"),
    // Some hosts copy the package with dist at the install root.
    path.join(moduleDir, "..", "skills", "stapler", "SKILL.md"),
    path.join(moduleDir, "skills", "stapler", "SKILL.md"),
  ];
}

export function bundledStaplerSkillPath(moduleDir = staplerSkillsModuleDir): string {
  return bundledStaplerSkillCandidates(moduleDir)[0]!;
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

function limitSkillContent(body: string): string {
  return body.length > MAX_SKILL_CHARS
    ? `${body.slice(0, MAX_SKILL_CHARS)}\n\n[Skill content truncated by Stapler adapter.]`
    : body;
}

function isStaplerCompanySkillKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === BUNDLED_STAPLER_SKILL_KEY ||
    normalized.endsWith("/stapler") ||
    normalized.includes("/stapler/") ||
    normalized.endsWith(":stapler")
  );
}

export async function loadBundledStaplerSkill(
  moduleDir = staplerSkillsModuleDir,
): Promise<LoadedStaplerSkill> {
  for (const skillFile of bundledStaplerSkillCandidates(moduleDir)) {
    try {
      await access(skillFile);
      const raw = await readFile(skillFile, "utf8");
      const body = stripSkillFrontmatter(raw);
      if (!body) {
        continue;
      }

      return {
        key: BUNDLED_STAPLER_SKILL_KEY,
        runtimeName: BUNDLED_STAPLER_SKILL_KEY,
        content: limitSkillContent(body),
        source: "disk",
      };
    } catch {
      // try next candidate
    }
  }

  return {
    key: BUNDLED_STAPLER_SKILL_KEY,
    runtimeName: BUNDLED_STAPLER_SKILL_KEY,
    content: limitSkillContent(EMBEDDED_STAPLER_SKILL_BODY.trim()),
    source: "embedded",
  };
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

  // Always inject the Stapler operating skill first. Prefer disk SKILL.md when
  // present; otherwise use the embedded body so Paperclip installs that only
  // ship `dist/` still get the skill.
  const bundled = await loadBundledStaplerSkill();
  skills.push(bundled);
  total += bundled.content.length;

  if (bundled.source === "embedded") {
    warnings.push(
      `Bundled Stapler skill loaded from embedded fallback (disk SKILL.md not found near ${bundledStaplerSkillPath()}).`,
    );
  }

  for (const key of desired) {
    // Skip company copies only when the bundled skill already covers it.
    if (isStaplerCompanySkillKey(key)) {
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

    const limited = limitSkillContent(trimmed);

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
