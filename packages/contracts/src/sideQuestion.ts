import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Side questions (`/btw`): ask about a thread without adding to it. The server
 * answers from a throwaway fork of the thread's provider session, so the live
 * session, its transcript, and the event store are never touched.
 */
export const ThreadSideQuestionInput = Schema.Struct({
  threadId: ThreadId,
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  /** Earlier answered turns of the same side conversation, oldest first. */
  previousTurns: Schema.Array(
    Schema.Struct({
      question: Schema.String.check(Schema.isMaxLength(20_000)),
      answer: Schema.String.check(Schema.isMaxLength(200_000)),
    }),
  ).check(Schema.isMaxLength(20)),
});
export type ThreadSideQuestionInput = typeof ThreadSideQuestionInput.Type;

/** Streamed answer text. Concatenate `delta`s in order. */
export const ThreadSideQuestionEvent = Schema.Struct({
  type: Schema.Literal("delta"),
  delta: Schema.String,
});
export type ThreadSideQuestionEvent = typeof ThreadSideQuestionEvent.Type;

export class ThreadSideQuestionError extends Schema.TaggedError<ThreadSideQuestionError>()(
  "ThreadSideQuestionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
