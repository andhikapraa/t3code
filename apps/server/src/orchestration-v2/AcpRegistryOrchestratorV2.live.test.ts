import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  type ModelSelection,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ResetCreditCoordinator from "../provider/Layers/resetCreditCoordinator.ts";
import { FetchHttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import { ProviderInstanceRegistryHydrationLive } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ProviderEventLoggers from "../provider/Layers/ProviderEventLoggers.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerLedger from "../provider/OpenCodeServerLedger.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";
import { OrchestrationV2LayerLive, ProjectServiceLayerLive } from "./runtimeLayer.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";

// The Antigravity switch is a durable, named conformance fixture for Google's
// official Registry distribution. It uses credentials already owned by the
// Antigravity agent and never stores them in the test database.
//
// T3_ACP_ANTIGRAVITY_LIVE=1 ../../node_modules/.bin/vp test run \
//   src/orchestration-v2/AcpRegistryOrchestratorV2.live.test.ts
const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const runAntigravityFixture = process.env.T3_ACP_ANTIGRAVITY_LIVE === "1";
const liveAgentId = runAntigravityFixture
  ? "antigravity-acp"
  : process.env.T3_ACP_REGISTRY_LIVE_AGENT_ID?.trim() || "devin";
const liveCommandPath = process.env.T3_ACP_REGISTRY_LIVE_COMMAND?.trim();
// Local agents outside the registry, for example:
// T3_ACP_REGISTRY_LIVE_AGENT_ID=hermes T3_ACP_REGISTRY_LIVE_COMMAND=hermes T3_ACP_REGISTRY_LIVE_ARGS=acp
const liveLaunchArgs = process.env.T3_ACP_REGISTRY_LIVE_ARGS?.trim();
const liveInstanceId = ProviderInstanceId.make("acpRegistry_live");
const liveModelSelection = {
  instanceId: liveInstanceId,
  model: "default",
} satisfies ModelSelection;

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-registry-v2-live-",
});

const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(PlatformTestLayer),
);

const checkpointStoreLayer = CheckpointStore.layer.pipe(Layer.provide(vcsDriverRegistryLayer));

const serverSettingsLayer = ServerSettings.layerTest({
  providerInstances: {
    [liveInstanceId]: {
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `ACP Registry: ${liveAgentId}`,
      enabled: true,
      config: {
        agentId: liveAgentId,
        ...(liveCommandPath ? { commandPath: liveCommandPath } : {}),
        ...(liveLaunchArgs ? { launchArgs: liveLaunchArgs } : {}),
      },
    },
  },
});
const backgroundPolicyLayer = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(serverSettingsLayer),
);
const providerInstanceRegistryLayer = ProviderInstanceRegistryHydrationLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      serverConfigLayer.pipe(Layer.provide(PlatformTestLayer)),
      serverSettingsLayer,
      ServerSecretStore.layer.pipe(
        Layer.provide(serverConfigLayer),
        Layer.provide(PlatformTestLayer),
      ),
      NodeServices.layer,
      FetchHttpClient.layer,
      OpenCodeRuntime.OpenCodeRuntimeLive.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(PlatformTestLayer),
      ),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      ModelManifest.layerTest,
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(serverConfigLayer.pipe(Layer.provide(PlatformTestLayer))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(PlatformTestLayer),
      ),
      // The Codex driver now resolves managed ChatGPT installs; these runs never launch Codex.
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  ),
);

const liveLayer = Layer.mergeAll(
  OrchestrationV2LayerLive.pipe(Layer.provide(ProjectServiceLayerLive)),
  ProjectServiceLayerLive,
).pipe(
  Layer.provide(
    Layer.merge(
      ProjectEnrichmentService.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(null),
            }),
            Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(checkpointStoreLayer),
  Layer.provide(serverConfigLayer),
  Layer.provide(serverSettingsLayer),
  Layer.provide(providerInstanceRegistryLayer),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(backgroundPolicyLayer),
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(PlatformTestLayer),
);

const waitForIdle = Effect.fn("AcpRegistryOrchestratorV2Live.waitForIdle")(function* (
  threadId: ThreadId,
  expectedRunCount: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (
      projection.runs.length >= expectedRunCount &&
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return projection;
    }
    yield* Effect.sleep("500 millis");
  }
  return yield* Effect.die(new Error(`Timed out waiting for ACP Registry thread ${threadId}.`));
});

// Opt-in tool round trip in Supervised mode. The workspace must exist where the
// agent runs, for example a scratch git repo:
// T3_ACP_REGISTRY_LIVE_TOOLS_WORKSPACE=/tmp/scratch (plus the agent variables above)
const liveToolsWorkspace = process.env.T3_ACP_REGISTRY_LIVE_TOOLS_WORKSPACE?.trim();

describe.runIf(liveToolsWorkspace !== undefined && liveToolsWorkspace.length > 0)(
  "ACP Registry V2 live tools",
  () => {
    it.live(
      "asks for approval in Supervised mode and reports tool activity",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projectId = ProjectId.make("project:acp-registry-live-tools");
          const threadId = ThreadId.make("thread:acp-registry-live-tools");
          yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
          yield* (yield* ProjectService.ProjectService).create({
            commandId: CommandId.make("command:acp-registry-live-tools:project"),
            projectId,
            title: "ACP Registry live tools",
            workspaceRoot: liveToolsWorkspace!,
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:acp-registry-live-tools:create"),
            threadId,
            projectId,
            title: `ACP Registry live tools: ${liveAgentId}`,
            modelSelection: liveModelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:acp-registry-live-tools:prompt"),
            threadId,
            messageId: MessageId.make("message:acp-registry-live-tools:prompt"),
            text: [
              "Use your tools for both steps, in this working directory:",
              "1. Create the file hermes_t3_probe.txt containing exactly the line: T3_TOOLS_OK",
              "2. Run the shell command `cat hermes_t3_probe.txt && echo T3_CMD_RAN`.",
              "Then reply with exactly: DONE",
            ].join("\n"),
            attachments: [],
            modelSelection: liveModelSelection,
            dispatchMode: { type: "start_immediately" },
          });

          // Approve every request until the run settles, recording what was asked.
          const askedKinds: Array<string> = [];
          let projection = yield* orchestrator.getThreadProjection(threadId);
          for (let attempt = 0; attempt < 900; attempt += 1) {
            projection = yield* orchestrator.getThreadProjection(threadId);
            const pending = projection.runtimeRequests.find((r) => r.status === "pending");
            if (pending !== undefined) {
              askedKinds.push(pending.kind);
              yield* Console.log(`Approving ${pending.kind} request ${pending.id}.`);
              yield* orchestrator.dispatch({
                type: "runtime-request.respond",
                commandId: CommandId.make(`command:acp-registry-live-tools:approve-${attempt}`),
                threadId,
                requestId: pending.id,
                decision: "accept",
              });
            } else if (
              projection.runs.length === 1 &&
              !projection.runs.some((run) =>
                ["queued", "starting", "running", "waiting"].includes(run.status),
              )
            ) {
              break;
            }
            yield* Effect.sleep("500 millis");
          }

          const toolItems = projection.turnItems.filter(
            (item) =>
              item.type === "file_change" ||
              item.type === "command_execution" ||
              item.type === "dynamic_tool",
          );
          yield* Console.log(
            `Asked: ${askedKinds.join(", ")}. Tool items: ${toolItems
              .map((item) => item.type)
              .join(
                ", ",
              )}. Reply: ${projection.messages.findLast((m) => m.role === "assistant")?.text}`,
          );
          assert.deepEqual(
            projection.runs.map((run) => run.status),
            ["completed"],
          );
          assert.isAtLeast(askedKinds.length, 1, "Supervised mode should surface an approval");
          assert.isTrue(toolItems.some((item) => item.type === "file_change"));
          assert.isTrue(toolItems.some((item) => item.type === "command_execution"));
        }).pipe(Effect.provide(liveLayer), Effect.scoped),
      480_000,
    );
  },
);

describe.runIf(runAntigravityFixture || process.env.T3_ACP_REGISTRY_LIVE_ORCHESTRATOR === "1")(
  "ACP Registry V2 live orchestrator",
  () => {
    it.live(
      `runs and resumes ${runAntigravityFixture ? "Google Antigravity" : "a real registry agent"} through the production V2 harness`,
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projectId = ProjectId.make("project:acp-registry-live");
          const threadId = ThreadId.make("thread:acp-registry-live");
          const marker = "ACP_REGISTRY_LIVE_7H3Q";

          // The production server starts this daemon at startup; provider turns run through it.
          yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
          // Runtime policy resolves per project, so the thread needs a real one.
          yield* (yield* ProjectService.ProjectService).create({
            commandId: CommandId.make("command:acp-registry-live:project"),
            projectId,
            title: "ACP Registry live",
            workspaceRoot: process.cwd(),
          });

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:acp-registry-live:create"),
            threadId,
            projectId,
            title: `ACP Registry live: ${liveAgentId}`,
            modelSelection: liveModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* Console.log(
            `ACP Registry thread created for '${liveAgentId}'; dispatching first prompt.`,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:acp-registry-live:first"),
            threadId,
            messageId: MessageId.make("message:acp-registry-live:first"),
            text: `Remember this opaque marker. Respond with exactly: ${marker}`,
            attachments: [],
            modelSelection: liveModelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const firstProjection = yield* waitForIdle(threadId, 1);
          const firstAssistant = firstProjection.messages.findLast(
            (message) => message.role === "assistant",
          )?.text;

          assert.deepEqual(
            firstProjection.runs.map((run) => [run.providerInstanceId, run.status]),
            [[liveInstanceId, "completed"]],
          );
          assert.include(firstAssistant ?? "", marker);

          yield* Console.log("First ACP turn completed; dispatching continuation prompt.");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:acp-registry-live:second"),
            threadId,
            messageId: MessageId.make("message:acp-registry-live:second"),
            text: "Return the opaque marker from the previous turn. Respond with only the marker.",
            attachments: [],
            modelSelection: liveModelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const finalProjection = yield* waitForIdle(threadId, 2);
          const finalAssistant = finalProjection.messages.findLast(
            (message) => message.role === "assistant",
          )?.text;

          assert.deepEqual(
            finalProjection.runs.map((run) => [run.providerInstanceId, run.status]),
            [
              [liveInstanceId, "completed"],
              [liveInstanceId, "completed"],
            ],
          );
          assert.include(finalAssistant ?? "", marker);
          // A warm session may serve both turns; resuming a cold one adds another.
          assert.isAtLeast(finalProjection.providerSessions.length, 1);
          assert.isAtLeast(finalProjection.providerThreads.length, 1);
          assert.deepEqual(
            finalProjection.providerTurns.map((turn) => turn.status),
            ["completed", "completed"],
          );
        }).pipe(Effect.provide(liveLayer), Effect.scoped),
      480_000,
    );
  },
);
