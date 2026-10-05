import { DEFAULT_SERVER_SETTINGS, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { scheduledTaskSetupMessage } from "@t3tools/client-runtime/scheduled-task-setup";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useMemo, useRef, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { ControlPillMenu } from "../../../components/ControlPill";
import { makeTurnCommandMetadata } from "../../../lib/commandMetadata";
import { buildModelOptions } from "../../../lib/modelOptions";
import { buildProjectThreadStartTurnInput } from "../../../lib/projectThreadStartTurn";
import { useProjects } from "../../../state/entities";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { scheduledTaskDefaultModel } from "../scheduledTaskDraft";
import { SettingsSection } from "./SettingsSection";

function projectKey(project: EnvironmentProject): string {
  return `${project.environmentId}:${project.id}`;
}

/**
 * Describe recurring work in plain language; an agent thread sets it up with
 * schedule_task, asking questions and testing the checks first.
 */
export function ScheduleWithAgentComposer({
  targets,
  onStarted,
}: {
  readonly targets: readonly SettingsTarget[];
  readonly onStarted: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects.filter((project) =>
        targets.some((target) => target.environmentId === project.environmentId),
      ),
    [allProjects, targets],
  );
  const environmentLabels = useMemo(
    () => new Map(targets.map((entry) => [entry.environmentId, entry.label])),
    [targets],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const project = projects.find((entry) => projectKey(entry) === selectedKey) ?? projects[0];
  const target = targets.find((entry) => entry.environmentId === project?.environmentId);
  if (!project || !target) return null;
  return (
    <ComposerForm
      key={project.environmentId}
      project={project}
      projects={projects}
      target={target}
      showEnvironment={targets.length > 1}
      environmentLabels={environmentLabels}
      onProjectChange={setSelectedKey}
      onStarted={onStarted}
    />
  );
}

/** Keyed by environment, so a picked model never carries to another machine. */
function ComposerForm({
  project,
  projects,
  target,
  showEnvironment,
  environmentLabels,
  onProjectChange,
  onStarted,
}: {
  readonly project: EnvironmentProject;
  readonly projects: readonly EnvironmentProject[];
  readonly target: SettingsTarget;
  readonly showEnvironment: boolean;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly onProjectChange: (key: string) => void;
  readonly onStarted: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const config = target.serverConfig;
  const modelOptions = useMemo(() => buildModelOptions(config, null), [config]);
  const [pickedModelKey, setPickedModelKey] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const selection =
    modelOptions.find((option) => option.key === pickedModelKey)?.selection ??
    scheduledTaskDefaultModel(config, project);
  const selectedModelLabel =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === selection?.instanceId &&
        option.selection.model === selection?.model,
    )?.label ??
    selection?.model ??
    "No models available";
  const canSend = prompt.trim().length > 0 && selection !== null && !sending;

  const submit = async () => {
    const request = prompt.trim();
    if (sendingRef.current || !request || !selection) return;
    sendingRef.current = true;
    setSending(true);
    const metadata = makeTurnCommandMetadata();
    const runtimeMode = resolveProjectSettings(
      config.settings ?? DEFAULT_SERVER_SETTINGS,
      project.id,
      project,
    ).settings.defaultRuntimeMode;
    const result = await startTurn({
      environmentId: project.environmentId,
      input: buildProjectThreadStartTurnInput({
        ...metadata,
        projectId: project.id,
        projectCwd: project.workspaceRoot,
        text: scheduledTaskSetupMessage(request),
        uploadedAttachments: [],
        modelSelection: selection,
        runtimeMode,
        interactionMode: "default",
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
        worktreeBranchName: "",
      }),
    });
    sendingRef.current = false;
    setSending(false);
    if (result._tag === "Failure") {
      Alert.alert("Could not start the setup thread", String(squashAtomCommandFailure(result)));
      return;
    }
    setPrompt("");
    onStarted(project.environmentId, ThreadId.make(metadata.threadId));
  };

  return (
    <SettingsSection title="Set up with an agent">
      <View className="gap-2 px-4 py-3">
        <TextInput
          accessibilityLabel="Describe a recurring task"
          value={prompt}
          onChangeText={setPrompt}
          readOnly={sending}
          multiline
          scrollEnabled
          textAlignVertical="top"
          placeholder="Every weekday at 9:00, check for new errors and summarize them"
          placeholderTextColorClassName="accent-foreground-muted"
          className="max-h-40 min-h-20 font-sans text-base text-foreground"
        />
        <View className="flex-row items-center gap-2">
          <ControlPillMenu
            actions={projects.map((entry) => ({
              id: projectKey(entry),
              title: entry.title,
              ...(showEnvironment ? { subtitle: environmentLabels.get(entry.environmentId) } : {}),
              state: projectKey(entry) === projectKey(project) ? "on" : undefined,
            }))}
            onPressAction={({ nativeEvent }) => onProjectChange(nativeEvent.event)}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Project, ${project.title}`}
              className="min-w-0 shrink flex-row items-center gap-1 rounded-full bg-subtle px-3 py-2 active:opacity-70"
            >
              <Text className="shrink text-sm text-foreground" numberOfLines={1}>
                {project.title}
              </Text>
              <SymbolView
                name="chevron.down"
                size={11}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            </Pressable>
          </ControlPillMenu>
          <ControlPillMenu
            actions={modelOptions.map((option) => ({
              id: option.key,
              title: option.label,
              subtitle: option.providerLabel,
              state:
                option.selection.instanceId === selection?.instanceId &&
                option.selection.model === selection?.model
                  ? "on"
                  : undefined,
            }))}
            onPressAction={({ nativeEvent }) => setPickedModelKey(nativeEvent.event)}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Model, ${selectedModelLabel}`}
              className="min-w-0 shrink flex-row items-center gap-1 rounded-full bg-subtle px-3 py-2 active:opacity-70"
            >
              <Text className="shrink text-sm text-foreground" numberOfLines={1}>
                {selectedModelLabel}
              </Text>
              <SymbolView
                name="chevron.down"
                size={11}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            </Pressable>
          </ControlPillMenu>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Set up with agent"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={() => void submit()}
            className="ml-auto size-9 items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-40"
          >
            <SymbolView
              name="arrow.up"
              size={16}
              tintColorClassName="accent-primary-foreground"
              type="monochrome"
            />
          </Pressable>
        </View>
      </View>
    </SettingsSection>
  );
}
