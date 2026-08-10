import { describe, expect, it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  checkOmpProviderStatus,
  flattenOmpCommands,
  flattenOmpModels,
  makePendingOmpProvider,
  MINIMUM_OMP_VERSION,
  parseOmpCommands,
  parseOmpModels,
  parseOmpVersion,
} from "./OmpProvider.ts";

const decode = Schema.decodeSync(OmpSettings);
const settings = (overrides: Partial<OmpSettings> = {}) => decode(overrides);
const encoder = new TextEncoder();

const handle = (stdout = "", code = 0) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encoder.encode(stdout)) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const response = (command: string, key: string, rows: ReadonlyArray<unknown>) =>
  `${JSON.stringify({ type: "response", command, success: true, data: { [key]: rows } })}\n`;

function scriptedSpawner(input: {
  models?: ReadonlyArray<unknown>;
  commands?: ReadonlyArray<unknown>;
  modelCode?: number;
  commandCode?: number;
  seen?: Array<{ args: ReadonlyArray<string>; options?: Record<string, unknown> }>;
}) {
  let rpc = 0;
  return ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("standard command required");
      const current = command as unknown as {
        args: ReadonlyArray<string>;
        options?: Record<string, unknown>;
      };
      input.seen?.push(current);
      if (current.args[0] === "--version") return handle(`omp ${MINIMUM_OMP_VERSION}\n`);
      expect(current.args).toEqual(["--mode", "rpc", "--no-session"]);
      const call = rpc++;
      return call === 0
        ? handle(response("get_available_models", "models", input.models ?? []), input.modelCode)
        : handle(
            response("get_available_commands", "commands", input.commands ?? []),
            input.commandCode,
          );
    }),
  );
}

const run = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  value: OmpSettings = settings(),
  environment?: NodeJS.ProcessEnv,
) =>
  checkOmpProviderStatus(value, "/tmp/omp-test", environment).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.runPromise,
  );

describe("OMP parsers", () => {
  it("parses versions, response variants, thinking tiers, and malformed noise", () => {
    expect(MINIMUM_OMP_VERSION).toBe("17.0.9");
    expect(parseOmpVersion("omp v17.2.10")).toBe("17.2.10");
    expect(parseOmpVersion("dev")).toBeNull();
    const rows = parseOmpModels(
      `noise\n${JSON.stringify({
        type: "response",
        command: "get_available_models",
        data: [
          {
            provider: "openai",
            id: "gpt-5",
            name: "GPT-5",
            thinking: { efforts: ["high", " max ", "high"] },
          },
          { provider: "ollama", model: { name: "llama3" } },
        ],
      })}`,
    );
    expect(rows).toEqual([
      { provider: "openai", id: "gpt-5", name: "GPT-5", thinkingEffects: ["high", "max"] },
      { provider: "ollama", id: "llama3", name: "llama3", thinkingEffects: [] },
    ]);
    expect(flattenOmpModels(rows)[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "thinkingLevel",
      type: "select",
    });
  });

  it("groups, orders, and deduplicates commands", () => {
    const rows = parseOmpCommands(
      JSON.stringify({
        type: "response",
        command: "get_available_commands",
        commands: [
          { name: "fix", source: "extension", input: { hint: "scope" } },
          { name: "Compact", source: "builtin" },
          { name: "compact", source: "builtin" },
          { name: "review", source: "custom" },
          { name: "prompt", source: "file" },
          { name: "deploy", source: "skill" },
          { name: "other", source: "future" },
        ],
      }),
    );
    expect(rows.map((row) => row.group)).toEqual([
      "Extension",
      "Builtin",
      "Builtin",
      "Custom",
      "Prompt",
      "Skill",
      undefined,
    ]);
    const commands = flattenOmpCommands(rows);
    expect(commands.map((command) => command.name)).toEqual([
      "Compact",
      "fix",
      "review",
      "prompt",
      "deploy",
      "other",
    ]);
    expect(commands[1]?.input).toEqual({ hint: "scope" });
  });
});

describe("OMP snapshots", () => {
  it.effect("covers defaults, pending, disabled, and custom models", () =>
    Effect.gen(function* () {
      const pending = yield* makePendingOmpProvider(settings());
      expect(pending.status).toBe("warning");
      expect(pending.installed).toBe(false);
      const disabled = yield* makePendingOmpProvider(
        settings({ enabled: false, customModels: [" local/model "] }),
      );
      expect(disabled.status).toBe("disabled");
      expect(disabled.models.map((model) => model.slug)).toEqual(["local/model"]);
    }),
  );

  it("uses fixed RPC mode, returns models/commands, merges custom models, and preserves env", async () => {
    const seen: Array<{ args: ReadonlyArray<string>; options?: Record<string, unknown> }> = [];
    const environment = { PATH: "/opt/omp", OMP_TOKEN: "envelope" };
    const snapshot = await run(
      scriptedSpawner({
        seen,
        models: [
          {
            provider: "openai",
            id: "gpt-5",
            name: "GPT-5",
            thinking: { efforts: ["high"] },
          },
        ],
        commands: [{ name: "compact", source: "builtin" }],
      }),
      settings({
        launchArgs: "--mode rpc-ui --unsafe",
        profile: "work",
        customModels: ["openai/gpt-5", " local/private "],
      }),
      environment,
    );
    expect(seen.map((entry) => entry.args)).toEqual([
      ["--version"],
      ["--mode", "rpc", "--no-session"],
      ["--mode", "rpc", "--no-session"],
    ]);
    for (const entry of seen) {
      expect(entry.options?.env).toEqual(environment);
      expect(entry.options?.extendEnv).toBe(false);
      expect(entry.options?.cwd).toBe("/tmp/omp-test");
    }
    expect(snapshot.status).toBe("ready");
    expect(snapshot.models.map((model) => model.slug)).toEqual(["openai/gpt-5", "local/private"]);
    expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
  });

  it("covers version floor, missing binary, and generic version failures", async () => {
    const old = await run(ChildProcessSpawner.make(() => Effect.succeed(handle("omp 17.0.8\n"))));
    expect(old.status).toBe("error");
    expect(old.message).toContain("too old");

    const missing = await run(
      ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
          }),
        ),
      ),
    );
    expect(missing.installed).toBe(false);
    expect(missing.message).toContain("not installed");

    const generic = await run(
      ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "ChildProcess",
            method: "spawn",
          }),
        ),
      ),
    );
    expect(generic.installed).toBe(true);
    expect(generic.message).toContain("health check");
  });

  it("distinguishes abnormal/empty catalogs and degrades command failure", async () => {
    const abnormal = await run(scriptedSpawner({ modelCode: 7 }));
    expect(abnormal.status).toBe("warning");
    expect(abnormal.message).toContain("probe did not complete");
    expect(abnormal.message).not.toContain("API key");

    const empty = await run(scriptedSpawner({}));
    expect(empty.status).toBe("warning");
    expect(empty.message).toContain("did not report any available models");
    expect(empty.message).toContain("provider instance environment");

    const commandFailed = await run(
      scriptedSpawner({
        models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }],
        commandCode: 9,
      }),
    );
    expect(commandFailed.status).toBe("ready");
    expect(commandFailed.slashCommands).toEqual([]);
  });

  it("classifies catalog spawn failure as enrichment rather than missing binary", async () => {
    let calls = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("standard command required");
      calls += 1;
      if (calls === 1) return Effect.succeed(handle(`omp ${MINIMUM_OMP_VERSION}\n`));
      if (calls === 2) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "ChildProcess",
            method: "spawn",
          }),
        );
      }
      return Effect.succeed(handle(response("get_available_commands", "commands", [])));
    });
    const snapshot = await run(spawner);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain("probe did not complete");
  });

  it.effect("times out and terminates a scoped catalog child", () =>
    Effect.gen(function* () {
      const killed = yield* Ref.make(0);
      let calls = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command))
            return yield* Effect.die("standard command");
          calls += 1;
          if (calls === 1) return handle(`omp ${MINIMUM_OMP_VERSION}\n`);
          if (calls === 2) {
            const child = ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(2),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Ref.update(killed, (value) => value + 1),
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.never,
              stderr: Stream.never,
              all: Stream.never,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
            yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
            return child;
          }
          return handle(response("get_available_commands", "commands", []));
        }),
      );
      const fiber = yield* checkOmpProviderStatus(settings(), "/tmp/omp-test").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.minutes(2));
      const snapshot = yield* Fiber.join(fiber);
      expect(snapshot.message).toContain("timed out");
      expect(yield* Ref.get(killed)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
