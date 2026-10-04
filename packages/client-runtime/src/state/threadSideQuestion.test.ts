import { describe, expect, it } from "vite-plus/test";

import {
  parseSideQuestionCommand,
  sideQuestionBlockReason,
  sideQuestionContextTurns,
  updateLastSideQuestionTurn,
} from "./threadSideQuestion.ts";

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

describe("sideQuestionBlockReason", () => {
  it("asks for a question when /btw is bare", () => {
    expect(sideQuestionBlockReason("")).toBe("Add a question after /btw.");
  });

  it("rejects questions the server schema would refuse, before the draft is cleared", () => {
    expect(sideQuestionBlockReason("a".repeat(20_000))).toBeNull();
    expect(sideQuestionBlockReason("a".repeat(20_001))).toMatch(/limited to 20,000/);
  });
});

it("sends only the latest 20 answered turns as follow-up context", () => {
  const turns = Array.from({ length: 25 }, (_, index) => ({
    question: `q${index}`,
    answer: `a${index}`,
    status: index === 24 ? ("cancelled" as const) : ("done" as const),
  }));
  const context = sideQuestionContextTurns(turns);
  expect(context).toHaveLength(20);
  expect(context[0]).toEqual({ question: "q4", answer: "a4" });
  expect(context.at(-1)).toEqual({ question: "q23", answer: "a23" });
});
