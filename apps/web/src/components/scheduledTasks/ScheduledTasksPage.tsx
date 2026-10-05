import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ScheduledTaskId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { truncate } from "@t3tools/shared/String";
import { scheduledTaskSetupMessage } from "@t3tools/client-runtime/scheduled-task-setup";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { newMessageId, newThreadId } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useProjects, waitForThreadShell } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ScheduledTaskList } from "../settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/** The page lists every task, so its scope never narrows; it has no scope picker. */
const ALL_SCOPE = {};
const ignoreScopeChange = () => {};

export function ScheduledTasksPage(target: {
  readonly environmentId?: EnvironmentId | undefined;
  readonly taskId?: ScheduledTaskId | undefined;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Scheduled tasks breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Scheduled tasks</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer className="gap-8">
            <SettingsScopeProvider search={ALL_SCOPE} onChange={ignoreScopeChange}>
              <ScheduleWithAgentComposer />
              <ScheduledTaskList {...target} title="Tasks" />
            </SettingsScopeProvider>
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * Describe recurring work in plain language; an agent thread sets it up with
 * schedule_task, asking questions and testing the checks first.
 */
function ScheduleWithAgentComposer() {
  const { environments } = useEnvironments();
  const connectedEnvironments = useMemo(
    () =>
      environments.filter(
        (entry) => entry.connection.phase === "connected" && entry.serverConfig !== null,
      ),
    [environments],
  );
  const allProjects = useProjects();
  const [projectKey, setProjectKey] = useState("");
  const projects = useMemo(
    () =>
      allProjects.filter((project) =>
        connectedEnvironments.some((entry) => entry.environmentId === project.environmentId),
      ),
    [allProjects, connectedEnvironments],
  );
  const project =
    projects.find((entry) => `${entry.environmentId}:${entry.id}` === projectKey) ?? projects[0];
  if (!project) return null;
  return (
    <ComposerForm
      key={project.environmentId}
      project={project}
      projects={projects}
      connectedEnvironments={connectedEnvironments}
      onProjectChange={setProjectKey}
    />
  );
}

/** Keyed by environment, so model state never carries across machines. */
function ComposerForm({
  project,
  projects,
  connectedEnvironments,
  onProjectChange,
}: {
  readonly project: EnvironmentProject;
  readonly projects: readonly EnvironmentProject[];
  readonly connectedEnvironments: readonly EnvironmentPresentation[];
  readonly onProjectChange: (projectKey: string) => void;
}) {
  const navigate = useNavigate();
  const environmentId = project.environmentId;
  const showEnvironment = connectedEnvironments.length > 1;
  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const selection = pickedModel ?? scheduledTaskDefaultModel(settings, project, instanceEntries);
  const activeInstanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = selection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const submit = async () => {
    const request = prompt.trim();
    if (sendingRef.current || !request || !selection) return;
    sendingRef.current = true;
    setSending(true);
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const title = truncate(request, 50);
    const runtimeMode = resolveProjectSettings(settings, project.id, project).settings
      .defaultRuntimeMode;
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: scheduledTaskSetupMessage(request),
          attachments: [],
        },
        modelSelection: selection,
        titleSeed: title,
        runtimeMode,
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: project.id,
            title,
            modelSelection: selection,
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
        createdAt,
      },
    });
    sendingRef.current = false;
    setSending(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start the setup thread",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    setPrompt("");
    // The thread route redirects home when it cannot find the thread, so wait
    // for the new thread's shell to reach this client before opening it.
    await waitForThreadShell({ environmentId, threadId });
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };

  const canSend = prompt.trim().length > 0 && selection !== null && !sending;

  return (
    <form
      className="flex flex-col gap-1 rounded-lg border p-1.5 focus-within:border-ring"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        aria-label="Describe a recurring task"
        placeholder="Every weekday at 9:00, check Sentry for new errors and summarize them"
        unstyled
        value={prompt}
        disabled={sending}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex items-center gap-1">
        <Select
          value={`${project.environmentId}:${project.id}`}
          onValueChange={(value) => value && onProjectChange(value)}
        >
          <SelectTrigger
            aria-label="Project"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>{project.title}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {projects.map((entry) => {
              const environment = connectedEnvironments.find(
                (candidate) => candidate.environmentId === entry.environmentId,
              );
              return (
                <SelectItem
                  key={`${entry.environmentId}:${entry.id}`}
                  value={`${entry.environmentId}:${entry.id}`}
                >
                  {showEnvironment ? (
                    <EnvironmentMachineIcon
                      kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                      className="size-4"
                    />
                  ) : null}
                  {entry.title}
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <ProviderModelPicker
          disabled={sending}
          activeInstanceId={activeInstanceId}
          model={activeModel}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          isComposerOwned={false}
          onInstanceModelChange={(instanceId, model) => setPickedModel({ instanceId, model })}
        />
        <Button
          type="submit"
          size="icon-sm"
          className="ml-auto"
          disabled={!canSend}
          aria-label="Set up with agent"
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </form>
  );
}
