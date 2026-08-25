import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  callPaperclipIssueTool,
  isPaperclipIssueToolName,
  listPaperclipIssueTools,
} from "../src/server/paperclip-issue-tools.js";
import { resolvePaperclipRunId } from "../src/server/tool-gateway.js";
import { enrichPaperclipWakeContext } from "../src/server/wake-context.js";
import {
  buildSignalCommanderPrompt,
  buildToolAvailabilityMessage,
} from "../src/server/prompt.js";

const originalFetch = globalThis.fetch;
const originalRunId = process.env.PAPERCLIP_RUN_ID;
const originalWakeComment = process.env.PAPERCLIP_WAKE_COMMENT_ID;
const originalWakeReason = process.env.PAPERCLIP_WAKE_REASON;
const originalWakePayload = process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRunId === undefined) {
    delete process.env.PAPERCLIP_RUN_ID;
  } else {
    process.env.PAPERCLIP_RUN_ID = originalRunId;
  }
  if (originalWakeComment === undefined) {
    delete process.env.PAPERCLIP_WAKE_COMMENT_ID;
  } else {
    process.env.PAPERCLIP_WAKE_COMMENT_ID = originalWakeComment;
  }
  if (originalWakeReason === undefined) {
    delete process.env.PAPERCLIP_WAKE_REASON;
  } else {
    process.env.PAPERCLIP_WAKE_REASON = originalWakeReason;
  }
  if (originalWakePayload === undefined) {
    delete process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  } else {
    process.env.PAPERCLIP_WAKE_PAYLOAD_JSON = originalWakePayload;
  }
});

describe("paperclip issue disposition tools", () => {
  it("registers checkout, update, comment, create, get, list tools", () => {
    const names = listPaperclipIssueTools().map(
      (tool) => tool.function.name,
    );

    assert.deepEqual(names, [
      "paperclip_list_my_issues",
      "paperclip_list_agents",
      "paperclip_get_issue",
      "paperclip_checkout_issue",
      "paperclip_create_issue",
      "paperclip_update_issue",
      "paperclip_add_comment",
    ]);
    assert.equal(isPaperclipIssueToolName("paperclip_create_issue"), true);
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

  it("creates assigned child issues for handoff", async () => {
    let seenUrl = "";
    let seenBody = "";

    globalThis.fetch = async (input, init) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ id: "child-1", title: "Approve S2" }),
        { status: 201 },
      );
    };

    const result = (await callPaperclipIssueTool(
      {
        runId: "run-1",
        authToken: "jwt",
        agent: { id: "agent-mgr", companyId: "co-1" },
        context: {},
        config: {},
        runtime: {},
      } as any,
      { paperclipApiUrl: "https://agent.signalpost.net/api" },
      "paperclip_create_issue",
      {
        title: "Approve S2",
        description: "Please approve stage 2.",
        assigneeAgentId: "signal-commander-id",
        parentId: "parent-issue",
        goalId: "goal-1",
      },
    )) as { ok: boolean; warning?: string };

    assert.equal(result.ok, true);
    assert.equal(
      seenUrl,
      "https://agent.signalpost.net/api/companies/co-1/issues",
    );
    assert.match(seenBody, /"assigneeAgentId":"signal-commander-id"/);
    assert.match(seenBody, /"parentId":"parent-issue"/);
    assert.equal(result.warning, undefined);
  });

  it("warns when create_issue omits assigneeAgentId", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "child-2" }), { status: 201 });

    const result = (await callPaperclipIssueTool(
      {
        runId: "run-1",
        authToken: "jwt",
        agent: { id: "agent-mgr", companyId: "co-1" },
        context: {},
        config: {},
        runtime: {},
      } as any,
      {},
      "paperclip_create_issue",
      { title: "Orphan task" },
    )) as { ok: boolean; warning?: string };

    assert.equal(result.ok, true);
    assert.match(String(result.warning), /without assigneeAgentId/);
  });

  it("reassigns via assigneeAgentId on update", async () => {
    let seenBody = "";

    globalThis.fetch = async (_input, init) => {
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const result = (await callPaperclipIssueTool(
      {
        runId: "run-1",
        authToken: "jwt",
        agent: { id: "agent-1", companyId: "co-1" },
        context: { issueId: "issue-9" },
        config: {},
        runtime: {},
      } as any,
      {},
      "paperclip_update_issue",
      {
        status: "todo",
        assigneeAgentId: "signal-commander-id",
        blockedByIssueIds: ["dep-1"],
        comment: "Handing off for approval.",
      },
    )) as { ok: boolean };

    assert.equal(result.ok, true);
    assert.match(seenBody, /"assigneeAgentId":"signal-commander-id"/);
    assert.match(seenBody, /"blockedByIssueIds":\["dep-1"\]/);
  });

  it("warns on prose Next action comments without structured mention", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "c1" }), { status: 201 });

    const result = (await callPaperclipIssueTool(
      {
        runId: "run-1",
        authToken: "jwt",
        agent: { id: "agent-1" },
        context: { issueId: "issue-1" },
        config: {},
        runtime: {},
      } as any,
      {},
      "paperclip_add_comment",
      {
        body: "Next action: signal-commander approval of S2/S3/S1",
      },
    )) as { ok: boolean; warning?: string };

    assert.equal(result.ok, true);
    assert.match(String(result.warning), /does not wake/);
  });

  it("does not warn when comment includes structured agent mention", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "c1" }), { status: 201 });

    const result = (await callPaperclipIssueTool(
      {
        runId: "run-1",
        authToken: "jwt",
        agent: { id: "agent-1" },
        context: { issueId: "issue-1" },
        config: {},
        runtime: {},
      } as any,
      {},
      "paperclip_add_comment",
      {
        body: "Next action: [@Signal Commander](agent://abc-123) approve S2.",
      },
    )) as { ok: boolean; warning?: string };

    assert.equal(result.ok, true);
    assert.equal(result.warning, undefined);
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

  it("lists inbox via inbox-lite", async () => {
    let seenUrl = "";

    globalThis.fetch = async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify([{ id: "i1" }]), { status: 200 });
    };

    const result = (await callPaperclipIssueTool(
      {
        runId: "run-1",
        authToken: "jwt",
        agent: { id: "agent-1", companyId: "co-1" },
        context: {},
        config: {},
        runtime: {},
      } as any,
      { paperclipApiUrl: "https://agent.signalpost.net/api" },
      "paperclip_list_my_issues",
      {},
    )) as { ok: boolean };

    assert.equal(result.ok, true);
    assert.equal(
      seenUrl,
      "https://agent.signalpost.net/api/agents/me/inbox-lite",
    );
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

describe("enrichPaperclipWakeContext", () => {
  it("fetches the triggering wake comment body", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      assert.match(url, /comments\/wake-c1$/);
      return new Response(
        JSON.stringify({
          id: "wake-c1",
          body: "[@Signal Commander](agent://x) please approve S2",
          authorName: "Manager",
        }),
        { status: 200 },
      );
    };

    const enriched = await enrichPaperclipWakeContext(
      {
        runId: "run-1",
        authToken: "jwt",
        agent: { id: "agent-1" },
        context: {
          issueId: "issue-1",
          wakeCommentId: "wake-c1",
          wakeReason: "issue_comment_mentioned",
        },
        config: {},
        runtime: {},
      } as any,
      { paperclipApiUrl: "https://agent.signalpost.net/api" },
    );

    assert.equal(
      enriched.context.wakeCommentBody,
      "[@Signal Commander](agent://x) please approve S2",
    );
    assert.equal(enriched.context.wakeReason, "issue_comment_mentioned");
    assert.deepEqual(enriched.warnings, []);
  });

  it("promotes nested issue.comments into top-level comments", async () => {
    const enriched = await enrichPaperclipWakeContext(
      {
        runId: "run-1",
        authToken: "",
        agent: { id: "agent-1" },
        context: {
          issue: {
            id: "issue-1",
            comments: [{ authorName: "A", body: "Please take S2" }],
          },
        },
        config: {},
        runtime: {},
      } as any,
      {},
    );

    assert.ok(Array.isArray(enriched.context.comments));
    assert.equal(
      (enriched.context.comments as Array<{ body: string }>)[0]?.body,
      "Please take S2",
    );
  });
});

describe("handoff prompt guidance", () => {
  it("includes inter-agent handoff protocol and wake comment", () => {
    const prompt = buildSignalCommanderPrompt({
      context: {
        taskTitle: "Approve pipeline",
        wakeCommentBody:
          "[@Signal Commander](agent://abc) approve S2/S3/S1",
        wakeReason: "issue_comment_mentioned",
      },
      runId: "run-1",
    });

    assert.match(prompt, /Inter-Agent Handoff Protocol/);
    assert.match(prompt, /assigneeAgentId/);
    assert.match(prompt, /agent:\/\/<agent-uuid>/);
    assert.match(prompt, /## Triggering Wake Comment/);
    assert.match(prompt, /approve S2\/S3\/S1/);
  });

  it("lists create/list handoff tools in tool availability", () => {
    const message = buildToolAvailabilityMessage({
      workspaceToolNames: ["read_file"],
      paperclipIssueToolNames: [
        "paperclip_create_issue",
        "paperclip_list_agents",
        "paperclip_update_issue",
      ],
      paperclipToolNames: [],
    });

    assert.match(message, /paperclip_create_issue/);
    assert.match(message, /Free-text "Next action: agent-name" does NOT wake/);
  });
});
