import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  BUNDLED_STAPLER_SKILL_KEY,
  bundledStaplerSkillPath,
  loadBundledStaplerSkill,
  stripSkillFrontmatter,
} from "../src/server/skill-content.js";

const repoServerDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "server",
);

describe("bundled Stapler skill", () => {
  it("strips YAML frontmatter", () => {
    const body = stripSkillFrontmatter(
      "---\nname: stapler\n---\n\n# Hello\n\nUse tools.\n",
    );
    assert.match(body, /^# Hello/);
    assert.doesNotMatch(body, /^---/);
  });

  it("loads skills/stapler/SKILL.md from disk when present", async () => {
    const skillPath = bundledStaplerSkillPath(repoServerDir);
    assert.match(skillPath.replace(/\\/g, "/"), /skills\/stapler\/SKILL\.md$/);

    const skill = await loadBundledStaplerSkill(repoServerDir);
    assert.equal(skill.key, BUNDLED_STAPLER_SKILL_KEY);
    assert.equal(skill.source, "disk");
    assert.match(skill.content, /Inter-agent handoffs/);
    assert.match(skill.content, /agent:\/\/<agent-uuid>/);
    assert.match(skill.content, /paperclip_list_agents/);
    assert.match(skill.content, /any MCP connection/);
    assert.doesNotMatch(skill.content, /^name: stapler/m);
  });

  it("falls back to embedded body when disk SKILL.md is missing", async () => {
    const skill = await loadBundledStaplerSkill(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "missing-server"),
    );
    assert.equal(skill.key, BUNDLED_STAPLER_SKILL_KEY);
    assert.equal(skill.source, "embedded");
    assert.match(skill.content, /Stapler operating skill/);
    assert.match(skill.content, /Tool Gateway \/ MCP tools/);
  });
});
