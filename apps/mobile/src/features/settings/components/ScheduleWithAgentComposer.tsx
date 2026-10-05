import { DEFAULT_SERVER_SETTINGS, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { scheduledTaskSetupMessage } from "@t3tools/client-runtime/scheduled-task-setup";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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
import { projectEnvironment } from "../../../state/projects";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { scheduledTaskDefaultModel } from "../scheduledTaskDraft";
import { SettingsSection } from "./SettingsSection";

/**
 * Where the setup thread starts: a project, or an environment's Scratch
 * project ("No project"), which the server creates on first use.
 */
interface ComposerTarget {
  readonly key: string;
  readonly environment: SettingsTarget;
  readonly project: EnvironmentProject | null;
  readonly label: string;
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
  const composerTargets = useMemo(() => {
    const projectTargets: ComposerTarget[] = allProjects.flatMap((project) => {
      const environment = targets.find((entry) => entry.environmentId === project.environmentId);
      return environment &&
        !isScratchProject(project, environment.serverConfig.scratchWorkspaceRoot)
        ? [
            {
              key: `${project.environmentId}:${project.id}`,
              environment,
              project,
              label: project.title,
            },
          ]
        : [];
    });
    const scratchTargets: ComposerTarget[] = targets
      .filter((entry) => entry.serverConfig.scratchWorkspaceRoot)
      .map((environment) => ({
        key: `${environment.environmentId}:scratch`,
        environment,
        project: null,
        label: "No project",
      }));
    return [...projectTargets, ...scratchTargets];
  }, [allProjects, targets]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const target = composerTargets.find((entry) => entry.key === selectedKey) ?? composerTargets[0];
  if (!target) return null;
  return (
    <ComposerForm
      key={target.environment.environmentId}
      target={target}
      targets={composerTargets}
      showEnvironment={targets.length > 1}
      onTargetChange={setSelectedKey}
      onStarted={onStarted}
    />
  );
}

/** Keyed by environment, so a picked model never carries to another machine. */
function ComposerForm({
  target,
  targets,
  showEnvironment,
  onTargetChange,
  onStarted,
}: {
  readonly target: ComposerTarget;
  readonly targets: readonly ComposerTarget[];
  readonly showEnvironment: boolean;
  readonly onTargetChange: (key: string) => void;
  readonly onStarted: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const environmentId = target.environment.environmentId;
  const config = target.environment.serverConfig;
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const modelOptions = useMemo(() => buildModelOptions(config, null), [config]);
  const [pickedModelKey, setPickedModelKey] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const selection =
    modelOptions.find((option) => option.key === pickedModelKey)?.selection ??
    scheduledTaskDefaultModel(config, target.project);
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
    let project = target.project;
    if (!project) {
      const opened = await openScratch({ environmentId, input: {} });
      if (opened._tag === "Failure") {
        sendingRef.current = false;
        setSending(false);
        if (!isAtomCommandInterrupted(opened)) {
          Alert.alert("Could not start the setup thread", String(squashAtomCommandFailure(opened)));
        }
        return;
      }
      project = opened.value;
    }
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
            actions={targets.map((entry) => ({
              id: entry.key,
              title: entry.label,
              ...(showEnvironment ? { subtitle: entry.environment.label } : {}),
              state: entry.key === target.key ? "on" : undefined,
            }))}
            onPressAction={({ nativeEvent }) => onTargetChange(nativeEvent.event)}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Project, ${target.label}`}
              className="min-w-0 shrink flex-row items-center gap-1 rounded-full bg-subtle px-3 py-2 active:opacity-70"
            >
              <Text className="shrink text-sm text-foreground" numberOfLines={1}>
                {target.label}
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
