import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import {
  makeOmpAdapter,
  mapOmpEvent,
  mapOmpSubagentFrame,
  ompUiRequestToQuestions,
  resolveOmpApprovalMode,
  resolveOmpLaunchArgs,
  splitOmpModelSlug,
} from "./OmpAdapter.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const instanceId = ProviderInstanceId.make("omp-test");
const threadId = ThreadId.make("thread-omp");
const decodeSettings = Schema.decodeSync(OmpSettings);
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownOption(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

interface ScriptedOmpState {
  readonly output: Queue.Queue<Uint8Array>;
  readonly commands: Queue.Queue<Record<string, unknown>>;
  readonly exitCode: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly handler: (command: Record<string, unknown>) => ReadonlyArray<Record<string, unknown>>;
}

const reply = (
  command: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: command.id,
  type: "response",
  command: command.type,
  success: true,
  ...extra,
});

const makeState = (handler: ScriptedOmpState["handler"]): Effect.Effect<ScriptedOmpState> =>
  Effect.gen(function* () {
    return {
      output: yield* Queue.unbounded<Uint8Array>(),
      commands: yield* Queue.unbounded<Record<string, unknown>>(),
      exitCode: yield* Deferred.make<ChildProcessSpawner.ExitCode>(),
      handler,
    };
  });

const makeSpawner = (
  state: ScriptedOmpState,
  onSpawn?: (args: ReadonlyArray<string>, options: ChildProcess.CommandOptions) => void,
) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die(new Error("Expected a standard OMP command"));
      }
      onSpawn?.(command.args, command.options);
      yield* Queue.offer(
        state.output,
        Buffer.from(
          `${encodeUnknownJson({
            type: "ready",
            protocolVersion: 2,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1024 * 1024,
            maxReassembledFrameBytes: 64 * 1024 * 1024,
          })}\n`,
        ),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Deferred.await(state.exitCode),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            const parsed = decodeUnknownJson(Buffer.from(chunk).toString("utf8").trim());
            if (Option.isNone(parsed)) return;
            const rpcCommand = parsed.value as Record<string, unknown>;
            yield* Queue.offer(state.commands, rpcCommand);
            for (const frame of state.handler(rpcCommand)) {
              yield* Queue.offer(state.output, Buffer.from(`${encodeUnknownJson(frame)}\n`));
            }
          }),
        ),
        stdout: Stream.fromQueue(state.output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

const testLayer = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ServerConfig.layerTest(process.cwd(), { prefix: "omp-adapter-test" }).pipe(
    Layer.provideMerge(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

describe("OMP adapter helpers", () => {
  it("maps runtime modes and launch configuration", () => {
    expect(resolveOmpApprovalMode("full-access")).toBe("yolo");
    expect(resolveOmpApprovalMode("approval-required")).toBe("always-ask");
    expect(resolveOmpApprovalMode("auto-accept-edits")).toBe("write");
    expect(
      resolveOmpLaunchArgs({
        cwd: "/workspace",
        sessionDir: "/state/omp",
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/state/omp/session.jsonl",
          sessionId: "session-1",
        },
        model: "anthropic/claude-sonnet",
        thinkingLevel: "high",
        approvalMode: "always-ask",
        profile: "work",
        launchArgs: "--no-lsp",
      }),
    ).toEqual([
      "--mode",
      "rpc-ui",
      "--session-dir",
      "/state/omp",
      "--cwd",
      "/workspace",
      "--resume",
      "/state/omp/session.jsonl",
      "--profile",
      "work",
      "--model",
      "anthropic/claude-sonnet",
      "--models",
      "anthropic/*",
      "--thinking",
      "high",
      "--approval-mode",
      "always-ask",
      "--no-lsp",
    ]);
    expect(splitOmpModelSlug("provider/model/variant")).toEqual({
      provider: "provider",
      modelId: "model/variant",
    });
  });

  it("maps assistant/tool events and extension questions", () => {
    expect(
      mapOmpEvent(
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } },
        { threadId, activeTurnId: undefined, messageItemId: "message-1" },
      ),
    ).toMatchObject([{ type: "content.delta", payload: { delta: "hello" } }]);
    expect(
      mapOmpEvent(
        { type: "tool_execution_start", toolName: "Task", toolCallId: "task-1", args: {} },
        { threadId, activeTurnId: undefined, messageItemId: undefined },
      ),
    ).toMatchObject([{ type: "item.started", payload: { itemType: "collab_agent_tool_call" } }]);
    expect(
      ompUiRequestToQuestions({
        method: "select",
        id: ApprovalRequestId.make("question-1"),
        title: "Choose",
        options: ["A", "B"],
      }),
    ).toEqual([
      {
        id: ApprovalRequestId.make("question-1"),
        header: "OMP extension",
        question: "Choose",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" },
        ],
        multiSelect: false,
      },
    ]);
  });
  it("maps subagent lifecycle, progress, and attributed child tools", () => {
    const translation = { threadId, activeTurnId: undefined, messageItemId: undefined };
    const started = mapOmpSubagentFrame(
      {
        type: "subagent_lifecycle",
        payload: {
          id: "ReviewAgent",
          index: 0,
          agent: "reviewer",
          agentSource: "bundled",
          description: "Review the migration",
          status: "started",
          parentToolCallId: "task-call-1",
          detached: true,
        },
      },
      translation,
    );
    expect(started).toMatchObject([
      {
        type: "task.started",
        payload: {
          taskId: "ReviewAgent",
          taskType: "subagent",
          agentKind: "agent",
          role: "reviewer",
          toolUseId: "task-call-1",
          timelineBypass: true,
        },
      },
    ]);

    const progress = mapOmpSubagentFrame(
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "reviewer",
          task: "Review the migration",
          parentToolCallId: "task-call-1",
          detached: true,
          progress: {
            id: "ReviewAgent",
            agent: "reviewer",
            status: "running",
            lastIntent: "Checking rollback behavior",
            currentTool: "read",
            tokens: 1200,
            requests: 2,
            durationMs: 500,
            resolvedModel: "openai/gpt-5.6",
          },
        },
      },
      translation,
    );
    expect(progress).toMatchObject([
      {
        type: "task.progress",
        payload: {
          taskId: "ReviewAgent",
          status: "running",
          summary: "Checking rollback behavior",
          lastToolName: "read",
          model: "openai/gpt-5.6",
        },
      },
    ]);

    const childTool = mapOmpSubagentFrame(
      {
        type: "subagent_event",
        payload: {
          id: "ReviewAgent",
          event: {
            type: "tool_execution_start",
            toolName: "read",
            toolCallId: "child-tool-1",
            args: {},
          },
        },
      },
      translation,
    );
    expect(childTool).toMatchObject([
      {
        type: "item.started",
        itemId: "child-tool-1",
        payload: { agentId: "ReviewAgent", itemType: "dynamic_tool_call" },
      },
    ]);

    const completed = mapOmpSubagentFrame(
      {
        type: "subagent_lifecycle",
        payload: {
          id: "ReviewAgent",
          index: 0,
          agent: "reviewer",
          agentSource: "bundled",
          status: "aborted",
        },
      },
      translation,
    );
    expect(completed).toMatchObject([
      { type: "task.completed", payload: { taskId: "ReviewAgent", status: "stopped" } },
    ]);
  });
});
describe("makeOmpAdapter scripted lifecycle", () => {
  it.effect("starts, resumes, sends, settles once, and stops one scoped process", () =>
    Effect.gen(function* () {
      const spawnArgs: Array<ReadonlyArray<string>> = [];
      const killCount = yield* Ref.make(0);
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [
            reply(command, {
              data: { sessionFile: "/state/session-1.jsonl", sessionId: "session-1" },
            }),
          ];
        }
        if (command.type === "prompt") {
          return [
            reply(command, { data: { agentInvoked: true } }),
            {
              type: "subagent_lifecycle",
              payload: {
                id: "SmokeAgent",
                index: 0,
                agent: "scout",
                description: "Inspect the provider",
                status: "started",
                parentToolCallId: "task-call-1",
              },
            },
            {
              type: "subagent_progress",
              payload: {
                index: 0,
                agent: "scout",
                task: "Inspect the provider",
                parentToolCallId: "task-call-1",
                progress: {
                  id: "SmokeAgent",
                  agent: "scout",
                  status: "running",
                  description: "Inspect the provider",
                  lastIntent: "Reading adapter code",
                  currentTool: "read",
                  tokens: 20,
                },
              },
            },
            {
              type: "subagent_event",
              payload: {
                id: "SmokeAgent",
                event: {
                  type: "tool_execution_start",
                  toolName: "read",
                  toolCallId: "child-tool-1",
                  args: {},
                },
              },
            },
            { type: "message_start", message: { role: "assistant", content: "" } },
            {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "done" },
            },
            { type: "message_end", message: { role: "assistant", content: "done" } },
            { type: "agent_end", isTerminal: true },
            { type: "agent_end", isTerminal: true },
          ];
        }
        if (command.type === "get_branch_messages") {
          return [reply(command, { data: { entries: [{ entryId: "entry-1" }] } })];
        }
        if (command.type === "abort") return [reply(command)];
        return [reply(command)];
      });
      const baseSpawner = makeSpawner(state, (args) => spawnArgs.push(args));
      const spawner = ChildProcessSpawner.make((command) =>
        baseSpawner.spawn(command).pipe(
          Effect.map((handle) => ({
            ...handle,
            kill: () => Ref.update(killCount, (count) => count + 1),
          })),
        ),
      );
      const adapter = yield* makeOmpAdapter(decodeSettings({ binaryPath: "omp-custom" }), {
        instanceId,
        environment: { OMP_TEST_TOKEN: "provider-instance-only" },
      }).pipe(Effect.provide(testLayer(spawner)));
      const events = yield* Ref.make<Array<string>>([]);
      const completed = yield* Deferred.make<undefined>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Ref.update(events, (types) => [...types, event.type]).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(undefined)(completed).pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet" },
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/state/prior.jsonl",
          sessionId: "prior",
        },
        runtimeMode: "full-access",
      });
      expect(session.status).toBe("ready");
      expect(spawnArgs[0]).toContain("--resume");
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
      expect(turn.threadId).toBe(threadId);
      yield* Deferred.await(completed);
      expect((yield* Ref.get(events)).filter((type) => type === "turn.completed")).toHaveLength(1);
      expect(yield* Ref.get(events)).toEqual(
        expect.arrayContaining(["task.started", "task.progress", "item.started"]),
      );
      yield* adapter.stopSession(threadId);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(events)).toEqual(expect.arrayContaining(["task.completed"]));
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(yield* Ref.get(killCount)).toBe(1);
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("switches the active OMP model and thinking tier before the next turn", () =>
    Effect.gen(function* () {
      const commands: Array<Record<string, unknown>> = [];
      const state = yield* makeState((command) => {
        commands.push(command);
        if (command.type === "get_state") {
          return [
            reply(command, {
              data: {
                sessionId: "session-switch",
                model: { provider: "openai", id: "base" },
                thinkingLevel: "low",
              },
            }),
          ];
        }
        if (command.type === "prompt") {
          return [reply(command, { data: { agentInvoked: false } })];
        }
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), {
        instanceId,
        commandTurnGraceMs: 0,
      }).pipe(Effect.provide(testLayer(makeSpawner(state))));
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "use the new selection",
        modelSelection: createModelSelection(instanceId, "anthropic/claude-sonnet", [
          { id: "thinkingLevel", value: "high" },
        ]),
      });
      expect(
        commands.filter((command) =>
          ["set_model", "set_thinking_level", "prompt"].includes(String(command.type)),
        ),
      ).toEqual([
        expect.objectContaining({
          type: "set_model",
          provider: "anthropic",
          modelId: "claude-sonnet",
        }),
        expect.objectContaining({ type: "set_thinking_level", level: "high" }),
        expect.objectContaining({ type: "prompt", message: "use the new selection" }),
      ]);
      yield* adapter.stopAll();
    }),
  );

  it.effect("settles legacy slash commands whose prompt response omits agentInvoked", () =>
    Effect.gen(function* () {
      let stateReads = 0;
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          stateReads += 1;
          return [
            reply(command, {
              data: {
                sessionId: "session-legacy-command",
                ...(stateReads > 1 ? { isStreaming: false } : {}),
              },
            }),
          ];
        }
        if (command.type === "prompt") {
          return [reply(command)];
        }
        if (command.type === "get_branch_messages") {
          return [reply(command, { data: { entries: [{ entryId: "legacy-command-boundary" }] } })];
        }
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), {
        instanceId,
        commandTurnGraceMs: 0,
      }).pipe(Effect.provide(testLayer(makeSpawner(state))));
      const completed = yield* Deferred.make<void>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "/help" });
      yield* Deferred.await(completed);
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );
  it.effect("keeps a false agentInvoked turn open while OMP is still streaming", () =>
    Effect.gen(function* () {
      let stateReads = 0;
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          stateReads += 1;
          return [
            reply(command, {
              data:
                stateReads === 1
                  ? { sessionId: "session-slow-agent" }
                  : { sessionId: "session-slow-agent", isStreaming: true },
            }),
          ];
        }
        if (command.type === "prompt") {
          return [reply(command, { data: { agentInvoked: false } })];
        }
        if (command.type === "get_branch_messages") {
          return [reply(command, { data: { entries: [{ entryId: "slow-boundary" }] } })];
        }
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), {
        instanceId,
        commandTurnGraceMs: 5,
      }).pipe(Effect.provide(testLayer(makeSpawner(state))));
      const events = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const completed = yield* Deferred.make<void>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Ref.update(events, (current) => [...current, event]).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "start slowly" });
      yield* Effect.yieldNow;
      expect((yield* Ref.get(events)).some((event) => event.type === "turn.completed")).toBe(false);

      for (const frame of [
        { type: "message_start", message: { role: "assistant", content: "" } },
        { type: "message_end", message: { role: "assistant", content: "done" } },
        { type: "agent_end", isTerminal: true },
      ]) {
        yield* Queue.offer(state.output, Buffer.from(`${encodeUnknownJson(frame)}\n`));
      }
      yield* Deferred.await(completed);
      expect(
        (yield* Ref.get(events)).filter((event) => event.type === "turn.completed"),
      ).toHaveLength(1);
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("emits OMP token usage and turn cost from assistant message_end", () =>
    Effect.gen(function* () {
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [
            reply(command, {
              data: {
                sessionId: "session-usage",
                model: { provider: "openai", id: "model-a" },
              },
            }),
          ];
        }
        if (command.type === "get_available_models") {
          return [
            reply(command, {
              data: {
                models: [{ provider: "openai", id: "model-a", contextWindow: 128_000 }],
              },
            }),
          ];
        }
        if (command.type === "prompt") {
          return [
            reply(command, { data: { agentInvoked: true } }),
            { type: "message_start", message: { role: "assistant", content: "" } },
            {
              type: "message_end",
              duration: 125.4,
              message: {
                role: "assistant",
                provider: "openai",
                model: "model-a",
                content: "done",
                usage: {
                  input: 100,
                  output: 20,
                  cacheRead: 50,
                  reasoningTokens: 5,
                  totalTokens: 170,
                  cost: { total: 0.012 },
                },
              },
            },
            { type: "agent_end", isTerminal: true },
          ];
        }
        if (command.type === "get_branch_messages") {
          return [reply(command, { data: { entries: [{ entryId: "usage-boundary" }] } })];
        }
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const events = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const completed = yield* Deferred.make<void>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Ref.update(events, (current) => [...current, event]).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "report usage" });
      yield* Deferred.await(completed);
      const runtimeEvents = yield* Ref.get(events);
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      expect(usageEvent?.type).toBe("thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        expect(usageEvent.payload.usage).toEqual({
          usedTokens: 170,
          totalProcessedTokens: 120,
          maxTokens: 128_000,
          inputTokens: 100,
          cachedInputTokens: 50,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          durationMs: 125,
          compactsAutomatically: true,
        });
      }
      const completedEvent = runtimeEvents.find((event) => event.type === "turn.completed");
      expect(completedEvent?.type).toBe("turn.completed");
      if (completedEvent?.type === "turn.completed") {
        expect(completedEvent.payload.totalCostUsd).toBe(0.012);
      }
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("emits turn completion before slow boundary metadata returns", () =>
    Effect.gen(function* () {
      const commands: Array<Record<string, unknown>> = [];
      const state = yield* makeState((command) => {
        commands.push(command);
        if (command.type === "get_state") {
          return [reply(command, { data: { sessionId: "session-boundary-queue" } })];
        }
        if (command.type === "prompt") {
          return [
            reply(command, { data: { agentInvoked: true } }),
            { type: "message_start", message: { role: "assistant", content: "" } },
            { type: "message_end", message: { role: "assistant", content: "done" } },
            { type: "agent_end", isTerminal: true },
          ];
        }
        if (command.type === "get_branch_messages") {
          return [];
        }
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const completed = yield* Deferred.make<void>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "finish before checkpoint metadata" });
      const completion = yield* Deferred.await(completed).pipe(
        Effect.timeoutOption(Duration.seconds(1)),
      );
      expect(Option.isSome(completion)).toBe(true);
      yield* Effect.yieldNow;
      expect(commands.some((command) => command.type === "get_branch_messages")).toBe(true);
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("rejects unsupported OMP selections without sending a turn", () =>
    Effect.gen(function* () {
      const commands: Array<Record<string, unknown>> = [];
      const state = yield* makeState((command) => {
        commands.push(command);
        if (command.type === "get_state") {
          return [
            reply(command, {
              data: {
                sessionId: "session-reject",
                model: { provider: "openai", id: "base" },
                thinkingLevel: "low",
              },
            }),
          ];
        }
        if (command.type === "set_thinking_level") {
          return [
            {
              ...reply(command),
              success: false,
              error: "Thinking level max is unsupported",
            },
          ];
        }
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      const failed = yield* adapter
        .sendTurn({
          threadId,
          input: "do not run on stale state",
          modelSelection: createModelSelection(instanceId, "anthropic/claude-sonnet", [
            { id: "thinkingLevel", value: "max" },
          ]),
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(commands.some((command) => command.type === "prompt")).toBe(false);
      expect(
        commands
          .filter((command) => command.type === "set_model")
          .map((command) => ({
            provider: command.provider,
            modelId: command.modelId,
          })),
      ).toEqual([
        { provider: "anthropic", modelId: "claude-sonnet" },
        { provider: "openai", modelId: "base" },
      ]);
      yield* adapter.stopAll();
    }),
  );

  it.effect("records turn boundaries and branches the active OMP session at rewind", () =>
    Effect.gen(function* () {
      const commands: Array<Record<string, unknown>> = [];
      let turnCount = 0;
      let branched = false;
      const state = yield* makeState((command) => {
        commands.push(command);
        if (command.type === "get_state") {
          return [
            reply(command, {
              data: {
                sessionFile: branched ? "/state/session-fork.jsonl" : "/state/session-main.jsonl",
                sessionId: branched ? "fork" : "main",
              },
            }),
          ];
        }
        if (command.type === "prompt") {
          turnCount += 1;
          return [
            reply(command, { data: { agentInvoked: true } }),
            { type: "message_start", message: { role: "assistant", content: "" } },
            { type: "message_end", message: { role: "assistant", content: `turn-${turnCount}` } },
            { type: "agent_end", isTerminal: true },
          ];
        }
        if (command.type === "get_branch_messages") {
          return [
            reply(command, {
              data: {
                entries:
                  turnCount < 2
                    ? [{ entryId: "boundary-1" }]
                    : [{ entryId: "boundary-1" }, { entryId: "boundary-2" }],
              },
            }),
          ];
        }
        if (command.type === "branch") {
          expect(command.entryId).toBe("boundary-2");
          branched = true;
          return [reply(command)];
        }
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "first" });
      while (true) {
        const cursor = (yield* adapter.listSessions())[0]?.resumeCursor as
          | { readonly turnBoundaries?: ReadonlyArray<string> }
          | undefined;
        if ((cursor?.turnBoundaries?.length ?? 0) >= 1) break;
        yield* Effect.yieldNow;
      }
      yield* adapter.sendTurn({ threadId, input: "second" });
      while (true) {
        const cursor = (yield* adapter.listSessions())[0]?.resumeCursor as
          | { readonly turnBoundaries?: ReadonlyArray<string> }
          | undefined;
        if ((cursor?.turnBoundaries?.length ?? 0) >= 2) break;
        yield* Effect.yieldNow;
      }
      const before = (yield* adapter.listSessions())[0]?.resumeCursor;
      expect(before).toMatchObject({
        sessionFile: "/state/session-main.jsonl",
        sessionId: "main",
        turnBoundaries: ["boundary-1", "boundary-2"],
      });
      yield* adapter.rollbackThread(threadId, 1);
      expect(branched).toBe(true);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toMatchObject({
        sessionFile: "/state/session-fork.jsonl",
        sessionId: "fork",
        turnBoundaries: ["boundary-1"],
      });
      yield* adapter.stopAll();
    }),
  );

  it.effect("vetoes OMP rewind for stale identity or unmappable boundaries", () =>
    Effect.gen(function* () {
      let stateReads = 0;
      let branchCalled = false;
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          stateReads += 1;
          return [
            reply(command, {
              data: {
                sessionFile: stateReads === 1 ? "/state/session-main.jsonl" : "/state/other.jsonl",
                sessionId: stateReads === 1 ? "main" : "other",
              },
            }),
          ];
        }
        if (command.type === "branch") branchCalled = true;
        return [
          reply(command, {
            data: { entries: [{ entryId: "boundary-1" }] },
          }),
        ];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/state/session-main.jsonl",
          sessionId: "main",
          turnBoundaries: ["boundary-1", "boundary-2"],
        },
        runtimeMode: "full-access",
      });
      const failed = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(branchCalled).toBe(false);
      yield* adapter.stopAll();
    }),
  );

  it.effect("vetoes OMP rewind when the recorded boundary left the active branch", () =>
    Effect.gen(function* () {
      let branchCalled = false;
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [
            reply(command, {
              data: { sessionFile: "/state/session-main.jsonl", sessionId: "main" },
            }),
          ];
        }
        if (command.type === "get_branch_messages") {
          return [reply(command, { data: { entries: [{ entryId: "boundary-1" }] } })];
        }
        if (command.type === "branch") branchCalled = true;
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/state/session-main.jsonl",
          sessionId: "main",
          turnBoundaries: ["boundary-1", "boundary-2"],
        },
        runtimeMode: "full-access",
      });
      expect(Exit.isFailure(yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit))).toBe(
        true,
      );
      expect(branchCalled).toBe(false);
      yield* adapter.stopAll();
    }),
  );

  it.effect("preserves extension request identity in fire-and-forget replies", () =>
    Effect.gen(function* () {
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [reply(command, { data: { sessionId: "session-ui" } })];
        }
        if (command.type === "prompt") {
          return [
            reply(command, { data: { agentInvoked: true } }),
            {
              type: "extension_ui_request",
              id: "dialog-1",
              method: "select",
              title: "Pick one",
              options: ["A", "B"],
            },
          ];
        }
        if (command.type === "extension_ui_response") return [];
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const requested = yield* Deferred.make<undefined>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "user-input.requested"
            ? Deferred.succeed(undefined)(requested).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "ask" });
      yield* Deferred.await(requested);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("dialog-1"), {
        "dialog-1": "B",
      });
      let response: Record<string, unknown> | undefined;
      while (response === undefined) {
        const command = yield* Queue.take(state.commands);
        if (command.type === "extension_ui_response") response = command;
      }
      expect(response).toEqual({ type: "extension_ui_response", id: "dialog-1", value: "B" });
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("maps approval decisions, rejects late replies, and auto-denies a repeated loop", () =>
    Effect.gen(function* () {
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [reply(command, { data: { sessionId: "session-approval" } })];
        }
        if (command.type === "prompt") {
          return [
            reply(command, { data: { agentInvoked: true } }),
            {
              type: "extension_ui_request",
              id: "approval-a",
              method: "select",
              title: "Run the first command?",
              options: ["Approve", "Deny"],
            },
            {
              type: "extension_ui_request",
              id: "approval-b",
              method: "select",
              title: "Run the second command?",
              options: ["Approve", "Deny"],
            },
          ];
        }
        if (
          command.type === "extension_ui_response" &&
          command.id === "approval-b" &&
          command.value === "Deny"
        ) {
          return [
            {
              type: "extension_ui_request",
              id: "approval-c",
              method: "select",
              title: "Retry the denied command?",
              options: ["Approve", "Deny"],
            },
          ];
        }
        if (command.type === "extension_ui_response") return [];
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const opened = yield* Queue.unbounded<string>();
      const resolutions = yield* Ref.make<Array<string>>([]);
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type === "request.opened") {
            return Queue.offer(opened, String(event.requestId));
          }
          if (event.type === "request.resolved") {
            const decision = event.payload.decision;
            return typeof decision === "string"
              ? Ref.update(resolutions, (items) => [...items, decision])
              : Effect.void;
          }
          return Effect.void;
        }),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "run commands" });
      expect([yield* Queue.take(opened), yield* Queue.take(opened)]).toEqual([
        "approval-a",
        "approval-b",
      ]);

      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval-a"), "accept");
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval-b"), "decline");

      const responses: Array<Record<string, unknown>> = [];
      while (responses.length < 3) {
        const command = yield* Queue.take(state.commands);
        if (command.type === "extension_ui_response") responses.push(command);
      }
      expect(responses).toEqual([
        { type: "extension_ui_response", id: "approval-a", value: "Approve" },
        { type: "extension_ui_response", id: "approval-b", value: "Deny" },
        { type: "extension_ui_response", id: "approval-c", value: "Deny" },
      ]);
      expect(yield* Ref.get(resolutions)).toEqual(["accept", "decline"]);
      const late = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make("approval-b"), "accept")
        .pipe(Effect.exit);
      expect(Exit.isFailure(late)).toBe(true);
      expect(Option.isNone(yield* Queue.poll(opened))).toBe(true);
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("round-trips select, confirm, input, and editor dialogs with original ids", () =>
    Effect.gen(function* () {
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [reply(command, { data: { sessionId: "session-dialogs" } })];
        }
        if (command.type === "prompt") {
          return [
            reply(command, { data: { agentInvoked: true } }),
            {
              type: "extension_ui_request",
              id: "select-1",
              method: "select",
              title: "Choose deployment",
              options: ["Blue", "Green"],
            },
            {
              type: "extension_ui_request",
              id: "confirm-1",
              method: "confirm",
              title: "Continue deployment?",
            },
            {
              type: "extension_ui_request",
              id: "input-1",
              method: "input",
              title: "Release name",
            },
            {
              type: "extension_ui_request",
              id: "editor-1",
              method: "editor",
              title: "Release notes",
            },
          ];
        }
        if (command.type === "extension_ui_response") return [];
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const requested = yield* Queue.unbounded<string>();
      const questions = yield* Ref.make<Array<string>>([]);
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type !== "user-input.requested") return Effect.void;
          const question = event.payload.questions[0]?.question;
          return Ref.update(questions, (items) => [
            ...items,
            typeof question === "string" ? question : "",
          ]).pipe(Effect.andThen(Queue.offer(requested, String(event.requestId))));
        }),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "ask all dialogs" });
      expect([
        yield* Queue.take(requested),
        yield* Queue.take(requested),
        yield* Queue.take(requested),
        yield* Queue.take(requested),
      ]).toEqual(["select-1", "confirm-1", "input-1", "editor-1"]);
      expect(yield* Ref.get(questions)).toEqual([
        "Choose deployment",
        "Continue deployment?",
        "Release name",
        "Release notes",
      ]);

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("select-1"), {
        "select-1": "Typed Other answer",
      });
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("confirm-1"), {
        "confirm-1": "Yes",
      });
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("input-1"), {
        "input-1": "release-2026",
      });
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("editor-1"), {
        "editor-1": "Detailed release notes",
      });

      const responses: Array<Record<string, unknown>> = [];
      while (responses.length < 4) {
        const command = yield* Queue.take(state.commands);
        if (command.type === "extension_ui_response") responses.push(command);
      }
      expect(responses).toEqual([
        { type: "extension_ui_response", id: "select-1", value: "Typed Other answer" },
        { type: "extension_ui_response", id: "confirm-1", confirmed: true },
        { type: "extension_ui_response", id: "input-1", value: "release-2026" },
        { type: "extension_ui_response", id: "editor-1", value: "Detailed release notes" },
      ]);
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("resolves pending approval and user input exactly once on interruption", () =>
    Effect.gen(function* () {
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [reply(command, { data: { sessionId: "session-cleanup" } })];
        }
        if (command.type === "prompt") {
          return [
            reply(command, { data: { agentInvoked: true } }),
            {
              type: "extension_ui_request",
              id: "approval-cleanup",
              method: "select",
              title: "Approve cleanup command?",
              options: ["Approve", "Deny"],
            },
            {
              type: "extension_ui_request",
              id: "input-cleanup",
              method: "input",
              title: "Cleanup value",
            },
          ];
        }
        if (command.type === "abort") return [];
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const opened = yield* Queue.unbounded<string>();
      const resolved = yield* Queue.unbounded<string>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type === "request.opened" || event.type === "user-input.requested") {
            return Queue.offer(opened, event.type);
          }
          if (event.type === "request.resolved" || event.type === "user-input.resolved") {
            return Queue.offer(resolved, event.type);
          }
          return Effect.void;
        }),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "open interactions" });
      expect([yield* Queue.take(opened), yield* Queue.take(opened)]).toEqual([
        "request.opened",
        "user-input.requested",
      ]);
      yield* adapter.interruptTurn(threadId);
      expect([yield* Queue.take(resolved), yield* Queue.take(resolved)].toSorted()).toEqual([
        "request.resolved",
        "user-input.resolved",
      ]);
      expect(
        Exit.isFailure(
          yield* adapter
            .respondToRequest(threadId, ApprovalRequestId.make("approval-cleanup"), "accept")
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* adapter
            .respondToUserInput(threadId, ApprovalRequestId.make("input-cleanup"), {
              "input-cleanup": "late",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(Option.isNone(yield* Queue.poll(resolved))).toBe(true);
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("settles interruption locally when abort acknowledgement is late", () =>
    Effect.gen(function* () {
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [reply(command, { data: { sessionId: "session-interrupt" } })];
        }
        if (command.type === "prompt") {
          return [reply(command, { data: { agentInvoked: true } })];
        }
        if (command.type === "abort") return [];
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const interrupted = yield* Deferred.make<undefined>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.completed" && event.payload.state === "interrupted"
            ? Deferred.succeed(undefined)(interrupted).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "long-running" });
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(interrupted);
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
      yield* adapter.stopAll();
    }),
  );

  it.effect("blocks a fresh turn until the interrupted turn terminal frame is consumed", () =>
    Effect.gen(function* () {
      let promptCount = 0;
      const state = yield* makeState((command) => {
        if (command.type === "get_state") {
          return [reply(command, { data: { sessionId: "session-interrupt-retry" } })];
        }
        if (command.type === "prompt") {
          promptCount += 1;
          if (promptCount === 1) {
            return [reply(command, { data: { agentInvoked: true } })];
          }
          return [
            reply(command, { data: { agentInvoked: true } }),
            { type: "message_start", message: { role: "assistant", content: "" } },
            { type: "message_end", message: { role: "assistant", content: "recovered" } },
            { type: "agent_end", isTerminal: true },
          ];
        }
        if (command.type === "abort") return [];
        if (command.type === "get_branch_messages") {
          return [reply(command, { data: { entries: [{ entryId: "retry-boundary" }] } })];
        }
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const terminalStates = yield* Ref.make<Array<string>>([]);
      const interrupted = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type !== "turn.completed") return Effect.void;
          return Ref.update(terminalStates, (current) => [...current, event.payload.state]).pipe(
            Effect.andThen(
              event.payload.state === "interrupted"
                ? Deferred.succeed(interrupted, undefined).pipe(Effect.ignore)
                : event.payload.state === "completed"
                  ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
                  : Effect.void,
            ),
          );
        }),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "first turn" });
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(interrupted);

      const blocked = yield* adapter.sendTurn({ threadId, input: "must wait" }).pipe(Effect.exit);
      expect(Exit.isFailure(blocked)).toBe(true);
      expect(promptCount).toBe(1);

      yield* Queue.offer(
        state.output,
        Buffer.from(`${encodeUnknownJson({ type: "agent_end", isTerminal: true })}\n`),
      );
      let resumed = false;
      for (let attempt = 0; attempt < 8 && !resumed; attempt += 1) {
        const result = yield* adapter
          .sendTurn({ threadId, input: "retry after terminal" })
          .pipe(Effect.exit);
        resumed = Exit.isSuccess(result);
        if (!resumed) yield* Effect.yieldNow;
      }
      expect(resumed).toBe(true);
      yield* Deferred.await(completed);
      expect(yield* Ref.get(terminalStates)).toEqual(["interrupted", "completed"]);
      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );

  it.effect("emits one failed terminal outcome when the process dies mid-turn", () =>
    Effect.gen(function* () {
      const state = yield* makeState((command) => {
        if (command.type === "get_state") return [reply(command, { data: { sessionId: "dead" } })];
        if (command.type === "prompt") return [reply(command, { data: { agentInvoked: true } })];
        return [reply(command)];
      });
      const adapter = yield* makeOmpAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(makeSpawner(state))),
      );
      const terminalEvents = yield* Ref.make<Array<string>>([]);
      const exited = yield* Deferred.make<undefined>();
      const collector = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "turn.completed") {
              yield* Ref.update(terminalEvents, (events) => [...events, event.payload.state]);
            }
            if (event.type === "session.exited") {
              yield* Deferred.succeed(undefined)(exited).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "work" });
      yield* Deferred.succeed(ChildProcessSpawner.ExitCode(143))(state.exitCode);
      yield* Deferred.await(exited);
      expect(yield* Ref.get(terminalEvents)).toEqual(["failed"]);
      yield* Fiber.interrupt(collector).pipe(Effect.ignore);
    }),
  );
});
