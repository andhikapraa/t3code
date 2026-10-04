import {
  WS_METHODS,
  type EnvironmentId,
  type ThreadId,
  type ThreadSideQuestionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import {
  createRuntimeCommand,
  isAtomCommandInterrupted,
  runStreamInEnvironment,
  squashAtomCommandFailure,
} from "./runtime.ts";

/**
 * Side questions (`/btw`): ask about a thread without adding to it. Answers
 * live only in client memory, so they are gone after a reload.
 */

export interface SideQuestionTurn {
  readonly question: string;
  readonly answer: string;
  readonly status: "running" | "done" | "cancelled" | "failed";
  readonly errorMessage?: string;
}

/** One side conversation: a question and its follow-ups. */
export interface SideQuestionTopic {
  readonly id: string;
  readonly turns: ReadonlyArray<SideQuestionTurn>;
}

/** `/btw <question>` returns the question; anything else is not a side question. */
export function parseSideQuestionCommand(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  return match[1]?.trim() ?? "";
}

// Mirror the `ThreadSideQuestionInput` limits so the client never clears a
// draft the server would reject.
const SIDE_QUESTION_MAX_CHARS = 20_000;
const SIDE_QUESTION_MAX_PREVIOUS_TURNS = 20;
const SIDE_QUESTION_MAX_CONTEXT_ANSWER_CHARS = 200_000;

/** Why a parsed `/btw` question cannot be sent, or null when it can. */
export function sideQuestionBlockReason(question: string): string | null {
  if (question.length === 0) return "Add a question after /btw.";
  if (question.length > SIDE_QUESTION_MAX_CHARS) {
    return `Side questions are limited to ${SIDE_QUESTION_MAX_CHARS.toLocaleString("en-US")} characters.`;
  }
  return null;
}

/** Side questions are answered from a fork of the provider's native session. */
export function supportsSideQuestions(driver: string | null | undefined): boolean {
  return driver === "pi";
}

/**
 * Answered turns sent as follow-up context. Long chains keep only the most
 * recent turns, and very long answers are cut, so the request stays within the
 * server's limits.
 */
export function sideQuestionContextTurns(
  turns: ReadonlyArray<SideQuestionTurn>,
): ThreadSideQuestionInput["previousTurns"] {
  return turns
    .filter((turn) => turn.status === "done")
    .slice(-SIDE_QUESTION_MAX_PREVIOUS_TURNS)
    .map(({ question, answer }) => ({
      question,
      answer: answer.slice(0, SIDE_QUESTION_MAX_CONTEXT_ANSWER_CHARS),
    }));
}

export function updateLastSideQuestionTurn(
  topic: SideQuestionTopic,
  update: (turn: SideQuestionTurn) => SideQuestionTurn,
): SideQuestionTopic {
  const last = topic.turns.at(-1);
  return last === undefined
    ? topic
    : { ...topic, turns: [...topic.turns.slice(0, -1), update(last)] };
}

export function isSideQuestionRunning(topic: SideQuestionTopic | null): boolean {
  return topic?.turns.at(-1)?.status === "running";
}

// Token deltas arrive far faster than a user can read; batching them keeps a
// streaming answer from re-rendering the whole chat view once per token.
const DELTA_FLUSH_MS = 50;

/**
 * Streams one answer into `onDelta`, batched. Resolves with how the turn ended.
 * Pass a signal to cancel; cancellation stops the server-side Pi process too.
 */
export function createSideQuestionCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = createRuntimeCommand(runtime, {
    label: "environment-data:commands:thread:ask-side-question",
    execute: (input: {
      readonly environmentId: EnvironmentId;
      readonly input: ThreadSideQuestionInput;
      readonly onDelta: (delta: string) => void;
      readonly signal: AbortSignal;
    }) =>
      runStreamInEnvironment(
        input.environmentId,
        runStream(WS_METHODS.threadAskSideQuestion, input.input),
      ).pipe(
        // Interrupting the stream cancels the RPC, which stops the server's Pi process.
        Stream.interruptWhen(
          Effect.callback<void>((resume) => {
            if (input.signal.aborted) return resume(Effect.void);
            input.signal.addEventListener("abort", () => resume(Effect.void), { once: true });
          }),
        ),
        Stream.groupedWithin(Number.MAX_SAFE_INTEGER, DELTA_FLUSH_MS),
        Stream.runForEach((events) =>
          Effect.sync(() => input.onDelta(events.map((event) => event.delta).join(""))),
        ),
      ),
  });

  return async (
    registry: Parameters<typeof command.run>[0],
    input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly question: string;
      readonly previousTurns: ReadonlyArray<SideQuestionTurn>;
      readonly onDelta: (delta: string) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<Pick<SideQuestionTurn, "status" | "errorMessage">> => {
    const result = await command.run(registry, {
      environmentId: input.environmentId,
      input: {
        threadId: input.threadId,
        question: input.question,
        previousTurns: sideQuestionContextTurns(input.previousTurns),
      },
      onDelta: (delta) => {
        if (!input.signal.aborted) input.onDelta(delta);
      },
      signal: input.signal,
    });
    if (input.signal.aborted || isAtomCommandInterrupted(result)) return { status: "cancelled" };
    if (result._tag === "Success") return { status: "done" };
    const error = squashAtomCommandFailure(result);
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "The side question failed.",
    };
  };
}
