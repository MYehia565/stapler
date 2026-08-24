import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadInstructionsFile } from "../src/server/instructions.js";
import {
  buildSignalCommanderPrompt,
  buildToolAvailabilityMessage,
} from "../src/server/prompt.js";

describe("buildToolAvailabilityMessage", () => {
  it("lists governed Paperclip tools when the gateway is available", () => {
    const message = buildToolAvailabilityMessage({
      workspaceToolNames: ["read_file", "write_file"],
      paperclipIssueToolNames: ["paperclip_update_issue"],
      paperclipToolNames: ["COMPOSIO_SEARCH_TOOLS", "NOTION_SEARCH"],
    });

    assert.match(message, /MCP \/ Composio \/ governed tools ARE callable/);
    assert.match(message, /COMPOSIO_SEARCH_TOOLS/);
    assert.match(message, /NOTION_SEARCH/);
    assert.match(
      message,
      /Workspace filesystem tools \(files\/shell\/search\/network helpers, not MCP\): read_file, write_file\./,
    );
    assert.match(message, /Do not report MCP tools as unavailable/);
    assert.match(message, /Loop protection/);
    assert.doesNotMatch(message, /disposition tools are NOT available/);
  });

  it("tells the model to stop rather than shell around a missing gateway", () => {
    const message = buildToolAvailabilityMessage({
      workspaceToolNames: ["read_file"],
      paperclipToolNames: [],
      gatewayWarnings: ["The session was not created."],
    });

    assert.match(
      message,
      /Paperclip governed \/ MCP tools are NOT available in this run/,
    );
    assert.match(message, /exec_command, curl, wget/);
    assert.match(message, /stop on the first round and report/);
    assert.match(message, /The session was not created\./);
  });

  it("requires disposition via paperclip_update_issue when that tool is present", () => {
    const message = buildToolAvailabilityMessage({
      workspaceToolNames: ["read_file"],
      paperclipIssueToolNames: [
        "paperclip_checkout_issue",
        "paperclip_update_issue",
      ],
      paperclipToolNames: ["paperclip-self_get_issue_context"],
    });

    assert.match(message, /paperclip_update_issue/);
    assert.match(message, /does not stay in_progress/);
  });
});

describe("buildSignalCommanderPrompt", () => {
  it("prepends a rendered promptTemplate", () => {
    const prompt = buildSignalCommanderPrompt({
      promptTemplate: "Hello {{agent.name}}",
      agent: { name: "Scout" },
      context: {
        taskTitle: "Ship fix",
        taskDescription: "Apply the patch.",
      },
      runId: "run-1",
    });

    assert.match(prompt, /^Hello Scout\n\n## Paperclip Execution Contract/);
    assert.match(
      prompt,
      /MCP\/Composio tools, issue disposition tools, and workspace filesystem tools/,
    );
    assert.match(prompt, /## Task\nTitle: Ship fix/);
  });

  it("states the tool-round and time budget when one is given", () => {
    const prompt = buildSignalCommanderPrompt({
      context: { taskTitle: "Ship fix" },
      maxToolRounds: 8,
      runTimeoutSec: 1800,
    });

    assert.match(
      prompt,
      /at most 8 tool rounds and 1800 seconds for this entire run/,
    );
    assert.match(prompt, /Exploring the workspace is not an outcome/);
  });

  it("omits budget guidance when no budget is supplied", () => {
    const prompt = buildSignalCommanderPrompt({
      context: { taskTitle: "Ship fix" },
    });

    assert.doesNotMatch(prompt, /tool rounds/);
  });

  it("prefers instructionsFileContent over context instructions", () => {
    const prompt = buildSignalCommanderPrompt({
      instructionsFileContent: "Always use list_dir first.",
      instructionsFilePath: "/tmp/AGENTS.md",
      context: {
        taskTitle: "Inspect workspace",
        agentInstructions: "Ignore this fallback.",
      },
    });

    assert.match(prompt, /## Agent Instructions/);
    assert.match(prompt, /Loaded from \/tmp\/AGENTS\.md/);
    assert.match(prompt, /Always use list_dir first/);
    assert.match(prompt, /Ignore this fallback/);
  });
});

describe("loadInstructionsFile", () => {
  it("returns empty content when no path is configured", async () => {
    const loaded = await loadInstructionsFile({});
    assert.equal(loaded.content, "");
    assert.equal(loaded.path, null);
    assert.deepEqual(loaded.warnings, []);
  });

  it("loads instructions from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stapler-instructions-"));
    const filePath = path.join(dir, "AGENTS.md");
    await writeFile(filePath, "Be concise.\n", "utf8");

    const loaded = await loadInstructionsFile({
      instructionsFilePath: filePath,
    });

    assert.equal(loaded.content, "Be concise.");
    assert.equal(loaded.path, filePath);
    assert.deepEqual(loaded.warnings, []);
  });

  it("warns when the instructions file is missing", async () => {
    const loaded = await loadInstructionsFile({
      instructionsFilePath: path.join(
        tmpdir(),
        "stapler-missing-instructions.md",
      ),
    });

    assert.equal(loaded.content, "");
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0]!, /Could not read instructionsFilePath/);
  });
});
