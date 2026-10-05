import { describe, expect, it } from "vite-plus/test";

import { parseHandoffCommand } from "./threadHandoff.ts";

describe("parseHandoffCommand", () => {
  it("reads an optional focus", () => {
    expect(parseHandoffCommand("/handoff")).toBe("");
    expect(parseHandoffCommand("  /handoff   now write the tests  ")).toBe("now write the tests");
    expect(parseHandoffCommand("/handoff\nmulti\nline")).toBe("multi\nline");
  });

  it("ignores other text", () => {
    expect(parseHandoffCommand("/handoffs")).toBeNull();
    expect(parseHandoffCommand("please /handoff")).toBeNull();
    expect(parseHandoffCommand("/btw what?")).toBeNull();
  });
});
