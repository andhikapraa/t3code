import type { SideQuestionTopic } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** The `/btw` side conversation as a composer notice. It never enters the thread. */
export function sideQuestionBannerItem(input: {
  readonly topic: SideQuestionTopic;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}): ComposerBannerStackItem {
  const last = input.topic.turns.at(-1);
  const running = last?.status === "running";
  const answer = input.topic.turns.findLast((turn) => turn.answer.trim())?.answer;
  return {
    id: `side-question:${input.topic.id}`,
    variant: last?.status === "failed" ? "error" : "info",
    priority: running ? "activity" : "notice",
    icon: <MessageCircleQuestionIcon />,
    title: "Side question",
    description: running ? "Answering. Not added to the thread." : "Not added to the thread.",
    actions: running ? (
      <Button size="xs" variant="ghost" onClick={input.onCancel}>
        Stop
      </Button>
    ) : answer ? (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          void writeTextToClipboard(answer, "Side answer").catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Could not copy answer",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          });
        }}
      >
        Copy
      </Button>
    ) : undefined,
    dismissLabel: "Close side question",
    onDismiss: input.onClose,
    children: (
      <ComposerBanner.Scroll>
        <ComposerBanner.Body className="flex flex-col gap-3 pt-1 pb-1.5 pe-2">
          {input.topic.turns.map((turn, index) => (
            // Turns only append, so the index is stable.
            // oxlint-disable-next-line react/no-array-index-key
            <div key={index} className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">{turn.question}</span>
              {turn.answer ? (
                <ChatMarkdown
                  text={turn.answer}
                  cwd={input.cwd}
                  environmentId={input.environmentId}
                  isStreaming={turn.status === "running"}
                  className="text-sm"
                />
              ) : turn.status === "running" ? (
                <span className="text-xs text-muted-foreground">Thinking…</span>
              ) : null}
              {turn.status === "cancelled" ? (
                <span className="text-xs text-muted-foreground">Stopped</span>
              ) : turn.status === "failed" ? (
                <span className="text-xs text-destructive">{turn.errorMessage}</span>
              ) : null}
            </div>
          ))}
          {!running ? (
            <span className="text-xs text-muted-foreground">
              /btw again to follow up. Close to start a new side question.
            </span>
          ) : null}
        </ComposerBanner.Body>
      </ComposerBanner.Scroll>
    ),
  };
}
