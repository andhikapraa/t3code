import { expect, it } from "@effect/vitest";

import {
  buildPiHandoffPrompt,
  buildPiSideQuestionPrompt,
  classifyPiSideQuestionEvent,
} from "./PiSideQuestion.ts";

it("streams only assistant text deltas", () => {
  expect(
    classifyPiSideQuestionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
    }),
  ).toEqual({ type: "delta", delta: "Hi" });
  expect(
    classifyPiSideQuestionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    }),
  ).toBeNull();
  expect(classifyPiSideQuestionEvent({ type: "agent_settled" })).toEqual({ type: "done" });
});

it("surfaces assistant model errors", () => {
  expect(
    classifyPiSideQuestionEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" },
    }),
  ).toEqual({ type: "error", message: "rate limited" });
  expect(
    classifyPiSideQuestionEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop" },
    }),
  ).toBeNull();
});

it("cancels extension dialogs but ignores fire-and-forget UI updates", () => {
  expect(
    classifyPiSideQuestionEvent({ type: "extension_ui_request", id: "u1", method: "confirm" }),
  ).toEqual({ type: "dialog", id: "u1" });
  expect(
    classifyPiSideQuestionEvent({ type: "extension_ui_request", id: "u2", method: "setWidget" }),
  ).toBeNull();
});

it("carries earlier side turns into a follow-up prompt", () => {
  const prompt = buildPiSideQuestionPrompt("and why?", [{ question: "what?", answer: "this" }]);
  expect(prompt).toContain("do not call tools");
  expect(prompt).toContain("Earlier side question 1: what?\nYour answer: this");
  expect(prompt.endsWith("Follow-up: and why?")).toBe(true);
  expect(buildPiSideQuestionPrompt("what?", []).endsWith("\n\nwhat?")).toBe(true);
});

it("adds the handoff focus only when one is given", () => {
  const plain = buildPiHandoffPrompt(undefined);
  expect(plain).toContain("Do not call tools.");
  expect(plain).not.toContain("Additional focus");
  expect(buildPiHandoffPrompt("write the tests")).toContain("Additional focus: write the tests");
});
