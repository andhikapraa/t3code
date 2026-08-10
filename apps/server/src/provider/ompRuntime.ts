import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Schema from "effect/Schema";

export const OMP_COMMAND_TIMEOUT_MS = 30_000;
export const OMP_MAX_FRAME_BYTES = 1024 * 1024;
export const OMP_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const OMP_CHUNK_PAYLOAD_BYTES = 256 * 1024;
const OMP_NEGOTIATE_TIMEOUT_MS = 5_000;
const UTF8_SCAN_CHUNK_BYTES = 64 * 1024;
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

export type OmpRpcEvent = Record<string, unknown> & { readonly type: string };

export class OmpRpcCommandError extends Data.TaggedError("OmpRpcCommandError")<{
  readonly command: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${this.detail} (command '${this.command}')`;
  }
}

export class OmpRpcProtocolError extends Data.TaggedError("OmpRpcProtocolError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface OmpRpcResponse {
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly code?: string;
}

export interface OmpRpcClient {
  readonly send: (
    command: Record<string, unknown>,
  ) => Effect.Effect<OmpRpcResponse, OmpRpcCommandError>;
  readonly sendFireAndForget: (
    command: Record<string, unknown>,
  ) => Effect.Effect<void, OmpRpcCommandError>;
  readonly events: Queue.Queue<OmpRpcEvent>;
  readonly failPending: (detail: string) => Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

interface OmpReadyFrame {
  readonly protocolVersion: number;
  readonly supportedProtocolVersions: ReadonlyArray<number>;
  readonly maxFrameBytes: number;
  readonly maxReassembledFrameBytes: number;
}

interface PendingChunks {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  nextIndex: number;
  receivedBytes: number;
  readonly chunks: Array<Uint8Array>;
}

const boundedPositiveInteger = (value: unknown, fallback: number, ceiling: number): number =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), ceiling) : fallback;

function parseReadyFrame(record: Record<string, unknown>): OmpReadyFrame {
  return {
    protocolVersion: Number.isSafeInteger(record.protocolVersion)
      ? Number(record.protocolVersion)
      : 1,
    supportedProtocolVersions: Array.isArray(record.supportedProtocolVersions)
      ? record.supportedProtocolVersions.filter(
          (value): value is number => Number.isSafeInteger(value) && Number(value) > 0,
        )
      : [1],
    maxFrameBytes: boundedPositiveInteger(
      record.maxFrameBytes,
      OMP_MAX_FRAME_BYTES,
      OMP_MAX_FRAME_BYTES,
    ),
    maxReassembledFrameBytes: boundedPositiveInteger(
      record.maxReassembledFrameBytes,
      OMP_MAX_REASSEMBLED_FRAME_BYTES,
      OMP_MAX_REASSEMBLED_FRAME_BYTES,
    ),
  };
}

function decodeCanonicalBase64(value: unknown, maxBytes: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new OmpRpcProtocolError({ detail: "Invalid omp rpc_chunk data." });
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maxBytes || bytes.toString("base64") !== value) {
    throw new OmpRpcProtocolError({ detail: "Invalid omp rpc_chunk data." });
  }
  return bytes;
}

/** Strict stateful decoder for protocol-v2 rpc_chunk sequences. */
export class OmpRpcFrameDecoder {
  private pending: PendingChunks | undefined;
  private maxFrameBytes = OMP_MAX_FRAME_BYTES;
  private maxReassembledFrameBytes = OMP_MAX_REASSEMBLED_FRAME_BYTES;

  configure(ready: Pick<OmpReadyFrame, "maxFrameBytes" | "maxReassembledFrameBytes">): void {
    this.maxFrameBytes = boundedPositiveInteger(
      ready.maxFrameBytes,
      OMP_MAX_FRAME_BYTES,
      OMP_MAX_FRAME_BYTES,
    );
    this.maxReassembledFrameBytes = boundedPositiveInteger(
      ready.maxReassembledFrameBytes,
      OMP_MAX_REASSEMBLED_FRAME_BYTES,
      OMP_MAX_REASSEMBLED_FRAME_BYTES,
    );
  }

  push(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new OmpRpcProtocolError({ detail: "OMP RPC frame must be a JSON object." });
    }
    const record = value as Record<string, unknown>;
    if (record.type !== "rpc_chunk") {
      if (this.pending !== undefined) {
        throw new OmpRpcProtocolError({ detail: "OMP rpc_chunk sequence was interrupted." });
      }
      return record;
    }

    const { chunkId, index, count, byteLength } = record;
    const maxChunkCount = Math.ceil(
      this.maxReassembledFrameBytes / Math.min(OMP_CHUNK_PAYLOAD_BYTES, this.maxFrameBytes),
    );
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      Number(index) < 0 ||
      Number(count) < 2 ||
      Number(count) > maxChunkCount ||
      Number(index) >= Number(count) ||
      Number(byteLength) < this.maxFrameBytes ||
      Number(byteLength) > this.maxReassembledFrameBytes
    ) {
      throw new OmpRpcProtocolError({ detail: "Invalid omp rpc_chunk metadata." });
    }

    const bytes = decodeCanonicalBase64(
      record.data,
      Math.min(OMP_CHUNK_PAYLOAD_BYTES, this.maxFrameBytes),
    );
    if (this.pending === undefined) {
      if (index !== 0) {
        throw new OmpRpcProtocolError({
          detail: "OMP rpc_chunk sequence must start at index zero.",
        });
      }
      this.pending = {
        chunkId,
        count: Number(count),
        byteLength: Number(byteLength),
        nextIndex: 0,
        receivedBytes: 0,
        chunks: [],
      };
    }

    const pending = this.pending;
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      throw new OmpRpcProtocolError({ detail: "OMP rpc_chunk sequence mismatch." });
    }

    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedBytes > pending.byteLength) {
      throw new OmpRpcProtocolError({
        detail: "OMP rpc_chunk sequence exceeds its declared byte length.",
      });
    }
    if (pending.nextIndex < pending.count) {
      return undefined;
    }
    if (pending.receivedBytes !== pending.byteLength) {
      throw new OmpRpcProtocolError({ detail: "OMP rpc_chunk sequence length mismatch." });
    }

    this.pending = undefined;
    const reassembled = Buffer.allocUnsafe(pending.byteLength);
    let offset = 0;
    for (const chunk of pending.chunks) {
      reassembled.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(reassembled);
    } catch (cause) {
      throw new OmpRpcProtocolError({
        detail: "OMP rpc_chunk payload is not valid UTF-8.",
        cause,
      });
    }
    let parsed: unknown;
    try {
      parsed = decodeUnknownJson(decoded);
    } catch (cause) {
      throw new OmpRpcProtocolError({
        detail: "OMP rpc_chunk payload is not valid JSON.",
        cause,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new OmpRpcProtocolError({
        detail: "OMP rpc_chunk payload must reassemble to a JSON object.",
      });
    }
    const parsedRecord = parsed as Record<string, unknown>;
    if (parsedRecord.type === "rpc_chunk") {
      throw new OmpRpcProtocolError({
        detail: "OMP rpc_chunk payload cannot contain another chunk frame.",
      });
    }
    return parsedRecord;
  }
}

/** LF-only JSONL framing with a hard physical-frame ceiling. */
export const ompJsonlLines = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxFrameBytes = OMP_MAX_FRAME_BYTES,
): Stream.Stream<string, E> =>
  stream.pipe(
    Stream.flatMap((chunk) => {
      const pieces: Array<Uint8Array> = [];
      for (let offset = 0; offset < chunk.byteLength; offset += UTF8_SCAN_CHUNK_BYTES) {
        pieces.push(chunk.subarray(offset, offset + UTF8_SCAN_CHUNK_BYTES));
      }
      return Stream.fromIterable(pieces);
    }),
    Stream.decodeText(),
    Stream.mapAccum(
      () => "",
      (carry, chunk) => {
        const combined = carry + chunk;
        const parts = combined.split("\n");
        const remainder = parts.pop() ?? "";
        for (const part of parts) {
          if (Buffer.byteLength(part, "utf8") + 1 > maxFrameBytes) {
            throw new OmpRpcProtocolError({
              detail: `OMP RPC frame exceeded ${maxFrameBytes} bytes.`,
            });
          }
        }
        if (Buffer.byteLength(remainder, "utf8") >= maxFrameBytes) {
          throw new OmpRpcProtocolError({
            detail: `OMP RPC frame exceeded ${maxFrameBytes} bytes.`,
          });
        }
        return [
          remainder,
          parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)),
        ] as const;
      },
    ),
  );

export const makeOmpRpcClient = Effect.fn("makeOmpRpcClient")(function* (input: {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly timeoutMs?: number;
}): Effect.fn.Return<OmpRpcClient, never, Crypto.Crypto | Scope.Scope> {
  const timeoutMs = input.timeoutMs ?? OMP_COMMAND_TIMEOUT_MS;
  const crypto = yield* Crypto.Crypto;
  const pendingRef = yield* Ref.make(
    new Map<string, Deferred.Deferred<OmpRpcResponse, OmpRpcCommandError>>(),
  );
  const stoppedRef = yield* Ref.make(false);
  const readyGate = yield* Deferred.make<OmpReadyFrame, OmpRpcCommandError>();
  const negotiatedRef = yield* Ref.make(false);
  const events = yield* Queue.unbounded<OmpRpcEvent>();
  const writePermit = yield* Semaphore.make(1);
  const decoder = new OmpRpcFrameDecoder();

  const failAllPending = Effect.fn("failAllPending")(function* (detail: string) {
    const pending = yield* Ref.getAndSet(pendingRef, new Map());
    yield* Effect.forEach(
      pending,
      ([, deferred]) =>
        Deferred.fail(new OmpRpcCommandError({ command: "rpc", detail }))(deferred).pipe(
          Effect.ignore,
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  const failTransport = (detail: string, cause?: unknown) =>
    Effect.gen(function* () {
      const error = new OmpRpcCommandError({ command: "rpc", detail, cause });
      yield* Deferred.fail(error)(readyGate).pipe(Effect.ignore);
      yield* failAllPending(detail);
      yield* Queue.shutdown(events).pipe(Effect.ignore);
    });

  const dropPending = (id: string) =>
    Ref.update(pendingRef, (pending) => {
      if (!pending.has(id)) return pending;
      const next = new Map(pending);
      next.delete(id);
      return next;
    });

  const registerPendingCommand = (commandName: string) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new OmpRpcCommandError({
              command: commandName,
              detail: "Failed to generate OMP RPC request id.",
              cause,
            }),
        ),
      );
      const deferred = yield* Deferred.make<OmpRpcResponse, OmpRpcCommandError>();
      yield* Ref.update(pendingRef, (pending) => {
        const next = new Map(pending);
        next.set(id, deferred);
        return next;
      });
      return { id, deferred } as const;
    });

  const writeCommand = (payload: Record<string, unknown>) => {
    const command = String(payload.type ?? "rpc");
    let line: string;
    try {
      line = `${encodeUnknownJson(payload)}\n`;
    } catch (cause) {
      return Effect.fail(
        new OmpRpcCommandError({
          command,
          detail: `Failed to serialize ${command} command for OMP.`,
          cause,
        }),
      );
    }
    if (Buffer.byteLength(line, "utf8") > OMP_MAX_FRAME_BYTES) {
      return Effect.fail(
        new OmpRpcCommandError({
          command,
          detail: `OMP command '${command}' exceeds the ${OMP_MAX_FRAME_BYTES}-byte frame limit.`,
        }),
      );
    }
    return Stream.run(Stream.encodeText(Stream.make(line)), input.child.stdin).pipe(
      Effect.mapError(
        (cause) =>
          new OmpRpcCommandError({
            command,
            detail: `Failed to write ${command} command to OMP process.`,
            cause,
          }),
      ),
    );
  };

  const awaitResponse = (
    name: string,
    id: string,
    deferred: Deferred.Deferred<OmpRpcResponse, OmpRpcCommandError>,
    commandTimeoutMs: number,
  ) =>
    Deferred.await(deferred).pipe(
      Effect.timeoutOption(Duration.millis(commandTimeoutMs)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new OmpRpcCommandError({
                command: name,
                detail: `OMP command '${name}' timed out after ${commandTimeoutMs}ms.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.ensuring(dropPending(id)),
    );

  const ensureProtocolNegotiated = Effect.fn("ensureProtocolNegotiated")(function* () {
    if (yield* Ref.get(negotiatedRef)) return;
    yield* Ref.set(negotiatedRef, true);
    const ready = yield* Deferred.await(readyGate);
    if (ready.protocolVersion >= 2 || !ready.supportedProtocolVersions.includes(2)) return;

    const { id, deferred } = yield* registerPendingCommand("negotiate_protocol");
    yield* writeCommand({ type: "negotiate_protocol", protocolVersion: 2, id }).pipe(
      Effect.andThen(
        awaitResponse("negotiate_protocol", id, deferred, OMP_NEGOTIATE_TIMEOUT_MS).pipe(
          Effect.tap((response) =>
            response.success
              ? Effect.void
              : Effect.logDebug("OMP declined protocol-v2 negotiation", {
                  error: response.error,
                }),
          ),
        ),
      ),
      Effect.ignore,
    );
  });

  const dispatchFrame = (record: Record<string, unknown>) =>
    Effect.gen(function* () {
      if (record.type === "ready") {
        const ready = parseReadyFrame(record);
        decoder.configure(ready);
        yield* Deferred.succeed(ready)(readyGate).pipe(Effect.ignore);
        return;
      }
      if (record.type !== "response") {
        yield* Queue.offer(events, record as OmpRpcEvent);
        return;
      }
      const id = typeof record.id === "string" ? record.id : undefined;
      if (id === undefined) return;
      const deferred = (yield* Ref.get(pendingRef)).get(id);
      if (deferred === undefined) return;
      const response: OmpRpcResponse = {
        id,
        command: typeof record.command === "string" ? record.command : "unknown",
        success: record.success === true,
        ...(record.data !== undefined ? { data: record.data } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
        ...(typeof record.code === "string" ? { code: record.code } : {}),
      };
      yield* Deferred.succeed(response)(deferred).pipe(Effect.ignore);
    });

  const readerFiber = yield* ompJsonlLines(input.child.stdout).pipe(
    Stream.runForEach((line) =>
      Effect.try({
        try: () => {
          if (line.trim().length === 0) return undefined;
          const parsed = decodeUnknownJson(line);
          return decoder.push(parsed);
        },
        catch: (cause) =>
          cause instanceof OmpRpcProtocolError
            ? cause
            : new OmpRpcProtocolError({ detail: "Malformed OMP RPC stdout frame.", cause }),
      }).pipe(
        Effect.flatMap((frame) => (frame === undefined ? Effect.void : dispatchFrame(frame))),
      ),
    ),
    Effect.catchCause((cause) =>
      failTransport("OMP RPC protocol stream failed.", cause).pipe(
        Effect.andThen(input.child.kill().pipe(Effect.ignore)),
      ),
    ),
    Effect.forkScoped,
  );

  const exitFiber = yield* input.child.exitCode.pipe(
    Effect.flatMap((code) => failTransport(`OMP process exited (code ${Number(code)}).`)),
    Effect.catchCause((cause) => failTransport("OMP process exit watcher failed.", cause)),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (yield* Ref.getAndSet(stoppedRef, true)) return;
      yield* failTransport("OMP process stopped.");
      yield* Fiber.interrupt(readerFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
    }),
  );

  const send: OmpRpcClient["send"] = (command) =>
    Effect.gen(function* () {
      const name = String(command.type ?? "rpc");
      if (yield* Ref.get(stoppedRef)) {
        return yield* new OmpRpcCommandError({ command: name, detail: "OMP process is stopped." });
      }
      yield* Deferred.await(readyGate);
      const { id, deferred } = yield* registerPendingCommand(name);
      yield* writePermit
        .withPermit(
          ensureProtocolNegotiated().pipe(Effect.andThen(writeCommand({ ...command, id }))),
        )
        .pipe(Effect.tapError(() => dropPending(id)));
      const response = yield* awaitResponse(name, id, deferred, timeoutMs);
      if (!response.success) {
        return yield* new OmpRpcCommandError({
          command: name,
          detail: response.error ?? `OMP command '${name}' was rejected.`,
        });
      }
      return response;
    });

  const sendFireAndForget: OmpRpcClient["sendFireAndForget"] = (command) =>
    Effect.gen(function* () {
      const name = String(command.type ?? "rpc");
      if (yield* Ref.get(stoppedRef)) {
        return yield* new OmpRpcCommandError({ command: name, detail: "OMP process is stopped." });
      }
      yield* Deferred.await(readyGate);
      yield* writePermit.withPermit(
        ensureProtocolNegotiated().pipe(Effect.andThen(writeCommand(command))),
      );
    });

  return {
    send,
    sendFireAndForget,
    events,
    failPending: failAllPending,
    stop: Effect.gen(function* () {
      if (yield* Ref.getAndSet(stoppedRef, true)) return;
      yield* failTransport("OMP process stopped.");
      yield* Fiber.interrupt(readerFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
      yield* input.child.kill().pipe(Effect.ignore);
    }),
  };
});
