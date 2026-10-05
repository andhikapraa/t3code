import {
  CommandId,
  type OrchestrationV2AppThread,
  ThreadHandoffError,
  type ThreadHandoffInput,
  type ThreadHandoffResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { randomUuidV4 } from "./RandomUuid.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";

/**
 * Handoffs (`/handoff`): the thread's provider writes a handoff document from
 * a throwaway fork of its conversation, then a new thread starts in the same
 * project and workspace with that document as its first message. The source
 * thread is only read.
 */
export class ThreadHandoff extends Context.Service<
  ThreadHandoff,
  {
    readonly handoff: (
      input: ThreadHandoffInput,
    ) => Effect.Effect<ThreadHandoffResult, ThreadHandoffError>;
  }
>()("t3/orchestration-v2/ThreadHandoff") {}

const isHandoffError = Schema.is(ThreadHandoffError);

/** The new thread shares the source's checkout: its worktree when it has one, else the root. */
export function handoffWorkspaceStrategy(
  thread: Pick<OrchestrationV2AppThread, "worktreePath" | "branch">,
): ThreadLaunch.ThreadLaunchWorkspaceStrategy {
  const branch = thread.branch === null ? {} : { branch: thread.branch };
  return thread.worktreePath === null
    ? { type: "root", ...branch }
    : { type: "existing_worktree", worktreePath: thread.worktreePath, ...branch };
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const launches = yield* ThreadLaunch.ThreadLaunchService;

  const unavailable = (message: string) => new ThreadHandoffError({ message });

  const run = Effect.fn("ThreadHandoff.handoff")(function* (input: ThreadHandoffInput) {
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
    if (instance.writeHandoff === undefined) {
      return yield* unavailable("Handoff is not supported for this provider yet.");
    }
    const nativeThreadId = providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    )?.nativeThreadRef?.nativeId;
    if (nativeThreadId === undefined || nativeThreadId === null) {
      return yield* unavailable("Send a message first. This thread has no conversation yet.");
    }
    const cwd =
      thread.worktreePath ??
      Option.getOrUndefined(yield* projects.get(thread.projectId))?.workspaceRoot;
    if (cwd === undefined) return yield* unavailable("This thread's project was not found.");

    const document = yield* instance
      .writeHandoff({
        cwd,
        nativeThreadId,
        modelSelection: thread.modelSelection,
        focus: input.focus,
      })
      .pipe(Effect.mapError((cause) => new ThreadHandoffError({ message: cause.detail, cause })));

    const commandId = CommandId.make(yield* randomUuidV4);
    const launched = yield* launches.launch({
      commandId,
      projectId: thread.projectId,
      title: input.focus ?? `Handoff: ${thread.title}`,
      generateTitle: true,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      workspaceStrategy: handoffWorkspaceStrategy(thread),
      initialMessage: { text: document, attachments: [] },
      createdBy: "user",
      creationSource: "web",
    });
    return { threadId: launched.threadId };
  });

  const handoff: ThreadHandoff["Service"]["handoff"] = (input) =>
    run(input).pipe(
      Effect.mapError((cause) =>
        isHandoffError(cause)
          ? cause
          : new ThreadHandoffError({ message: "Could not hand off this thread.", cause }),
      ),
    );

  return ThreadHandoff.of({ handoff });
});

export const layer = Layer.effect(ThreadHandoff, make);
