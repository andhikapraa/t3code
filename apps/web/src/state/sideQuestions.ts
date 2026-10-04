import { RegistryContext } from "@effect/atom-react";
import {
  createSideQuestionCommand,
  isSideQuestionRunning,
  type SideQuestionTopic,
  updateLastSideQuestionTurn,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { randomUUID } from "../lib/utils";

const askSideQuestion = createSideQuestionCommand(connectionAtomRuntime);

/**
 * The visible `/btw` side conversation for one thread. Kept in component
 * memory only: switching threads or reloading discards it.
 */
export function useSideQuestion(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const registry = useContext(RegistryContext);
  const threadKey = environmentId && threadId ? `${environmentId}:${threadId}` : null;
  // Keyed by thread so another thread never shows this one's side conversation.
  const [state, setState] = useState<{ key: string; topic: SideQuestionTopic } | null>(null);
  const topic = state !== null && state.key === threadKey ? state.topic : null;
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const close = useCallback(() => {
    abortRef.current?.abort();
    setState(null);
  }, []);

  // Leaving the thread stops its in-flight answer and discards the conversation.
  const previousThreadKey = useRef(threadKey);
  useEffect(() => {
    if (previousThreadKey.current !== threadKey) {
      abortRef.current?.abort();
      setState(null);
    }
    previousThreadKey.current = threadKey;
  }, [threadKey]);
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Asks a new question, or a follow-up when the side conversation is open. */
  const ask = useCallback(
    async (question: string) => {
      if (environmentId === null || threadId === null || threadKey === null) return;
      if (isSideQuestionRunning(topic)) return;
      const previousTurns = topic?.turns ?? [];
      const abort = new AbortController();
      abortRef.current = abort;
      setState({
        key: threadKey,
        topic: {
          id: topic?.id ?? randomUUID(),
          turns: [...previousTurns, { question, answer: "", status: "running" }],
        },
      });
      const update = (change: Parameters<typeof updateLastSideQuestionTurn>[1]) =>
        setState((current) =>
          current?.key === threadKey
            ? { ...current, topic: updateLastSideQuestionTurn(current.topic, change) }
            : current,
        );
      const outcome = await askSideQuestion(registry, {
        environmentId,
        threadId,
        question,
        previousTurns,
        signal: abort.signal,
        onDelta: (delta) => update((turn) => ({ ...turn, answer: turn.answer + delta })),
      });
      // A newer question (after Close) owns the panel now; this outcome is stale.
      if (abortRef.current !== abort) return;
      abortRef.current = null;
      update((turn) => ({ ...turn, ...outcome }));
    },
    [environmentId, registry, threadId, threadKey, topic],
  );

  return { topic, running: isSideQuestionRunning(topic), ask, cancel, close };
}
