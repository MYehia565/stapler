import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

async function buildStaplerSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, MODULE_DIR);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);

  return buildRuntimeMountedSkillSnapshot({
    adapterType: "stapler",
    availableEntries,
    desiredSkills,
    mode: "ephemeral",
    configuredDetail:
      "Will be injected into the Stapler prompt for this run. No local skill installation is required.",
    missingDetail:
      "Paperclip knows this skill but its SKILL.md source is unavailable to the Stapler adapter.",
    unsupportedDetail:
      "The skill is selected but cannot be applied because its Paperclip source is unavailable.",
  });
}

export async function listStaplerSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildStaplerSkillSnapshot(ctx.config);
}

export async function syncStaplerSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildStaplerSkillSnapshot(ctx.config);
}

export { MODULE_DIR as staplerSkillsModuleDir };
