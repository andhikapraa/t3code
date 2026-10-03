import {
  ThreadSideQuestionError,
  type ThreadSideQuestionEvent,
  type ThreadSideQuestionInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

/**
 * Side questions (`/btw`): resolves a thread's active provider conversation
 * and asks its provider instance to answer from a throwaway fork. Read-only
 * with respect to orchestration: nothing is dispatched or persisted.
 */
export class ThreadSideQuestion extends Context.Service<
  ThreadSideQuestion,
  {
    readonly ask: (
      input: ThreadSideQuestionInput,
    ) => Stream.Stream<ThreadSideQuestionEvent, ThreadSideQuestionError>;
  }
>()("t3/orchestration-v2/ThreadSideQuestion") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const unavailable = (message: string) => new ThreadSideQuestionError({ message });
  const isSideQuestionError = Schema.is(ThreadSideQuestionError);

  const resolve = Effect.fn("ThreadSideQuestion.resolve")(function* (
    input: ThreadSideQuestionInput,
  ) {
    const thread = yield* projections.getThread(input.threadId);
    // Passing the instance id makes the store also load the active provider thread.
    const { providerThreads } = yield* projections.getThreadProviderContext(
      input.threadId,
      thread.providerInstanceId,
    );
    const instance = yield* providerInstances.getInstance(thread.providerInstanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* unavailable("This thread's provider is not available.");
    }
    if (instance.askSideQuestion === undefined) {
      return yield* unavailable("Side questions are not supported for this provider yet.");
    }
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
    if (nativeThreadId === undefined || nativeThreadId === null) {
      return yield* unavailable("Send a message first. This thread has no conversation yet.");
    }
    const cwd =
      thread.worktreePath ??
      Option.getOrUndefined(yield* projects.get(thread.projectId))?.workspaceRoot;
    if (cwd === undefined) return yield* unavailable("This thread's project was not found.");
    return instance.askSideQuestion({
      cwd,
      nativeThreadId,
      modelSelection: thread.modelSelection,
      question: input.question,
      previousTurns: input.previousTurns,
    });
  });

  const ask: ThreadSideQuestion["Service"]["ask"] = (input) =>
    Stream.unwrap(
      resolve(input).pipe(
        Effect.mapError((cause) =>
          isSideQuestionError(cause)
            ? cause
            : new ThreadSideQuestionError({ message: "Could not read this thread.", cause }),
        ),
      ),
    ).pipe(
      Stream.mapError((cause) =>
        isSideQuestionError(cause)
          ? cause
          : new ThreadSideQuestionError({ message: cause.detail, cause }),
      ),
      Stream.map((delta): ThreadSideQuestionEvent => ({ type: "delta", delta })),
    );

  return ThreadSideQuestion.of({ ask });
});

export const layer = Layer.effect(ThreadSideQuestion, make);
