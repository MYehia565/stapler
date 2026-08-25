import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  callPaperclipIssueTool,
  isPaperclipIssueToolName,
  listPaperclipIssueTools,
} from "../src/server/paperclip-issue-tools.js";
import { resolvePaperclipRunId } from "../src/server/tool-gateway.js";

const originalFetch = globalThis.fetch;
const originalRunId = process.env.PAPERCLIP_RUN_ID;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRunId === undefined) {
    delete process.env.PAPERCLIP_RUN_ID;
  } else {
    process.env.PAPERCLIP_RUN_ID = originalRunId;
  }
});

describe("paperclip issue disposition tools", () => {
  it("registers checkout, update, and comment tools", () => {
    const names = listPaperclipIssueTools().map(
      (tool) => tool.function.name,
    );

    assert.deepEqual(names, [
      "paperclip_checkout_issue",
      "paperclip_update_issue",
      "paperclip_add_comment",
    ]);
    assert.equal(isPaperclipIssueToolName("paperclip_update_issue"), true);
    assert.equal(isPaperclipIssueToolName("paperclip_list_issues"), false);
  });

  it("PATCHes issue status with run id header", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenAuth = "";
    let seenRunId = "";
    let seenBody = "";

    globalThis.fetch = async (input, init) => {
      seenUrl = String(input);
      seenMethod = String(init?.method ?? "GET");
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("Authorization") ?? "";
      seenRunId = headers.get("X-Paperclip-Run-Id") ?? "";
      seenBody = String(init?.body ?? "");

      return new Response(JSON.stringify({ id: "issue-1", status: "done" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = (await callPaperclipIssueTool(
      {
        runId: "run-123",
        authToken: "jwt-token",
        agent: { id: "agent-1" },
        context: { issueId: "issue-1" },
      } as any,
      { paperclipApiUrl: "https://agent.signalpost.net/api" },
      "paperclip_update_issue",
      { status: "done", comment: "Verified completion." },
    )) as { ok: boolean; data?: { status?: string } };

    assert.equal(result.ok, true);
    assert.equal(result.data?.status, "done");
    assert.equal(
      seenUrl,
      "https://agent.signalpost.net/api/issues/issue-1",
    );
    assert.equal(seenMethod, "PATCH");
    assert.equal(seenAuth, "Bearer jwt-token");
    assert.equal(seenRunId, "run-123");
    assert.match(seenBody, /"status":"done"/);
    assert.match(seenBody, /Verified completion/);
  });

  it("posts cross-issue comments with PAPERCLIP_RUN_ID fallback", async () => {
    delete process.env.PAPERCLIP_RUN_ID;
    process.env.PAPERCLIP_RUN_ID = "env-run-99";

    let seenUrl = "";
    let seenMethod = "";
    let seenRunId = "";
    let seenBody = "";

    globalThis.fetch = async (input, init) => {
      seenUrl = String(input);
      seenMethod = String(init?.method ?? "GET");
      const headers = new Headers(init?.headers);
      seenRunId = headers.get("X-Paperclip-Run-Id") ?? "";
      seenBody = String(init?.body ?? "");

      return new Response(JSON.stringify({ id: "comment-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = (await callPaperclipIssueTool(
      {
        runId: "",
        authToken: "jwt",
        agent: { id: "agent-1" },
        context: { issueId: "wake-issue" },
        config: {},
        runtime: {},
      } as any,
      { paperclipApiUrl: "https://agent.signalpost.net/api" },
      "paperclip_add_comment",
      {
        issueId: "referred-issue-42",
        body: "Following up on the referral.",
      },
    )) as { ok: boolean };

    assert.equal(result.ok, true);
    assert.equal(
      seenUrl,
      "https://agent.signalpost.net/api/issues/referred-issue-42/comments",
    );
    assert.equal(seenMethod, "POST");
    assert.equal(seenRunId, "env-run-99");
    assert.match(seenBody, /Following up on the referral/);
  });

  it("prefers context.runId when ctx.runId is empty", async () => {
    delete process.env.PAPERCLIP_RUN_ID;

    let seenRunId = "";

    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenRunId = headers.get("X-Paperclip-Run-Id") ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const result = (await callPaperclipIssueTool(
      {
        runId: "",
        authToken: "jwt",
        agent: { id: "agent-1" },
        context: { runId: "context-run-7", issueId: "issue-1" },
        config: {},
        runtime: {},
      } as any,
      {},
      "paperclip_add_comment",
      { body: "hello" },
    )) as { ok: boolean };

    assert.equal(result.ok, true);
    assert.equal(seenRunId, "context-run-7");
  });

  it("checkouts with agentId and default expectedStatuses", async () => {
    let seenBody = "";

    globalThis.fetch = async (_input, init) => {
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const result = (await callPaperclipIssueTool(
      {
        runId: "run-1",
        authToken: "jwt",
        agent: { id: "agent-9" },
        context: {},
      } as any,
      {},
      "paperclip_checkout_issue",
      { issueId: "SIGA-25" },
    )) as { ok: boolean };

    assert.equal(result.ok, true);
    assert.match(seenBody, /"agentId":"agent-9"/);
    assert.match(seenBody, /"expectedStatuses"/);
  });
});

describe("resolvePaperclipRunId", () => {
  it("resolves ctx → context → env in order", () => {
    assert.equal(
      resolvePaperclipRunId({
        runId: "from-ctx",
        context: { runId: "from-context" },
        config: {},
        runtime: {},
      } as any),
      "from-ctx",
    );

    assert.equal(
      resolvePaperclipRunId({
        runId: "",
        context: { runId: "from-context" },
        config: {},
        runtime: {},
      } as any),
      "from-context",
    );

    process.env.PAPERCLIP_RUN_ID = "from-env";
    assert.equal(
      resolvePaperclipRunId({
        runId: "",
        context: {},
        config: {},
        runtime: {},
      } as any),
      "from-env",
    );
  });
});
