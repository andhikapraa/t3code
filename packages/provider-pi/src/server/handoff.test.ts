import { expect, it } from "@effect/vitest";

import { buildPiHandoffPrompt, classifyPiForkPromptEvent } from "./handoff.ts";

it("streams only assistant text deltas", () => {
  expect(
    classifyPiForkPromptEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
    }),
  ).toEqual({ type: "delta", delta: "Hi" });
  expect(
    classifyPiForkPromptEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    }),
  ).toBeNull();
  expect(classifyPiForkPromptEvent({ type: "agent_settled" })).toEqual({ type: "done" });
});

it("surfaces assistant model errors", () => {
  expect(
    classifyPiForkPromptEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" },
    }),
  ).toEqual({ type: "error", message: "rate limited" });
  expect(
    classifyPiForkPromptEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop" },
    }),
  ).toBeNull();
});

it("cancels extension dialogs but ignores fire-and-forget UI updates", () => {
  expect(
    classifyPiForkPromptEvent({ type: "extension_ui_request", id: "u1", method: "confirm" }),
  ).toEqual({ type: "dialog", id: "u1" });
  expect(
    classifyPiForkPromptEvent({ type: "extension_ui_request", id: "u2", method: "setWidget" }),
  ).toBeNull();
});

it("adds the handoff focus only when one is given", () => {
  const plain = buildPiHandoffPrompt(undefined);
  expect(plain).toContain("Do not call tools.");
  expect(plain).not.toContain("Additional focus");
  expect(buildPiHandoffPrompt("write the tests")).toContain("Additional focus: write the tests");
});
