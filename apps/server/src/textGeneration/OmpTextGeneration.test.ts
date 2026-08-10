import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

const instanceId = ProviderInstanceId.make("omp-text-test");
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

describe("makeOmpTextGeneration", () => {
  it.effect(
    "uses rpc mode, instance environment, profile, launch args, and terminal settlement",
    () =>
      Effect.gen(function* () {
        const output = yield* Queue.unbounded<Uint8Array>();
        const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const spawnCalls: Array<{
          readonly args: ReadonlyArray<string>;
          readonly options: ChildProcess.CommandOptions;
        }> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die(new Error("Expected standard OMP command"));
            }
            spawnCalls.push({ args: command.args, options: command.options });
            yield* Queue.offer(
              output,
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
              exitCode: Deferred.await(exitCode),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const rpc = decodeUnknownJson(
                    Buffer.from(chunk).toString("utf8").trim(),
                  ) as Record<string, unknown>;
                  if (rpc.type !== "prompt") return;
                  for (const frame of [
                    {
                      type: "response",
                      id: rpc.id,
                      command: "prompt",
                      success: true,
                      data: { agentInvoked: true },
                    },
                    { type: "agent_end", isTerminal: false },
                    {
                      type: "message_update",
                      assistantMessageEvent: {
                        type: "text_delta",
                        delta: '{"title":"OMP generated title"}',
                      },
                    },
                    { type: "agent_end", isTerminal: true },
                  ]) {
                    yield* Queue.offer(output, Buffer.from(`${encodeUnknownJson(frame)}\n`));
                  }
                }),
              ),
              stdout: Stream.fromQueue(output),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const environment = { PATH: "/bin", OMP_INSTANCE_TOKEN: "instance-only" };
        const textGeneration = yield* makeOmpTextGeneration(
          {
            enabled: true,
            binaryPath: "/opt/omp",
            launchArgs: "--no-lsp",
            profile: "work",
            customModels: [],
          },
          environment,
        ).pipe(
          Effect.provide(
            Layer.merge(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        );
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: "/workspace",
          message: "Implement OMP",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet" },
        });
        expect(generated).toEqual({ title: "OMP generated title" });
        expect(spawnCalls[0]?.args).toEqual([
          "--mode",
          "rpc",
          "--no-session",
          "--profile",
          "work",
          "--model",
          "anthropic/claude-sonnet",
          "--models",
          "anthropic/*",
          "--no-lsp",
        ]);
        expect(spawnCalls[0]?.options.env).toEqual(environment);
        expect(spawnCalls[0]?.options.stdin).toMatchObject({ endOnDone: false });
      }),
  );

  it.effect("rejects an empty model before spawning OMP", () =>
    Effect.gen(function* () {
      let spawnCalls = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalls += 1;
        return Effect.die(new Error("OMP should not spawn without a selected model"));
      });
      const textGeneration = yield* makeOmpTextGeneration({
        enabled: true,
        binaryPath: "/opt/omp",
        launchArgs: "",
        profile: "",
        customModels: [],
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
      const result = yield* textGeneration
        .generateThreadTitle({
          cwd: "/workspace",
          message: "Implement OMP",
          modelSelection: { instanceId, model: "   " },
        })
        .pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(Schema.is(TextGenerationError)(result.failure)).toBe(true);
        expect(String(result.failure)).toContain("requires a discovered or custom provider/model");
      }
      expect(spawnCalls).toBe(0);
    }),
  );
});
