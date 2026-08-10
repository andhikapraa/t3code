import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  OMP_MAX_FRAME_BYTES,
  OmpRpcFrameDecoder,
  makeOmpRpcClient,
  ompJsonlLines,
} from "./ompRuntime.ts";

const encoder = new TextEncoder();
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

const makeProcessHarness = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const commands = yield* Queue.unbounded<Record<string, unknown>>();
  const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Deferred.await(exitCode),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(
        () =>
          decodeUnknownJson(Buffer.from(chunk).toString("utf8").trim()) as Record<string, unknown>,
      ).pipe(Effect.flatMap((command) => Queue.offer(commands, command))),
    ),
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  return { handle, stdout, commands, exitCode };
});

const offerFrame = (queue: Queue.Queue<Uint8Array>, frame: Record<string, unknown>) =>
  Queue.offer(queue, encoder.encode(`${encodeUnknownJson(frame)}\n`));

describe("ompJsonlLines", () => {
  it.effect("uses LF framing and preserves Unicode line separators", () =>
    Stream.fromIterable([
      encoder.encode('{"type":"message_update","delta":"a'),
      encoder.encode('\u2028b\u2029c"}\r\n{"type":"ready"}\n'),
    ]).pipe(
      ompJsonlLines,
      Stream.runCollect,
      Effect.map((lines) => {
        expect(Array.from(lines)).toEqual([
          '{"type":"message_update","delta":"a\u2028b\u2029c"}',
          '{"type":"ready"}',
        ]);
      }),
    ),
  );

  it.effect("rejects an oversized physical frame before an unbounded carry forms", () =>
    Stream.make(encoder.encode("x".repeat(OMP_MAX_FRAME_BYTES))).pipe(
      ompJsonlLines,
      Stream.runDrain,
      Effect.exit,
      Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
    ),
  );
});

describe("OmpRpcFrameDecoder", () => {
  it("strictly reassembles a valid chunk sequence", () => {
    const decoder = new OmpRpcFrameDecoder();
    decoder.configure({ maxFrameBytes: 32, maxReassembledFrameBytes: 1024 });
    const logical = Buffer.from(encodeUnknownJson({ type: "response", id: "one", success: true }));
    const first = logical.subarray(0, 24);
    const second = logical.subarray(24);
    expect(
      decoder.push({
        type: "rpc_chunk",
        chunkId: "chunk-1",
        index: 0,
        count: 2,
        byteLength: logical.byteLength,
        data: first.toString("base64"),
      }),
    ).toBeUndefined();
    expect(
      decoder.push({
        type: "rpc_chunk",
        chunkId: "chunk-1",
        index: 1,
        count: 2,
        byteLength: logical.byteLength,
        data: second.toString("base64"),
      }),
    ).toEqual({ type: "response", id: "one", success: true });
  });

  it("rejects interleaved chunks and advertised-limit overflow", () => {
    const decoder = new OmpRpcFrameDecoder();
    decoder.configure({ maxFrameBytes: 16, maxReassembledFrameBytes: 64 });
    expect(() =>
      decoder.push({
        type: "rpc_chunk",
        chunkId: "a",
        index: 0,
        count: 2,
        byteLength: 32,
        data: Buffer.from("1234567890123456").toString("base64"),
      }),
    ).not.toThrow();
    expect(() => decoder.push({ type: "ready" })).toThrow(/interrupted/);

    const capped = new OmpRpcFrameDecoder();
    capped.configure({ maxFrameBytes: 16, maxReassembledFrameBytes: 32 });
    expect(() =>
      capped.push({
        type: "rpc_chunk",
        chunkId: "large",
        index: 0,
        count: 2,
        byteLength: 33,
        data: Buffer.from("1234567890123456").toString("base64"),
      }),
    ).toThrow(/metadata/);
  });
});

describe("makeOmpRpcClient", () => {
  it.effect("gates on ready and correlates out-of-order responses by id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProcessHarness;
        const client = yield* makeOmpRpcClient({ child: harness.handle });
        expect(Option.isNone(yield* Queue.poll(harness.commands))).toBe(true);
        const requests = yield* Effect.all(
          [client.send({ type: "first" }), client.send({ type: "second" })],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        expect(Option.isNone(yield* Queue.poll(harness.commands))).toBe(true);
        yield* offerFrame(harness.stdout, {
          type: "ready",
          protocolVersion: 2,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: OMP_MAX_FRAME_BYTES,
          maxReassembledFrameBytes: 1024 * 1024,
        });
        const first = yield* Queue.take(harness.commands);
        const second = yield* Queue.take(harness.commands);
        yield* offerFrame(harness.stdout, {
          type: "response",
          id: second.id,
          command: second.type,
          success: true,
          data: { order: 2 },
        });
        yield* offerFrame(harness.stdout, {
          type: "response",
          id: first.id,
          command: first.type,
          success: true,
          data: { order: 1 },
        });
        const responses = yield* Fiber.join(requests);
        expect(responses.map((response) => response.data)).toEqual([{ order: 1 }, { order: 2 }]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails a command when the process dies before ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProcessHarness;
        const client = yield* makeOmpRpcClient({ child: harness.handle });
        const request = yield* client
          .send({ type: "get_state" })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.succeed(ChildProcessSpawner.ExitCode(143))(harness.exitCode);
        const exit = yield* Fiber.join(request);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
