/**
 * Pi side questions (`/btw`) and handoffs (`/handoff`): prompt a throwaway
 * fork of a thread's Pi session and stream the reply.
 *
 * Pi RPC has no side-question command, and prompting the live process would
 * append to the thread. Instead a separate `pi --mode rpc --fork <session>`
 * runs with tools disabled and a temporary `--session-dir`, so the fork's
 * session file is deleted afterwards and the thread's own file is only read.
 *
 * Extensions stay enabled because Pi providers and models can come from
 * extensions (custom providers would vanish under `--no-extensions`). No user
 * is attached to this process, so extension dialogs are cancelled.
 */
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type { ModelSelection, PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField,
  piRecordString,
  type PiRpcRecord,
} from "../orchestration-v2/Adapters/PiRpc.ts";
import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../orchestration-v2/Adapters/piT3McpInjection.ts";
import { PI_THINKING_LEVELS } from "./Layers/piThinkingCapabilities.ts";
import { ProviderDriverError } from "./Errors.ts";

const PI_FORK_PROMPT_TIMEOUT_MS = 5 * 60_000;
const isProviderDriverError = Schema.is(ProviderDriverError);
const PI_KNOWN_THINKING_LEVELS: ReadonlySet<string> = new Set(PI_THINKING_LEVELS);
const PI_INHERIT_MODEL_SLUG = "default";
const PI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

const SIDE_INSTRUCTION = `[Side question from the user. This is not a new task: do not continue the work above, do not call tools, and do not claim to have changed anything. Answer directly and concisely in text.]`;

export interface SideQuestionTurn {
  readonly question: string;
  readonly answer: string;
}

/** One prompt carrying the instruction, earlier side turns, and the new question. */
export function buildPiSideQuestionPrompt(
  question: string,
  previousTurns: ReadonlyArray<SideQuestionTurn>,
): string {
  const earlier = previousTurns.map(
    (turn, index) =>
      `Earlier side question ${index + 1}: ${turn.question}\nYour answer: ${turn.answer}`,
  );
  return [
    SIDE_INSTRUCTION,
    ...earlier,
    earlier.length > 0 ? `Follow-up: ${question}` : question,
  ].join("\n\n");
}

// OMP's handoff-document prompt (pi-setup extensions/omp-compaction/prompts.ts),
// so a T3 handoff reads like the one the Pi extension writes.
const HANDOFF_INSTRUCTION = `<critical>
Write a handoff document for another instance of yourself.
The handoff MUST be sufficient for seamless continuation without access to this conversation.
Output ONLY the handoff document. No preamble, no commentary, no wrapper text.
Do not call tools.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, commands run
- Test results, observed failures
- Decisions made
- Partial work affecting the next step
Register: address the successor directly in the imperative ("Fix X", "Run Y"), never first person ("I need to...", "my attempt...").
The handoff mechanism is invisible to the document: NEVER list writing, generating, or delivering a handoff/summary/context document as progress or a next step. Progress and Next Steps cover the user's task only.
</instruction>

<output>
Use exactly this structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- Code snippets, file paths, function/type names, error messages, data essential to continue
- Repository state if relevant

## Next Steps
1. [What should happen next]
</output>`;

/** The handoff-document request, with the user's direction for the new thread when given. */
export function buildPiHandoffPrompt(focus: string | undefined): string {
  return focus === undefined
    ? HANDOFF_INSTRUCTION
    : `${HANDOFF_INSTRUCTION}\n\n<instruction>\nAdditional focus: ${focus}\n</instruction>`;
}

/**
 * Maps one Pi RPC event to fork-prompt output. `null` means "ignore".
 * Exported for tests: this is the protocol surface that can drift.
 */
export function classifyPiSideQuestionEvent(
  event: PiRpcRecord,
):
  | { readonly type: "delta"; readonly delta: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "dialog"; readonly id: string }
  | { readonly type: "done" }
  | null {
  switch (event["type"]) {
    case "message_update": {
      const update = piRecordField(event, "assistantMessageEvent");
      if (piRecordString(update, "type") !== "text_delta") return null;
      const delta = piRecordString(update, "delta") ?? "";
      return delta.length === 0 ? null : { type: "delta", delta };
    }
    case "message_end": {
      const message = piRecordField(event, "message");
      if (piRecordString(message, "role") !== "assistant") return null;
      if (piRecordString(message, "stopReason") !== "error") return null;
      return {
        type: "error",
        message: piRecordString(message, "errorMessage") ?? "Pi reported a model error.",
      };
    }
    case "extension_ui_request": {
      const id = piRecordString(event, "id");
      const method = piRecordString(event, "method");
      return id !== undefined && method !== undefined && PI_DIALOG_METHODS.has(method)
        ? { type: "dialog", id }
        : null;
    }
    case "agent_settled":
      return { type: "done" };
    default:
      return null;
  }
}

export interface PiForkPromptDeps {
  readonly piSettings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceId: string;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
}

interface PiForkSource {
  readonly cwd: string;
  /** The thread's Pi session file (Pi's native thread id in T3). */
  readonly nativeThreadId: string;
  readonly modelSelection: ModelSelection;
}

export const makePiSideQuestion =
  (input: PiForkPromptDeps) =>
  (
    request: PiForkSource & {
      readonly question: string;
      readonly previousTurns: ReadonlyArray<SideQuestionTurn>;
    },
  ): Stream.Stream<string, ProviderDriverError> =>
    streamPiForkPrompt(input, request, {
      message: buildPiSideQuestionPrompt(request.question, request.previousTurns),
      label: "side question",
    });

/** Writes a handoff document for the thread; fails when Pi returns no text. */
export const makePiHandoff =
  (input: PiForkPromptDeps) =>
  (
    request: PiForkSource & { readonly focus: string | undefined },
  ): Effect.Effect<string, ProviderDriverError> =>
    streamPiForkPrompt(input, request, {
      message: buildPiHandoffPrompt(request.focus),
      label: "handoff",
    }).pipe(
      Stream.mkString,
      Effect.map((document) => document.trim()),
      Effect.filterOrFail(
        (document) => document.length > 0,
        () =>
          new ProviderDriverError({
            driver: "pi",
            instanceId: input.instanceId,
            detail: "Pi wrote an empty handoff.",
          }),
      ),
    );

function streamPiForkPrompt(
  input: PiForkPromptDeps,
  request: PiForkSource,
  prompt: { readonly message: string; readonly label: string },
): Stream.Stream<string, ProviderDriverError> {
  const fail = (detail: string, cause?: unknown) =>
    new ProviderDriverError({
      driver: "pi",
      instanceId: input.instanceId,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  return Stream.callback<string, ProviderDriverError>((queue) =>
    Effect.gen(function* () {
      const resolvedLaunchArgs = resolvePiLaunchArgs(input.piSettings.launchArgs);
      if (!resolvedLaunchArgs.ok) return yield* fail(resolvedLaunchArgs.message);
      const sessionDir = yield* input.fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-pi-fork-" })
        .pipe(Effect.mapError((cause) => fail("Could not create a temporary session.", cause)));
      const launch = buildPiRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        environment: input.environment,
        mcpSession: undefined,
        extensionPath: undefined,
        disableTools: true,
      });
      const connection = yield* makePiRpcConnection({
        command: input.piSettings.binaryPath || "pi",
        args: [...launch.args, "--fork", request.nativeThreadId, "--session-dir", sessionDir],
        cwd: request.cwd,
        env: launch.env,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
        Effect.mapError((cause) => fail("Could not start Pi.", cause)),
      );

      const { modelSelection } = request;
      if (modelSelection.model !== PI_INHERIT_MODEL_SLUG) {
        const parsed = parsePiModelSlug(modelSelection.model);
        if (parsed === null) {
          return yield* fail(`Pi model '${modelSelection.model}' must use provider/model format.`);
        }
        yield* connection.request({
          type: "set_model",
          provider: parsed.provider,
          modelId: parsed.modelId,
        });
      }
      const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
      // Like the live session, skip levels Pi does not know rather than fail.
      if (thinking !== undefined && PI_KNOWN_THINKING_LEVELS.has(thinking)) {
        yield* connection.request({ type: "set_thinking_level", level: thinking });
      }

      yield* connection.request({ type: "prompt", message: prompt.message });
      while (true) {
        const outcome = classifyPiSideQuestionEvent(yield* Queue.take(connection.events));
        if (outcome === null) continue;
        if (outcome.type === "delta") yield* Queue.offer(queue, outcome.delta);
        else if (outcome.type === "dialog") {
          yield* connection.send({
            type: "extension_ui_response",
            id: outcome.id,
            cancelled: true,
          });
        } else if (outcome.type === "error") return yield* fail(outcome.message);
        else break;
      }
      yield* Queue.end(queue);
    }).pipe(
      Effect.timeoutOrElse({
        duration: PI_FORK_PROMPT_TIMEOUT_MS,
        orElse: () => Effect.fail(fail(`Pi ${prompt.label} timed out.`)),
      }),
      Effect.mapError((cause) =>
        isProviderDriverError(cause) ? cause : fail(`Pi ${prompt.label} failed.`, cause),
      ),
      Effect.catch((error) => Queue.fail(queue, error)),
    ),
  );
}
