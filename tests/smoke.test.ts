import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("test harness", () => {
  it("runs under node --test", () => {
    assert.equal(1 + 1, 2);
  });
});
