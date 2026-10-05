import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Handoffs (`/handoff`): continue a thread's work in a new thread. The server
 * writes a handoff document from a throwaway fork of the source thread's
 * provider session, then launches a thread in the same project and workspace
 * with that document as its first message. The source thread is not touched.
 */
export const ThreadHandoffInput = Schema.Struct({
  threadId: ThreadId,
  /** Optional direction for the new thread, such as "now write the tests". */
  focus: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(20_000))),
});
export type ThreadHandoffInput = typeof ThreadHandoffInput.Type;

export const ThreadHandoffResult = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadHandoffResult = typeof ThreadHandoffResult.Type;

export class ThreadHandoffError extends Schema.TaggedError<ThreadHandoffError>()(
  "ThreadHandoffError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
