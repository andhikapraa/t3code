import { describe, expect, it } from "vite-plus/test";

import { parseSideQuestionCommand, updateLastSideQuestionTurn } from "./threadSideQuestion.ts";

describe("parseSideQuestionCommand", () => {
  it("returns the question after /btw, including multiline text", () => {
    expect(parseSideQuestionCommand("/btw why is this slow?")).toBe("why is this slow?");
    expect(parseSideQuestionCommand("  /BTW  a\nb  ")).toBe("a\nb");
  });

  it("returns an empty question for a bare /btw", () => {
    expect(parseSideQuestionCommand("/btw")).toBe("");
  });

  it("ignores other text", () => {
    expect(parseSideQuestionCommand("/btwx hi")).toBeNull();
    expect(parseSideQuestionCommand("by the way /btw hi")).toBeNull();
  });
});

it("updates only the last turn of a topic", () => {
  const topic = {
    id: "t",
    turns: [
      { question: "a", answer: "1", status: "done" as const },
      { question: "b", answer: "", status: "running" as const },
    ],
  };
  const next = updateLastSideQuestionTurn(topic, (turn) => ({ ...turn, answer: "2" }));
  expect(next.turns.map((turn) => turn.answer)).toEqual(["1", "2"]);
});
