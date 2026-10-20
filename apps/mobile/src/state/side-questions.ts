import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  askThreadSideQuestion,
  cancelSideQuestion,
  closeSideQuestion,
  createSideQuestionCommand,
  isSideQuestionRunning,
  sideQuestionThreadKey,
  sideQuestionTopicAtom,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useContext } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { uuidv4 } from "../lib/uuid";

const askSideQuestion = createSideQuestionCommand(connectionAtomRuntime);

/**
 * The `/btw` side conversation for one thread. It lives in the atom registry,
 * so it stays open (and keeps streaming) while another thread is on screen.
 */
export function useSideQuestion(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const registry = useContext(RegistryContext);
  const threadKey =
    environmentId && threadId ? sideQuestionThreadKey(environmentId, threadId) : null;
  const topic = useAtomValue(sideQuestionTopicAtom(threadKey ?? ""));
  const visibleTopic = threadKey === null ? null : topic;

  return {
    topic: visibleTopic,
    running: isSideQuestionRunning(visibleTopic),
    ask: async (question: string) => {
      if (environmentId === null || threadId === null) return;
      await askThreadSideQuestion(registry, askSideQuestion, {
        environmentId,
        threadId,
        question,
        newTopicId: uuidv4,
      });
    },
    cancel: () => {
      if (threadKey !== null) cancelSideQuestion(threadKey);
    },
    close: () => {
      if (threadKey !== null) closeSideQuestion(registry, threadKey);
    },
  };
}
