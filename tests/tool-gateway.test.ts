import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allocateSafeToolName,
  gatewayToolsFromDiscoveryPayload,
  joinPaperclipResourceUrl,
  MAX_GATEWAY_TOOL_NAME_LEN,
} from "../src/server/tool-gateway.js";

describe("joinPaperclipResourceUrl", () => {
  it("does not double /api when session returns root-absolute toolsUrl", () => {
    assert.equal(
      joinPaperclipResourceUrl(
        "https://agent.signalpost.net/api",
        "/api/tool-gateway/tools",
      ),
      "https://agent.signalpost.net/api/tool-gateway/tools",
    );
    assert.equal(
      joinPaperclipResourceUrl(
        "http://localhost:3100/api",
        "/api/tool-gateway/tools/call",
      ),
      "http://localhost:3100/api/tool-gateway/tools/call",
    );
  });

  it("joins relative paths onto the configured API base", () => {
    assert.equal(
      joinPaperclipResourceUrl(
        "http://localhost:3100/api",
        "tool-gateway/tools",
      ),
      "http://localhost:3100/api/tool-gateway/tools",
    );
  });

  it("passes through absolute http(s) URLs", () => {
    assert.equal(
      joinPaperclipResourceUrl(
        "http://localhost:3100/api",
        "https://edge.example/api/tool-gateway/tools",
      ),
      "https://edge.example/api/tool-gateway/tools",
    );
  });
});

describe("allocateSafeToolName", () => {
  it("keeps distinguishing Composio action suffixes under the 64-char cap", () => {
    const used = new Set<string>();
    const prefix =
      "mcp.composio-verylongconnectionnamespaceXXXX:";
    const search = `${prefix}COMPOSIO_SEARCH_TOOLS`;
    const wait = `${prefix}COMPOSIO_WAIT_FOR_CONNECTIONS`;

    const safeSearch = allocateSafeToolName(search, used);
    const safeWait = allocateSafeToolName(wait, used);

    assert.notEqual(safeSearch, safeWait);
    assert.ok(safeSearch.length <= MAX_GATEWAY_TOOL_NAME_LEN);
    assert.ok(safeWait.length <= MAX_GATEWAY_TOOL_NAME_LEN);
    assert.match(safeSearch, /SEARCH_TOOLS/);
    assert.match(safeWait, /WAIT_FOR_CONNECTIONS|_[a-f0-9]{8}$/);
  });
});

describe("gatewayToolsFromDiscoveryPayload", () => {
  it("parses Paperclip session list as a bare array with parametersSchema", () => {
    const result = gatewayToolsFromDiscoveryPayload([
      {
        name: "mcp.composio-abc123:GITHUB_LIST_REPOS",
        displayName: "List GitHub repos",
        description: "List repositories",
        parametersSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
          },
          required: ["owner"],
        },
      },
    ]);

    assert.equal(result.tools.length, 1);
    assert.equal(
      result.tools[0]?.function.name,
      "mcp_composio-abc123_GITHUB_LIST_REPOS",
    );
    assert.match(
      result.tools[0]?.function.description ?? "",
      /List repositories/,
    );
    assert.match(
      result.tools[0]?.function.description ?? "",
      /mcp\.composio-abc123:GITHUB_LIST_REPOS/,
    );
    assert.deepEqual(
      result.tools[0]?.function.parameters,
      {
        type: "object",
        properties: {
          owner: { type: "string" },
        },
        required: ["owner"],
      },
    );
    assert.equal(
      result.originalNameBySafeName.get(
        "mcp_composio-abc123_GITHUB_LIST_REPOS",
      ),
      "mcp.composio-abc123:GITHUB_LIST_REPOS",
    );
  });

  it("does not collapse COMPOSIO_SEARCH_TOOLS into WAIT_FOR_CONNECTIONS", () => {
    const prefix =
      "mcp.composio-verylongconnectionnamespaceXXXX:";
    const result = gatewayToolsFromDiscoveryPayload([
      {
        name: `${prefix}COMPOSIO_SEARCH_TOOLS`,
        description: "Search tools",
        parametersSchema: {
          type: "object",
          properties: { queries: { type: "array" } },
        },
      },
      {
        name: `${prefix}COMPOSIO_WAIT_FOR_CONNECTIONS`,
        description: "Wait for connections",
        parametersSchema: {
          type: "object",
          properties: { toolkits: { type: "array" } },
          required: ["toolkits"],
        },
      },
    ]);

    assert.equal(result.tools.length, 2);

    const names = result.tools.map((tool) => tool.function.name);
    assert.equal(new Set(names).size, 2);

    const search = result.tools.find((tool) =>
      (tool.function.description ?? "").includes("COMPOSIO_SEARCH_TOOLS"),
    );
    const wait = result.tools.find((tool) =>
      (tool.function.description ?? "").includes(
        "COMPOSIO_WAIT_FOR_CONNECTIONS",
      ),
    );

    assert.ok(search);
    assert.ok(wait);
    assert.notEqual(search?.function.name, wait?.function.name);
    assert.equal(
      result.originalNameBySafeName.get(search!.function.name),
      `${prefix}COMPOSIO_SEARCH_TOOLS`,
    );
    assert.equal(
      result.originalNameBySafeName.get(wait!.function.name),
      `${prefix}COMPOSIO_WAIT_FOR_CONNECTIONS`,
    );
  });

  it("still accepts the wrapped { tools: [...] } shape", () => {
    const result = gatewayToolsFromDiscoveryPayload({
      tools: [
        {
          name: "paperclip_get_issue",
          title: "Get issue",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    assert.equal(result.tools.length, 1);
    assert.equal(
      result.tools[0]?.function.name,
      "paperclip_get_issue",
    );
  });

  it("returns an empty list for unexpected payloads", () => {
    assert.equal(
      gatewayToolsFromDiscoveryPayload({ ok: true }).tools.length,
      0,
    );
    assert.equal(
      gatewayToolsFromDiscoveryPayload(null).tools.length,
      0,
    );
  });
});
