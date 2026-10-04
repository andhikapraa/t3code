import type { SideQuestionTopic } from "@t3tools/client-runtime/state/threads";
import { Pressable, ScrollView, View } from "react-native";
import { Markdown } from "react-native-nitro-markdown";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

const openLink = (href: string) => void tryOpenExternalUrl(href, "markdown-link");

/** Same renderer as file previews: native selectable text, or the JS fallback. */
function SideAnswerMarkdown({ markdown }: { readonly markdown: string }) {
  const styles = useMarkdownPreviewStyles();
  return hasNativeSelectableMarkdownText() ? (
    <SelectableMarkdownText
      markdown={markdown}
      onLinkPress={openLink}
      textStyle={styles.nativeTextStyle}
    />
  ) : (
    <Markdown
      options={{ gfm: true }}
      renderers={styles.renderers}
      styles={styles.styles}
      theme={styles.theme}
    >
      {markdown}
    </Markdown>
  );
}

/** The `/btw` side conversation above the composer. It never enters the thread. */
export function ComposerSideQuestion({
  topic,
  onCancel,
  onClose,
}: {
  readonly topic: SideQuestionTopic;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}) {
  const running = topic.turns.at(-1)?.status === "running";
  const answer = topic.turns.findLast((turn) => turn.answer.trim())?.answer;
  return (
    <View className="px-4 pb-3">
      <View className="gap-2 rounded-[20px] border-continuous bg-card p-4">
        <View className="flex-row items-center gap-3">
          <Text className="min-w-0 flex-1 text-sm text-foreground">Side question</Text>
          <Pressable
            accessibilityLabel="Close side question"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onClose}
            className="p-1 active:opacity-60"
          >
            <SymbolView
              name="xmark"
              size={14}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
        <ScrollView className="max-h-72" nestedScrollEnabled>
          <View className="gap-3">
            {topic.turns.map((turn, index) => (
              // Turns only append, so the index is stable.
              // oxlint-disable-next-line react/no-array-index-key
              <View key={index} className="gap-1">
                <Text className="text-xs text-foreground-muted">{turn.question}</Text>
                {turn.answer ? (
                  <SideAnswerMarkdown markdown={turn.answer} />
                ) : turn.status === "running" ? (
                  <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
                    Thinking…
                  </Text>
                ) : null}
                {turn.status === "cancelled" ? (
                  <Text className="text-xs text-foreground-muted">Stopped</Text>
                ) : turn.status === "failed" ? (
                  <Text className="text-xs text-danger-foreground">{turn.errorMessage}</Text>
                ) : null}
              </View>
            ))}
          </View>
        </ScrollView>
        <View className="flex-row items-center gap-4">
          {running ? (
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              className="py-1 active:opacity-60"
            >
              <Text className="text-sm text-foreground">Stop</Text>
            </Pressable>
          ) : answer ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => copyTextWithHaptic(answer, { target: "side answer" })}
              className="py-1 active:opacity-60"
            >
              <Text className="text-sm text-foreground">Copy</Text>
            </Pressable>
          ) : null}
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            Not added to the thread. /btw again to follow up.
          </Text>
        </View>
      </View>
    </View>
  );
}
