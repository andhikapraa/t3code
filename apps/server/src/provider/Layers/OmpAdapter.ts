/**
 * OMP per-thread rpc-ui adapter.
 *
 * Each active session owns one scoped OMP process and one bounded RPC client.
 * OMP events are translated into provider-neutral runtime events; unknown
 * extension and protocol frames are logged and ignored.
 */
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type OmpSettings,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeMode,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  makeOmpRpcClient,
  OmpRpcCommandError,
  type OmpRpcClient,
  type OmpRpcEvent,
} from "../ompRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  makePiFamilyTokenUsageSnapshot,
  piFamilyContextWindowTable,
  piFamilyUsageFromEvent,
} from "./piFamilyUsage.ts";

const PROVIDER = ProviderDriverKind.make("omp");

export const OMP_RESUME_SCHEMA_VERSION = 1 as const;

export const OmpResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(OMP_RESUME_SCHEMA_VERSION),
  sessionFile: Schema.String,
  sessionId: Schema.optional(Schema.String),
  turnBoundaries: Schema.optional(Schema.Array(Schema.String)),
});
export type OmpResumeCursor = typeof OmpResumeCursor.Type;

const isOmpResumeCursorValue = Schema.is(OmpResumeCursor);
const isOmpRequestError = Schema.is(ProviderAdapterRequestError);
const isOmpValidationError = Schema.is(ProviderAdapterValidationError);

export const isOmpResumeCursor = (value: unknown): value is OmpResumeCursor =>
  isOmpResumeCursorValue(value);

/**
 * True when a provider request error is a timed-out RPC command (not a
 * rejection, a write failure, or process death). Only timeouts can hide a
 * live agent loop behind a missing response line.
 */
const isOmpPromptTimeoutError = (error: ProviderAdapterRequestError): boolean =>
  error.cause instanceof OmpRpcCommandError && error.cause.detail.includes("timed out after");

/** T3 runtime mode → OMP `--approval-mode` flag (ADR 0001 decision 4). */
export type OmpApprovalMode = "yolo" | "always-ask" | "write";

export function resolveOmpApprovalMode(
  runtimeMode: RuntimeMode | undefined,
): OmpApprovalMode | undefined {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "approval-required":
      return "always-ask";
    case "auto-accept-edits":
      // The `write` tier's exact prompt surface is unverified (ADR 0001
      // consequences) — the mapping is the design decision, pinned here.
      return "write";
    default:
      // `auto` (and anything unknown): OMP's own default approval mode.
      return undefined;
  }
}

/**
 * Launch argument contract:
 *   - always `--mode rpc-ui --session-dir <dir>` (ADR 0001 decision 5:
 *     rpc-ui is wire-identical to rpc but also exposes OMP's Ask tool,
 *     whose `select` dialogs map onto T3 user-input questions; MCP
 *     discovery starts in both modes and never blocks boot — OMP races
 *     startup connects against a 250 ms bound and finishes slow servers
 *     in the background, so first-turn tool availability is unchanged);
 *     OMP has no `--session-id`; a fresh session is created in the
 *     session dir.
 *   - resuming a forked session passes `--resume <sessionFile>`;
 *   - `--profile <name>` when the instance has one (per-instance isolation
 *     of auth/sessions/settings/caches);
 *   - deterministic model pinning: `--model provider/model` plus
 *     `--models provider/*` scoped to the chosen provider. A bare
 *     `--model` can let environment-provided credentials select an
 *     unintended default model, so the provider scope is always explicit;
 *   - `--thinking <level>` for a picked thinking tier;
 *   - `--approval-mode <mode>` from the thread's runtime mode;
 *   - user `launchArgs` tokens appended last.
 */
export const resolveOmpLaunchArgs = (input: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly resumeCursor: OmpResumeCursor | undefined;
  readonly model: string | undefined;
  /** Picked thinking tier (`off|minimal|low|medium|high|xhigh|max`); absent leaves OMP's default. */
  readonly thinkingLevel?: string | undefined;
  readonly approvalMode: OmpApprovalMode | undefined;
  readonly profile: string;
  readonly launchArgs: string;
}): ReadonlyArray<string> => {
  const args = ["--mode", "rpc-ui", "--session-dir", input.sessionDir, "--cwd", input.cwd];
  const cursor = input.resumeCursor;
  if (cursor?.sessionFile) {
    args.push("--resume", cursor.sessionFile);
  }
  if (input.profile.trim().length > 0) {
    args.push("--profile", input.profile.trim());
  }
  if (input.model !== undefined && input.model.trim().length > 0) {
    args.push("--model", input.model.trim());
    const provider = splitOmpModelSlug(input.model).provider;
    if (provider) {
      args.push("--models", `${provider}/*`);
    }
  }
  if (input.thinkingLevel !== undefined && input.thinkingLevel.length > 0) {
    args.push("--thinking", input.thinkingLevel);
  }
  if (input.approvalMode !== undefined) {
    args.push("--approval-mode", input.approvalMode);
  }
  args.push(...tokenizeCliArgs(input.launchArgs));
  return args;
};

/** First-`/` split of an OMP model slug (`provider`/`modelId`; model ids may contain `/`). */
export function splitOmpModelSlug(slug: string): {
  readonly provider?: string;
  readonly modelId: string;
} {
  const slashIndex = slug.indexOf("/");
  if (slashIndex === -1) {
    return { modelId: slug };
  }
  return {
    provider: slug.slice(0, slashIndex),
    modelId: slug.slice(slashIndex + 1),
  };
}

interface OmpAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly client: OmpRpcClient;
  /** Sole lifecycle handle for the session: closing it kills the child
   *  process and interrupts the pump/exit/stderr/boundary fibers. */
  readonly sessionScope: Scope.Closeable;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  /** The assistant stream failed during the active turn (OMP's
   *  `message_update` `error`, e.g. an upstream timeout). `agent_end`
   *  carries no outcome, so the turn's terminal state is decided here:
   *  settled + error ⇒ `turn.completed` "failed", never a silent "completed". */
  activeTurnError: string | undefined;
  /** Correlation id awaiting a possible local-only prompt_result frame. */
  activePromptRequestId: string | undefined;
  /** Current assistant message item id, for message_start → message_end
   *  correlation (OMP messages carry no ids of their own). */
  currentMessageItemId: string | undefined;
  readonly sessionFileRef: Ref.Ref<string | undefined>;
  readonly sessionIdRef: Ref.Ref<string | undefined>;
  readonly turnBoundariesRef: Ref.Ref<readonly string[]>;
  /** Extension dialogs awaiting a response (select/confirm/input/editor). */
  readonly pendingUiRequests: Map<ApprovalRequestId, OmpUiRequest>;
  /** Approval dialogs (`select` with exactly ["Approve","Deny"]) awaiting
   *  `thread.approval.respond`. */
  readonly pendingApprovals: Map<ApprovalRequestId, { readonly detail: string }>;
  /** One-shot: the next terminal `agent_end` follows an `abort` and must
   *  not close the turn or record a boundary. */
  readonly suppressNextSettled: Ref.Ref<boolean>;
  /** While true, approval-shaped `select` dialogs are auto-answered
   *  "Deny" without surfacing. OMP may retry after a Deny, and repeating
   *  the same dialog can otherwise stall the turn. Reset per turn. */
  readonly denyPendingSelects: Ref.Ref<boolean>;
  /** Set when the agent loop shows activity after a command prompt's
   *  response — blocks the synthetic command-turn completion. */
  readonly agentActivitySincePromptRef: Ref.Ref<boolean>;
  /** Last thinking level sent to the session, for mid-thread tier switches. */
  readonly lastThinkingLevelRef: Ref.Ref<string | undefined>;
  /** Subagents that remain live until an explicit lifecycle terminal frame or session teardown. */
  readonly liveSubagents: Map<string, OmpSubagentLifecyclePayload>;
  /** Boundary-recording jobs, serialized by a single scoped worker. */
  readonly boundaryJobs: Queue.Queue<void>;
  /** Cached `provider/model → contextWindow` catalog for usage snapshots. */
  readonly modelContextTableRef: Ref.Ref<ReadonlyMap<string, number> | undefined>;
  /** Session-cumulative new input and output tokens. */
  readonly processedTokensRef: Ref.Ref<{ readonly input: number; readonly output: number }>;
  /** USD cost accumulated across the active turn. */
  readonly turnCostUsdRef: Ref.Ref<number>;
  /** One-shot guard flipped by stop / unexpected exit. */
  readonly stopped: Ref.Ref<boolean>;
}

type OmpUiRequest =
  | {
      readonly method: "select";
      readonly id: ApprovalRequestId;
      /** Dialog title. The Ask tool puts the model's question here. */
      readonly title?: string | undefined;
      readonly options: ReadonlyArray<string>;
    }
  | { readonly method: "confirm"; readonly id: ApprovalRequestId }
  | { readonly method: "input"; readonly id: ApprovalRequestId }
  | { readonly method: "editor"; readonly id: ApprovalRequestId };

export interface OmpAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Test seam; production defaults to a two-second command-turn grace window. */
  readonly commandTurnGraceMs?: number;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface OmpEventTranslationInput {
  readonly threadId: ThreadId;
  readonly activeTurnId: TurnId | undefined;
  /** Current assistant message item id (set by message_start). */
  readonly messageItemId: string | undefined;
}

export interface OmpMappedEvent {
  readonly type: ProviderRuntimeEvent["type"];
  readonly payload: ProviderRuntimeEvent["payload"];
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
}
interface OmpSubagentLifecyclePayload {
  readonly id: string;
  readonly index: number;
  readonly agent: string;
  readonly agentSource?: string;
  readonly description?: string;
  readonly status: "started" | "completed" | "failed" | "aborted";
  readonly sessionFile?: string;
  readonly parentToolCallId?: string;
  readonly detached?: boolean;
}

interface OmpSubagentProgress {
  readonly id: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "aborted";
  readonly description?: string;
  readonly lastIntent?: string;
  readonly currentTool?: string;
  readonly tokens?: number;
  readonly requests?: number;
  readonly durationMs?: number;
  readonly resolvedModel?: string;
}

interface OmpSubagentProgressPayload {
  readonly index: number;
  readonly agent: string;
  readonly task: string;
  readonly assignment?: string;
  readonly parentToolCallId?: string;
  readonly sessionFile?: string;
  readonly detached?: boolean;
  readonly progress: OmpSubagentProgress;
}

interface OmpSubagentEventPayload {
  readonly id: string;
  readonly event: Record<string, unknown>;
}

type OmpSubagentFrame =
  | { readonly type: "subagent_lifecycle"; readonly payload: OmpSubagentLifecyclePayload }
  | { readonly type: "subagent_progress"; readonly payload: OmpSubagentProgressPayload }
  | { readonly type: "subagent_event"; readonly payload: OmpSubagentEventPayload };

const readOmpSubagentFrame = (event: OmpRpcEvent): OmpSubagentFrame | undefined => {
  if (
    event.type !== "subagent_lifecycle" &&
    event.type !== "subagent_progress" &&
    event.type !== "subagent_event"
  ) {
    return undefined;
  }
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  return { type: event.type, payload } as OmpSubagentFrame;
};

const subagentRuntimeStatus = (
  status: OmpSubagentProgress["status"],
): "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted" =>
  status === "aborted" ? "cancelled" : status;

const subagentTaskDescription = (
  id: string,
  description: string | undefined,
  task?: string,
): string => {
  const candidate = description ?? task;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : `OMP subagent ${id}`;
};

/** Maps OMP's RPC subagent frames to the shared task/agent activity contract. */
export function mapOmpSubagentFrame(
  event: OmpRpcEvent,
  input: OmpEventTranslationInput,
): ReadonlyArray<OmpMappedEvent> {
  const frame = readOmpSubagentFrame(event);
  if (!frame) return [];

  if (frame.type === "subagent_event") {
    const mapped = mapOmpEvent(frame.payload.event as OmpRpcEvent, {
      ...input,
      messageItemId: undefined,
    });
    return mapped
      .filter((item) => item.type === "item.started" || item.type === "item.completed")
      .map((item) => ({
        ...item,
        payload: {
          ...item.payload,
          agentId: frame.payload.id,
        },
      }));
  }

  const lifecycle = frame.type === "subagent_lifecycle" ? frame.payload : undefined;
  const progressPayload = frame.type === "subagent_progress" ? frame.payload : undefined;
  const progress = progressPayload?.progress;
  const id = lifecycle?.id ?? progress?.id;
  if (!id) return [];
  const agent = lifecycle?.agent ?? progressPayload?.agent ?? "task";
  const description = subagentTaskDescription(
    id,
    lifecycle?.description ?? progress?.description,
    progressPayload?.task,
  );
  const linkage = {
    taskType: "subagent",
    agentKind: "agent" as const,
    title: description,
    role: agent,
    ...((lifecycle?.parentToolCallId ?? progressPayload?.parentToolCallId)
      ? { toolUseId: lifecycle?.parentToolCallId ?? progressPayload?.parentToolCallId }
      : {}),
    ...((lifecycle?.index ?? progressPayload?.index) !== undefined
      ? { agentIndex: lifecycle?.index ?? progressPayload?.index }
      : {}),
    timelineBypass: true,
  };
  const taskId = RuntimeTaskId.make(id);

  if (lifecycle) {
    if (lifecycle.status === "started") {
      return [
        {
          type: "task.started",
          turnId: input.activeTurnId,
          payload: { taskId, description, ...linkage },
        },
      ];
    }
    const status =
      lifecycle.status === "failed"
        ? "failed"
        : lifecycle.status === "aborted"
          ? "stopped"
          : "completed";
    return [
      {
        type: "task.completed",
        turnId: input.activeTurnId,
        payload: { taskId, status, summary: description, ...linkage },
      },
    ];
  }

  if (!progress) return [];
  return [
    {
      type: "task.progress",
      turnId: input.activeTurnId,
      payload: {
        taskId,
        description,
        ...(progress.lastIntent ? { summary: progress.lastIntent } : {}),
        ...(progress.currentTool ? { lastToolName: progress.currentTool } : {}),
        ...(progress.tokens !== undefined ||
        progress.requests !== undefined ||
        progress.durationMs !== undefined
          ? {
              usage: {
                ...(progress.tokens !== undefined ? { tokens: progress.tokens } : {}),
                ...(progress.requests !== undefined ? { requests: progress.requests } : {}),
                ...(progress.durationMs !== undefined ? { durationMs: progress.durationMs } : {}),
              },
            }
          : {}),
        ...(progress.status !== "pending"
          ? { status: subagentRuntimeStatus(progress.status) }
          : {}),
        ...linkage,
        ...(progress.resolvedModel ? { model: progress.resolvedModel } : {}),
      },
    },
  ];
}

function ompToolItemType(
  toolName: string,
): "command_execution" | "file_change" | "collab_agent_tool_call" | "dynamic_tool_call" {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent") || normalized === "task") {
    return "collab_agent_tool_call";
  }
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write")) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function ompTextContent(
  message: Record<string, unknown> | undefined,
  options?: { readonly includeThinking?: boolean },
): string | undefined {
  if (!message) {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const includeThinking = options?.includeThinking !== false;
  const parts: Array<string> = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record.type !== "text" && record.type !== "thinking") {
      continue;
    }
    if (record.type === "thinking" && !includeThinking) {
      continue;
    }
    const text = record.text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Human-readable cause of an OMP `message_update` `error`. OMP puts the
 * real reason on the failed assistant message (`error.errorMessage`); the
 * event's own `reason` is only the stop category ("error" | "aborted").
 */
function ompAssistantEventErrorMessage(assistantEvent: Record<string, unknown>): string {
  const failedMessage = assistantEvent.error;
  if (typeof failedMessage === "object" && failedMessage !== null) {
    const errorMessage = (failedMessage as Record<string, unknown>).errorMessage;
    if (typeof errorMessage === "string" && errorMessage.trim().length > 0) {
      return errorMessage.trim();
    }
  }
  const reason = assistantEvent.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : "OMP turn failed.";
}

/** Pure OMP event to provider-neutral runtime-event translation. */
export function mapOmpEvent(
  event: OmpRpcEvent,
  input: OmpEventTranslationInput,
): ReadonlyArray<OmpMappedEvent> {
  const base = {
    turnId: input.activeTurnId,
  } as const;

  switch (event.type) {
    case "message_start": {
      const message = (event.message ?? {}) as Record<string, unknown>;
      // Only assistant-role messages become timeline items (user echoes and
      // toolResult messages are owned by their tool items).
      if (message.role !== "assistant") {
        return [];
      }
      const startedDetail = ompTextContent(message, { includeThinking: false });
      return [
        {
          ...base,
          itemId: input.messageItemId,
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
            title: "Assistant message",
            ...(startedDetail ? { detail: startedDetail } : {}),
            data: event,
          },
        },
      ];
    }

    case "message_end": {
      const message = (event.message ?? {}) as Record<string, unknown>;
      if (message.role !== "assistant") {
        return [];
      }
      const completedDetail = ompTextContent(message, { includeThinking: false });
      return [
        {
          ...base,
          itemId: input.messageItemId,
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(completedDetail ? { detail: completedDetail } : {}),
            data: event,
          },
        },
      ];
    }

    case "message_update": {
      const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
      // Deltas outside an assistant-role message (toolResult echoes, user
      // echoes) have no timeline item to attach to.
      if (input.messageItemId === undefined) {
        return [];
      }
      if (!assistantEvent || typeof assistantEvent.type !== "string") {
        return [];
      }
      switch (assistantEvent.type) {
        case "text_delta": {
          const delta = assistantEvent.delta;
          if (typeof delta !== "string" || delta.length === 0) {
            return [];
          }
          return [
            {
              ...base,
              itemId: input.messageItemId,
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta },
            },
          ];
        }
        case "thinking_delta": {
          const delta = assistantEvent.delta;
          if (typeof delta !== "string" || delta.length === 0) {
            return [];
          }
          return [
            {
              ...base,
              itemId: input.messageItemId,
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta },
            },
          ];
        }
        case "done": {
          return [
            {
              ...base,
              itemId: input.messageItemId,
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
              },
            },
          ];
        }
        case "error": {
          const reason = ompAssistantEventErrorMessage(assistantEvent);
          return [
            {
              ...base,
              itemId: input.messageItemId,
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "failed",
                title: "Assistant message",
                ...(reason.length > 0 ? { detail: reason } : {}),
              },
            },
          ];
        }
        default:
          // toolcall_start/delta/end deltas: `tool_execution_*` events own
          // the tool item lifecycle, so the deltas are dropped.
          return [];
      }
    }

    case "tool_execution_start": {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const args = event.args;
      return [
        {
          ...base,
          itemId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          type: "item.started",
          payload: {
            itemType: ompToolItemType(toolName),
            status: "inProgress",
            title: toolName,
            ...(typeof args === "object" &&
            args !== null &&
            "command" in args &&
            typeof (args as Record<string, unknown>).command === "string"
              ? { detail: String((args as Record<string, unknown>).command) }
              : {}),
            data: { tool: toolName, args },
          },
        },
      ];
    }

    case "tool_execution_end": {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const result = event.result as Record<string, unknown> | undefined;
      const resultText = ompTextContent(result);
      return [
        {
          ...base,
          itemId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          type: "item.completed",
          payload: {
            itemType: ompToolItemType(toolName),
            status: event.isError === true ? "failed" : "completed",
            title: toolName,
            ...(resultText ? { detail: resultText } : {}),
            data: { tool: toolName, result },
          },
        },
      ];
    }

    case "auto_compaction_start": {
      return [
        {
          ...base,
          type: "item.started",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Compacting context",
            ...(typeof event.reason === "string" ? { detail: event.reason } : {}),
            data: event,
          },
        },
      ];
    }

    case "auto_compaction_end": {
      const result = event.result as Record<string, unknown> | undefined;
      const summary = result?.summary;
      return [
        {
          ...base,
          type: "item.completed",
          payload: {
            itemType: "context_compaction",
            status: "completed",
            title: "Context compaction",
            ...(typeof summary === "string" && summary.length > 0 ? { detail: summary } : {}),
            data: event,
          },
        },
      ];
    }

    // Per-assistant turn end is NOT a settle (ADR 0001 decision 1) — the
    // turn stays open until `agent_end` with `isTerminal !== false`.
    case "turn_end": {
      return [];
    }

    default:
      return [];
  }
}

const APPROVAL_OPTIONS: ReadonlyArray<string> = ["Approve", "Deny"];

function isApprovalDialog(options: ReadonlyArray<string>): boolean {
  return (
    options.length === APPROVAL_OPTIONS.length &&
    options.every((option, index) => option === APPROVAL_OPTIONS[index])
  );
}

/**
 * Map a `select`/`confirm` extension dialog onto T3 user-input questions.
 * OMP's Ask tool has no rich dialog over rpc-ui, so it degrades to one
 * `select` per question whose `title` IS the model's question — carry it
 * through or the card renders a prompt with no question in it.
 */
export function ompUiRequestToQuestions(
  request: Extract<OmpUiRequest, { method: "select" }>,
): ReadonlyArray<UserInputQuestion> {
  const title = request.title?.trim();
  const fallback = request.options.length > 0 ? "Select an option" : "OMP extension request";
  return [
    {
      id: request.id,
      header: "OMP extension",
      question: title !== undefined && title.length > 0 ? title : fallback,
      options: request.options.map((option) => ({ label: option, description: option })),
      multiSelect: false,
    },
  ];
}

/**
 * The user-facing text of an extension dialog, or `undefined` when it has
 * none. `promptStyle` marks a title OMP already rendered for a terminal —
 * the question, then a redraw of the option rows the user just left. T3's
 * card draws its own input, so only the first line survives.
 */
function ompDialogTitle(event: OmpRpcEvent): string | undefined {
  const title = typeof event.title === "string" ? event.title.trim() : "";
  if (title.length === 0) {
    return undefined;
  }
  if (event.promptStyle !== true) {
    return title;
  }
  const firstLine = title.split("\n", 1)[0]?.trim();
  return firstLine !== undefined && firstLine.length > 0 ? firstLine : undefined;
}

function mapOmpRequestError(method: string, error: unknown): ProviderAdapterError {
  if (isOmpRequestError(error) || isOmpValidationError(error)) {
    return error;
  }
  const detail =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "omp request failed.";
  return new ProviderAdapterRequestError({ provider: PROVIDER, method, detail, cause: error });
}

const maxStderrLine = (line: string): string =>
  line.length > 2000 ? `${line.slice(0, 2000)}…` : line;

export const makeOmpAdapter = Effect.fn("makeOmpAdapter")(function* (
  ompSettings: OmpSettings,
  options?: OmpAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("omp");
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, OmpAdapterSessionContext>();
  const sessionEnvironment: NodeJS.ProcessEnv = options?.environment ?? process.env;
  const commandTurnGraceMs = Math.max(0, options?.commandTurnGraceMs ?? 2_000);

  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate OMP runtime identifier.",
          cause,
        }),
    ),
  );

  const buildEventBase = (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
    readonly requestId?: string | undefined;
    readonly raw?: unknown;
  }) =>
    Effect.all({
      eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
      createdAt: nowIso,
    }).pipe(
      Effect.map(({ eventId, createdAt }) => ({
        eventId,
        provider: PROVIDER,
        ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
        threadId: input.threadId,
        createdAt,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
        ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
      })),
    );

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
  const settleLiveSubagents = Effect.fn("settleLiveSubagents")(function* (
    context: OmpAdapterSessionContext,
    reason: string,
  ) {
    const live = [...context.liveSubagents.values()];
    context.liveSubagents.clear();
    for (const subagent of live) {
      const mapped = mapOmpSubagentFrame(
        {
          type: "subagent_lifecycle",
          payload: {
            ...subagent,
            status: "aborted",
            description: reason,
          },
        },
        {
          threadId: context.threadId,
          activeTurnId: context.activeTurnId,
          messageItemId: undefined,
        },
      );
      for (const mappedEvent of mapped) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            ...(mappedEvent.turnId ? { turnId: mappedEvent.turnId } : {}),
            ...(mappedEvent.itemId ? { itemId: mappedEvent.itemId } : {}),
          })),
          type: mappedEvent.type,
          payload: mappedEvent.payload,
        } as ProviderRuntimeEvent);
      }
    }
  });

  const settlePendingInteractions = Effect.fn("settlePendingInteractions")(function* (
    context: OmpAdapterSessionContext,
  ) {
    const approvalRequestIds = Array.from(context.pendingApprovals.keys());
    const userInputRequestIds = Array.from(context.pendingUiRequests.keys());
    context.pendingApprovals.clear();
    context.pendingUiRequests.clear();

    yield* Effect.forEach(
      approvalRequestIds,
      (requestId) =>
        buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
        }).pipe(
          Effect.flatMap((base) =>
            emit({
              ...base,
              type: "request.resolved",
              payload: {
                requestType: "dynamic_tool_call",
                decision: "cancel",
              },
            }),
          ),
        ),
      { discard: true },
    );
    yield* Effect.forEach(
      userInputRequestIds,
      (requestId) =>
        buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
        }).pipe(
          Effect.flatMap((base) =>
            emit({
              ...base,
              type: "user-input.resolved",
              payload: { answers: {} },
            }),
          ),
        ),
      { discard: true },
    );
  });

  const writeNativeEventBestEffort = (
    threadId: ThreadId,
    event: { readonly observedAt: string; readonly event: Record<string, unknown> },
  ) =>
    (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void).pipe(
      Effect.catchCause(() => Effect.void),
    );

  // Layer-level finalizer: adapter shutdown stops every session.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const contexts = [...sessions.values()];
      sessions.clear();
      yield* Effect.forEach(
        contexts,
        (context) => Effect.ignoreCause(stopSessionInternal(context)),
        { concurrency: "unbounded", discard: true },
      );
      if (managedNativeEventLogger !== undefined) {
        yield* managedNativeEventLogger.close();
      }
    }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
  );

  const updateSession = (
    context: OmpAdapterSessionContext,
    patch: Partial<ProviderSession>,
    options?: { readonly clearActiveTurnId?: boolean; readonly clearLastError?: boolean },
  ): Effect.Effect<ProviderSession> =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      const nextSession = { ...context.session, ...patch, updatedAt } as ProviderSession &
        Record<string, unknown>;
      const mutable = nextSession as Record<string, unknown>;
      if (options?.clearActiveTurnId) {
        delete mutable.activeTurnId;
      }
      if (options?.clearLastError) {
        delete mutable.lastError;
      }
      context.session = nextSession;
      return nextSession;
    });

  const buildResumeCursor = Effect.fn("buildResumeCursor")(function* (
    context: OmpAdapterSessionContext,
  ): Effect.fn.Return<OmpResumeCursor | undefined, never, never> {
    const sessionFile = yield* Ref.get(context.sessionFileRef);
    if (!sessionFile) {
      return undefined;
    }
    const [sessionId, turnBoundaries] = yield* Effect.all([
      Ref.get(context.sessionIdRef),
      Ref.get(context.turnBoundariesRef),
    ]);
    return {
      schemaVersion: OMP_RESUME_SCHEMA_VERSION,
      sessionFile,
      ...(sessionId ? { sessionId } : {}),
      ...(turnBoundaries.length > 0 ? { turnBoundaries: [...turnBoundaries] } : {}),
    };
  });

  const syncSessionCursor = Effect.fn("syncSessionCursor")(function* (
    context: OmpAdapterSessionContext,
  ) {
    const cursor = yield* buildResumeCursor(context);
    if (cursor === undefined) {
      return;
    }
    context.session = { ...context.session, resumeCursor: cursor };
  });

  const recordTurnBoundary = Effect.fn("recordTurnBoundary")(function* (
    context: OmpAdapterSessionContext,
  ) {
    // One bounded round trip per settled turn (checkpoint-restore doc,
    // decision 3): the last user-message entry id of the current branch is
    // the durable restore point for the NEXT rollback.
    const response = yield* context.client.send({ type: "get_branch_messages" }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "get_branch_messages",
            detail: cause.detail,
            cause,
          }),
      ),
    );
    const branchData = (response.data ?? {}) as {
      readonly messages?: unknown;
      readonly entries?: unknown;
    };
    const entries = Array.isArray(branchData.messages) ? branchData.messages : branchData.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    const lastEntry = entries[entries.length - 1] as Record<string, unknown> | undefined;
    const entryId = typeof lastEntry?.entryId === "string" ? lastEntry.entryId : undefined;
    if (!entryId) {
      return;
    }
    const boundaries = yield* Ref.get(context.turnBoundariesRef);
    if (boundaries[boundaries.length - 1] === entryId) {
      return;
    }
    yield* Ref.set(context.turnBoundariesRef, [...boundaries, entryId]);
    yield* syncSessionCursor(context);
  });

  const startBoundaryRecorder = Effect.fn("startBoundaryRecorder")(function* (
    context: OmpAdapterSessionContext,
  ) {
    yield* Stream.fromQueue(context.boundaryJobs).pipe(
      Stream.runForEach(() =>
        recordTurnBoundary(context).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to record OMP turn boundary", {
              threadId: context.threadId,
              detail: error.message,
            }),
          ),
        ),
      ),
      Effect.forkIn(context.sessionScope),
    );
  });

  const answerExtensionUi = (context: OmpAdapterSessionContext, id: string, value: string) =>
    context.client
      .sendFireAndForget({ type: "extension_ui_response", id, value })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("extension_ui_response", cause)));

  const handleUiRequest = Effect.fn("handleUiRequest")(function* (
    context: OmpAdapterSessionContext,
    event: OmpRpcEvent,
  ) {
    const id = typeof event.id === "string" ? event.id : undefined;
    if (!id) {
      return;
    }
    const method = event.method;
    if (method === "cancel") {
      const requestId = ApprovalRequestId.make(id);
      if (context.pendingApprovals.delete(requestId)) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            turnId: context.activeTurnId,
            requestId,
            raw: event,
          })),
          type: "request.resolved",
          payload: {
            requestType: "dynamic_tool_call",
            decision: "cancel",
          },
        });
      }
      if (context.pendingUiRequests.delete(requestId)) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            turnId: context.activeTurnId,
            requestId,
            raw: event,
          })),
          type: "user-input.resolved",
          payload: { answers: {} },
        });
      }
      yield* Effect.logDebug("OMP extension UI request cancelled", { id });
      return;
    }

    if (method === "select") {
      const options = Array.isArray(event.options)
        ? event.options.filter((option): option is string => typeof option === "string")
        : [];
      const title = ompDialogTitle(event);
      const requestId = ApprovalRequestId.make(id);
      // ADR 0001 decision 4: a `select` with exactly ["Approve","Deny"] is
      // an approval, not a user-input question.
      if (isApprovalDialog(options)) {
        const detail = title ?? "Approve tool execution";
        if (yield* Ref.get(context.denyPendingSelects)) {
          // The model retries after a Deny; keep the turn moving instead of
          // surfacing a dialog the user already answered.
          yield* answerExtensionUi(context, id, "Deny").pipe(Effect.ignore);
          return;
        }
        context.pendingApprovals.set(requestId, { detail });
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            turnId: context.activeTurnId,
            requestId,
            raw: event,
          })),
          type: "request.opened",
          payload: {
            requestType: "dynamic_tool_call",
            detail,
          },
        });
        return;
      }
      const request: Extract<OmpUiRequest, { method: "select" }> = {
        method: "select",
        id: requestId,
        ...(title !== undefined ? { title } : {}),
        options,
      };
      context.pendingUiRequests.set(requestId, request);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
          raw: event,
        })),
        type: "user-input.requested",
        payload: {
          questions: ompUiRequestToQuestions(request),
        },
      });
      return;
    }

    if (method === "confirm") {
      const requestId = ApprovalRequestId.make(id);
      const request: Extract<OmpUiRequest, { method: "confirm" }> = {
        method: "confirm",
        id: requestId,
      };
      context.pendingUiRequests.set(requestId, request);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
          raw: event,
        })),
        type: "user-input.requested",
        payload: {
          questions: [
            {
              id: requestId,
              header: "OMP extension",
              question: ompDialogTitle(event) ?? "Confirm",
              options: [
                { label: "Yes", description: "Confirm" },
                { label: "No", description: "Cancel" },
              ],
              multiSelect: false,
            },
          ],
        },
      });
      return;
    }

    if (method === "input" || method === "editor") {
      const requestId = ApprovalRequestId.make(id);
      const request: Extract<OmpUiRequest, { method: "input" | "editor" }> = {
        method,
        id: requestId,
      };
      context.pendingUiRequests.set(requestId, request);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
          raw: event,
        })),
        type: "user-input.requested",
        payload: {
          questions: [
            {
              id: requestId,
              header: "OMP extension",
              question: ompDialogTitle(event) ?? "OMP extension request",
              options: [],
              multiSelect: false,
            },
          ],
        },
      });
      return;
    }

    if (method === "notify") {
      const message =
        typeof event.message === "string" && event.message.trim().length > 0
          ? event.message.trim()
          : "OMP extension notification";
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          raw: event,
        })),
        type: "runtime.warning",
        payload: { message },
      });
      return;
    }

    if (method === "setStatus") {
      const statusText =
        typeof event.statusText === "string" && event.statusText.trim().length > 0
          ? event.statusText.trim()
          : undefined;
      if (statusText !== undefined) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            turnId: context.activeTurnId,
            raw: event,
          })),
          type: "runtime.warning",
          payload: { message: statusText },
        });
      }
      return;
    }

    // Remaining fire-and-forget UI methods (setWidget, setTitle,
    // set_editor_text, open_url): nothing to render in T3's chat — drop
    // (ADR 0001 decision 3; open_url = RPC OAuth login, out of scope).
    yield* Effect.logDebug("Ignoring OMP extension UI request", { method, id });
  });

  const ensureModelContextTable = Effect.fn("ensureModelContextTable")(function* (
    context: OmpAdapterSessionContext,
  ) {
    const cached = yield* Ref.get(context.modelContextTableRef);
    if (cached !== undefined) {
      return cached;
    }
    const table = yield* context.client.send({ type: "get_available_models" }).pipe(
      Effect.map((response) => piFamilyContextWindowTable(response.data)),
      Effect.catch((cause) =>
        Effect.logWarning("OMP model-context table fetch failed; meter ring disabled", {
          threadId: context.threadId,
          detail: cause.detail,
        }).pipe(Effect.as(new Map<string, number>())),
      ),
    );
    yield* Ref.set(context.modelContextTableRef, table);
    return table;
  });

  const turnCostPayload = (
    context: OmpAdapterSessionContext,
  ): Effect.Effect<{ readonly totalCostUsd: number } | Record<string, never>, never> =>
    Ref.get(context.turnCostUsdRef).pipe(
      Effect.map((totalCostUsd) => (totalCostUsd > 0 ? { totalCostUsd } : {})),
    );

  const settleCommandTurnAfterGrace = Effect.fn("settleCommandTurnAfterGrace")(function* (
    context: OmpAdapterSessionContext,
    turnId: TurnId,
    raw?: unknown,
  ) {
    if (commandTurnGraceMs > 0) {
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            // @effect-diagnostics-next-line globalTimers:off -- real wall-clock grace period
            setTimeout(resolve, commandTurnGraceMs);
          }),
      );
    }
    const [sawAgentActivity, stopped] = yield* Effect.all([
      Ref.get(context.agentActivitySincePromptRef),
      Ref.get(context.stopped),
    ]);
    if (sawAgentActivity || stopped || context.activeTurnId !== turnId) {
      return;
    }
    const stillStreaming = yield* context.client.send({ type: "get_state" }).pipe(
      Effect.map((response) => {
        const data = (response.data ?? {}) as Record<string, unknown>;
        return data.isStreaming === true;
      }),
      Effect.catch((cause) =>
        Effect.logWarning("OMP get_state probe failed during command-turn grace window", {
          threadId: context.threadId,
          detail: cause.detail,
        }).pipe(Effect.as(true)),
      ),
    );
    if (stillStreaming || context.activeTurnId !== turnId) {
      return;
    }
    context.activeTurnId = undefined;
    context.activeTurnError = undefined;
    context.activePromptRequestId = undefined;
    yield* Ref.set(context.denyPendingSelects, false);
    yield* updateSession(
      context,
      { status: "ready" },
      { clearActiveTurnId: true, clearLastError: true },
    );
    yield* emit({
      ...(yield* buildEventBase({ threadId: context.threadId, turnId, raw })),
      type: "turn.completed",
      payload: { state: "completed" },
    });
    yield* Queue.offer(context.boundaryJobs, void 0);
  });

  const handleOmpEvent = Effect.fn("handleOmpEvent")(function* (
    context: OmpAdapterSessionContext,
    event: OmpRpcEvent,
  ) {
    yield* writeNativeEventBestEffort(context.threadId, {
      observedAt: yield* nowIso,
      event,
    });

    // Agent-loop activity after a command prompt's response means the turn
    // is doing real model work — the synthetic command-turn completion in
    // `sendTurn` must not fire.
    if (
      event.type === "agent_end" ||
      (event.type === "message_start" &&
        typeof event.message === "object" &&
        event.message !== null &&
        (event.message as Record<string, unknown>).role === "assistant")
    ) {
      yield* Ref.set(context.agentActivitySincePromptRef, true);
    }

    if (event.type === "extension_ui_request") {
      yield* handleUiRequest(context, event);
      return;
    }
    const subagentFrame = readOmpSubagentFrame(event);
    if (subagentFrame !== undefined) {
      if (subagentFrame.type === "subagent_lifecycle") {
        if (subagentFrame.payload.status === "started") {
          context.liveSubagents.set(subagentFrame.payload.id, subagentFrame.payload);
        } else {
          context.liveSubagents.delete(subagentFrame.payload.id);
        }
      }
      const mapped = mapOmpSubagentFrame(event, {
        threadId: context.threadId,
        activeTurnId: context.activeTurnId,
        messageItemId: undefined,
      });
      for (const mappedEvent of mapped) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            ...(mappedEvent.turnId ? { turnId: mappedEvent.turnId } : {}),
            ...(mappedEvent.itemId ? { itemId: mappedEvent.itemId } : {}),
            raw: event,
          })),
          type: mappedEvent.type,
          payload: mappedEvent.payload,
        } as ProviderRuntimeEvent);
      }
      return;
    }
    if (event.type === "prompt_result") {
      const promptId = typeof event.id === "string" ? event.id : undefined;
      if (promptId !== undefined && promptId === context.activePromptRequestId) {
        context.activePromptRequestId = undefined;
        if (event.agentInvoked === false && context.activeTurnId !== undefined) {
          const turnId = context.activeTurnId;
          yield* settleCommandTurnAfterGrace(context, turnId, event).pipe(
            Effect.forkIn(context.sessionScope),
          );
        }
      }
      return;
    }

    if (event.type === "message_start") {
      const role =
        event.message !== null && typeof event.message === "object"
          ? (event.message as Record<string, unknown>).role
          : undefined;
      if (role !== "assistant") {
        context.currentMessageItemId = undefined;
      } else {
        context.currentMessageItemId = yield* randomUUIDv4;
        context.activePromptRequestId = undefined;
      }
    }

    // Track an assistant-stream failure for the active turn: OMP surfaces
    // it as `message_update` `error` and the terminal `agent_end` carries
    // no outcome, so this is the only place the turn's real result is
    // knowable.
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent?.type === "error" && context.activeTurnId !== undefined) {
        context.activeTurnError = ompAssistantEventErrorMessage(assistantEvent);
      }
    }

    if (event.type === "message_end" && context.activeTurnId !== undefined) {
      const usage = piFamilyUsageFromEvent(event);
      if (usage !== undefined) {
        const processed = yield* Ref.updateAndGet(context.processedTokensRef, (current) => ({
          input: current.input + usage.input,
          output: current.output + usage.output,
        }));
        yield* Ref.update(context.turnCostUsdRef, (cost) => cost + usage.costTotalUsd);
        const message = (event.message ?? {}) as Record<string, unknown>;
        const contextWindow =
          typeof message.provider === "string" && typeof message.model === "string"
            ? (yield* ensureModelContextTable(context)).get(`${message.provider}/${message.model}`)
            : undefined;
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            turnId: context.activeTurnId,
            raw: event,
          })),
          type: "thread.token-usage.updated",
          payload: {
            usage: makePiFamilyTokenUsageSnapshot({
              usage,
              processedInputTokens: processed.input,
              processedOutputTokens: processed.output,
              contextWindow,
            }),
          },
        });
      }
    }

    if (event.type === "agent_end") {
      // `isTerminal: false` (maintenance scheduled more work) keeps the
      // turn open — only `isTerminal !== false` settles (ADR 0001 d.1).
      if (event.isTerminal === false) {
        return;
      }
      const suppressed = yield* Ref.getAndSet(context.suppressNextSettled, false);
      if (!suppressed && context.activeTurnId !== undefined) {
        const turnId = context.activeTurnId;
        context.activeTurnId = undefined;
        const turnError = context.activeTurnError;
        context.activePromptRequestId = undefined;
        context.activeTurnError = undefined;
        yield* Ref.set(context.denyPendingSelects, false);
        // Reflect the turn outcome on the session: a failed turn leaves
        // status "error" with lastError; a clean settle returns to "ready".
        yield* updateSession(
          context,
          turnError !== undefined ? { status: "error", lastError: turnError } : { status: "ready" },
          turnError !== undefined
            ? { clearActiveTurnId: true }
            : { clearActiveTurnId: true, clearLastError: true },
        );
        yield* emit({
          ...(yield* buildEventBase({ threadId: context.threadId, turnId, raw: event })),
          type: "turn.completed",
          payload: {
            ...(turnError !== undefined
              ? { state: "failed" as const, errorMessage: turnError }
              : { state: "completed" as const }),
            ...(yield* turnCostPayload(context)),
          },
        });
        yield* Queue.offer(context.boundaryJobs, void 0);
      }
      return;
    }

    const mapped = mapOmpEvent(event, {
      threadId: context.threadId,
      activeTurnId: context.activeTurnId,
      messageItemId: context.currentMessageItemId,
    });
    for (const mappedEvent of mapped) {
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          ...(mappedEvent.turnId ? { turnId: mappedEvent.turnId } : {}),
          ...(mappedEvent.itemId ? { itemId: mappedEvent.itemId } : {}),
          raw: event,
        })),
        type: mappedEvent.type,
        payload: mappedEvent.payload,
      } as ProviderRuntimeEvent);
    }
    if (mapped.length === 0) {
      yield* Effect.logDebug("Ignoring unhandled OMP event", {
        type: event.type,
        threadId: context.threadId,
      });
    }
  });

  const startSessionPump = Effect.fn("startSessionPump")(function* (
    context: OmpAdapterSessionContext,
  ) {
    yield* Stream.fromQueue(context.client.events).pipe(
      Stream.runForEach((event) =>
        handleOmpEvent(context, event).pipe(
          Effect.catch((error) =>
            Effect.logWarning("OMP event handling failed", {
              threadId: context.threadId,
              detail: error.message,
            }),
          ),
        ),
      ),
      Effect.forkIn(context.sessionScope),
    );
  });

  const startExitWatcher = Effect.fn("startExitWatcher")(function* (
    context: OmpAdapterSessionContext,
  ) {
    // The exit watcher observes the child's exit code. Intentional stops
    // flip `stopped` before closing the scope, so the watcher no-ops.
    yield* context.child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(context.stopped, true)) {
            return;
          }
          yield* settlePendingInteractions(context).pipe(Effect.ignore);
          sessions.delete(context.threadId);
          const turnId = context.activeTurnId;
          context.activeTurnId = undefined;
          context.activeTurnError = undefined;
          // Exit 0 is OMP's stdin-EOF graceful path. Any other code —
          // including signal death on macOS or a crash — ends the live turn
          // as an error.
          const graceful = Number(code) === 0;
          const message = graceful
            ? "OMP process exited (code 0)."
            : `OMP process exited unexpectedly (code ${Number(code)}).`;
          if (turnId !== undefined) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
              type: "runtime.error",
              payload: {
                message,
                class: "transport_error",
              },
            }).pipe(Effect.ignore);
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: "OMP exited mid-turn.",
              },
            }).pipe(Effect.ignore);
          }
          yield* settleLiveSubagents(context, message).pipe(Effect.ignore);
          yield* emit({
            ...(yield* buildEventBase({ threadId: context.threadId })),
            type: "session.exited",
            payload: {
              reason: message,
              recoverable: true,
              exitKind: graceful ? "graceful" : "error",
            },
          }).pipe(Effect.ignore);
          // Fail any command in flight so its caller observes the death
          // instead of hanging until the command timeout.
          yield* context.client.failPending("OMP process exited.").pipe(Effect.ignore);
          yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
        }),
      ),
      Effect.forkIn(context.sessionScope),
    );
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: OmpAdapterSessionContext,
  ) {
    if (yield* Ref.getAndSet(context.stopped, true)) {
      return;
    }
    yield* settlePendingInteractions(context).pipe(Effect.ignore);
    yield* settleLiveSubagents(context, "OMP parent session stopped").pipe(Effect.ignore);
    sessions.delete(context.threadId);
    // Best-effort remote abort, then local teardown. Scope close kills the
    // child and interrupts the pump/exit/stderr/boundary fibers; the RPC
    // client's own scope finalizer fails any command still pending.
    yield* context.client
      .send({ type: "abort" })
      .pipe(Effect.timeout(Duration.seconds(5)), Effect.ignore({ log: true }), Effect.forkDetach);
    yield* context.client.stop.pipe(Effect.ignore);
    yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
  });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return;
      }
      yield* stopSessionInternal(context);
    });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "requireSession",
        issue: `No active omp session for thread '${threadId}'.`,
      });
    }
    if (yield* Ref.get(context.stopped)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "requireSession",
        issue: `OMP session for thread '${threadId}' is closed.`,
      });
    }
    return context;
  });

  const ompSessionDirectory = Effect.fn("ompSessionDirectory")(function* (cwd: string) {
    const digest = yield* crypto.digest("SHA-1", new TextEncoder().encode(cwd)).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "unknown",
            detail: `Failed to hash omp session directory for '${cwd}'.`,
            cause,
          }),
      ),
    );
    const hash = Buffer.from(digest).toString("hex").slice(0, 12);
    const sessionDir = path.join(serverConfig.stateDir, "omp", "sessions", hash);
    yield* fileSystem.makeDirectory(sessionDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "unknown",
            detail: `Failed to create omp session directory '${sessionDir}'.`,
            cause,
          }),
      ),
    );
    return sessionDir;
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.logInfo("omp adapter startSession enter", {
          threadId: input.threadId,
          hasCursor: input.resumeCursor !== undefined,
          model: input.modelSelection?.model,
        });
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (
          input.modelSelection !== undefined &&
          input.modelSelection.instanceId !== boundInstanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `OMP model selection is bound to instance '${input.modelSelection.instanceId}', expected '${boundInstanceId}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopSessionInternal(existing);
        }

        const cwd = input.cwd ?? serverConfig.cwd;
        const resumeCursor = isOmpResumeCursor(input.resumeCursor) ? input.resumeCursor : undefined;
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const sessionDir = yield* ompSessionDirectory(cwd);
        yield* Effect.logInfo("omp adapter session dir ready", {
          threadId: input.threadId,
          sessionDir,
        });
        const launchArgs = resolveOmpLaunchArgs({
          cwd,
          sessionDir,
          resumeCursor,
          model: modelSelection?.model,
          thinkingLevel: getModelSelectionStringOptionValue(modelSelection, "thinkingLevel"),
          approvalMode: resolveOmpApprovalMode(input.runtimeMode),
          profile: ompSettings.profile,
          launchArgs: ompSettings.launchArgs,
        });

        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const spawnFailure = (detail: string, cause: unknown) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail,
            cause,
          });

        const child = yield* childProcessSpawner
          .spawn(
            ChildProcess.make(ompSettings.binaryPath, [...launchArgs], {
              cwd,
              env: sessionEnvironment,
              extendEnv: false,
              // Commands are written with per-command `Stream.run` into the
              // stdin sink; the spawner's default `endOnDone: true` would end
              // stdin after the first write, and omp exits on stdin EOF.
              stdin: { stream: "pipe", endOnDone: false },
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              spawnFailure(
                `Failed to spawn omp process '${ompSettings.binaryPath}': ${cause.message}`,
                cause,
              ),
            ),
          );
        yield* Effect.logInfo("omp adapter spawned", { threadId: input.threadId });

        const client = yield* makeOmpRpcClient({ child }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(Crypto.Crypto, crypto),
        );

        const teardown = Effect.gen(function* () {
          yield* client.stop.pipe(Effect.ignore);
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
        });
        yield* client.send({ type: "set_subagent_subscription", level: "events" }).pipe(
          Effect.mapError((cause) =>
            spawnFailure(`Failed to subscribe to omp subagent events: ${cause.detail}`, cause),
          ),
          Effect.onError(() => teardown),
        );

        const state = yield* client.send({ type: "get_state" }).pipe(
          Effect.mapError((cause) =>
            spawnFailure(`Failed to query omp session state: ${cause.detail}`, cause),
          ),
          Effect.onError(() => teardown),
        );
        const stateData = (state.data ?? {}) as Record<string, unknown>;
        const stateSessionFile =
          typeof stateData.sessionFile === "string" ? stateData.sessionFile : undefined;
        const stateSessionId =
          typeof stateData.sessionId === "string" ? stateData.sessionId : undefined;
        // `get_state.sessionFile` is a planned path and does not exist until
        // the first write. Never stat or read it during startup.
        const initialBoundaries = resumeCursor?.turnBoundaries ?? [];
        const rawStateModel =
          typeof stateData.model === "object" &&
          stateData.model !== null &&
          !Array.isArray(stateData.model)
            ? (stateData.model as { readonly provider?: unknown; readonly id?: unknown })
            : undefined;
        const stateModelProvider =
          typeof rawStateModel?.provider === "string" && rawStateModel.provider.trim().length > 0
            ? rawStateModel.provider.trim()
            : undefined;
        const stateModelId =
          typeof rawStateModel?.id === "string" && rawStateModel.id.trim().length > 0
            ? rawStateModel.id.trim()
            : undefined;
        const initialModel =
          modelSelection?.model ??
          (stateModelProvider && stateModelId
            ? `${stateModelProvider}/${stateModelId}`
            : undefined);
        const initialThinkingLevel =
          getModelSelectionStringOptionValue(modelSelection, "thinkingLevel") ??
          (typeof stateData.thinkingLevel === "string" && stateData.thinkingLevel.trim().length > 0
            ? stateData.thinkingLevel.trim()
            : undefined);
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(cwd ? { cwd } : {}),
          ...(initialModel ? { model: initialModel } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };

        const boundaryJobs = yield* Queue.unbounded<void>();
        const context: OmpAdapterSessionContext = {
          threadId: input.threadId,
          child,
          client,
          sessionScope,
          session,
          activeTurnId: undefined,
          activeTurnError: undefined,
          currentMessageItemId: undefined,
          activePromptRequestId: undefined,
          sessionFileRef: yield* Ref.make(stateSessionFile ?? resumeCursor?.sessionFile),
          sessionIdRef: yield* Ref.make(stateSessionId ?? resumeCursor?.sessionId),
          turnBoundariesRef: yield* Ref.make<readonly string[]>([...initialBoundaries]),
          pendingUiRequests: new Map(),
          pendingApprovals: new Map(),
          suppressNextSettled: yield* Ref.make(false),
          denyPendingSelects: yield* Ref.make(false),
          agentActivitySincePromptRef: yield* Ref.make(false),
          lastThinkingLevelRef: yield* Ref.make(initialThinkingLevel),
          liveSubagents: new Map(),
          boundaryJobs,
          modelContextTableRef: yield* Ref.make<ReadonlyMap<string, number> | undefined>(undefined),
          processedTokensRef: yield* Ref.make({ input: 0, output: 0 }),
          turnCostUsdRef: yield* Ref.make(0),
          stopped: yield* Ref.make(false),
        };
        yield* syncSessionCursor(context);

        yield* startSessionPump(context).pipe(Effect.provideService(Scope.Scope, sessionScope));
        yield* startBoundaryRecorder(context).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
        );
        yield* startExitWatcher(context).pipe(Effect.provideService(Scope.Scope, sessionScope));
        yield* startStderrWatcher(context).pipe(Effect.provideService(Scope.Scope, sessionScope));

        sessions.set(input.threadId, context);
        sessionScopeTransferred = true;

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OMP session started",
            ...(stateSessionFile
              ? {
                  resume: {
                    sessionFile: stateSessionFile,
                    ...(stateSessionId ? { sessionId: stateSessionId } : {}),
                  },
                }
              : {}),
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: stateSessionId ? { providerThreadId: stateSessionId } : {},
        });

        return context.session;
      }),
    );

  const startStderrWatcher = Effect.fn("startStderrWatcher")(function* (
    context: OmpAdapterSessionContext,
  ) {
    yield* context.child.stderr.pipe(
      Stream.decodeText(),
      Stream.mapAccum(
        () => "",
        (carry, chunk) => {
          const combined = carry + chunk;
          const parts = combined.split("\n");
          const remainder = parts.pop() ?? "";
          return [remainder, parts] as [string, string[]];
        },
      ),
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            return;
          }
          yield* emit({
            ...(yield* buildEventBase({ threadId: context.threadId })),
            type: "runtime.warning",
            payload: { message: maxStderrLine(trimmed) },
          }).pipe(Effect.ignore);
        }),
      ),
      Effect.forkIn(context.sessionScope),
    );
  });

  /**
   * After a fresh-turn `prompt` timeout, decide whether OMP is actually
   * working (its response line is just late) or stuck (no work at all).
   * Returns true when the turn must stay open and let the late `agent_end`
   * settle it instead of failing.
   */
  const reconcilePromptTimeout = Effect.fn("reconcilePromptTimeout")(function* (
    context: OmpAdapterSessionContext,
  ) {
    if (yield* Ref.get(context.agentActivitySincePromptRef)) {
      return true;
    }
    const stillStreaming = yield* context.client.send({ type: "get_state" }).pipe(
      Effect.map((response) => {
        const data = (response.data ?? {}) as Record<string, unknown>;
        return data.isStreaming === true;
      }),
      // A failed probe cannot prove the agent is idle — err on keeping the
      // turn open (same policy as the command-turn grace window).
      Effect.catch((cause) =>
        Effect.logWarning("OMP get_state probe failed after prompt timeout", {
          detail: cause.detail,
        }).pipe(Effect.as(true)),
      ),
    );
    return stillStreaming;
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn("sendTurn")(
    function* (input: ProviderSendTurnInput) {
      const context = yield* requireSession(input.threadId);
      if (context.activeTurnId === undefined && (yield* Ref.get(context.suppressNextSettled))) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue:
            "OMP is still settling the interrupted turn. Wait for the abort to finish and retry, or restart the session.",
        });
      }
      // A sendTurn while a turn is active is a steer: OMP queues the
      // message into the busy session and the work continues as one turn,
      // so the active turn id is reused instead of opening a new one.
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`omp-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OMP model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }

      const text = input.input?.trim();
      const images = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) => resolveOmpImage(input, attachment),
        { concurrency: 1 },
      );
      if ((!text || text.length === 0) && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OMP turns require text input or at least one attachment.",
        });
      }

      // OMP applies model/thinking changes immediately. T3 persists the requested
      // selection only after sendTurn succeeds, so rejected changes must fail the
      // request rather than continue on stale OMP state. When both fields change,
      // a rejected thinking tier rolls the model back before surfacing the error.
      const previousModel = context.session.model;
      const requestedModel = modelSelection?.model;
      const thinkingLevel = getModelSelectionStringOptionValue(modelSelection, "thinkingLevel");
      const previousThinkingLevel = yield* Ref.get(context.lastThinkingLevelRef);
      const modelChanged = requestedModel !== undefined && requestedModel !== previousModel;
      const thinkingChanged =
        thinkingLevel !== undefined && thinkingLevel !== previousThinkingLevel;

      if (
        modelChanged &&
        thinkingChanged &&
        (previousModel === undefined || previousThinkingLevel === undefined)
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue:
            "OMP did not report the active model and thinking level, so T3 Code cannot safely apply both changes atomically. Restart the session and retry.",
        });
      }

      if (modelChanged && requestedModel !== undefined) {
        const parsed = splitOmpModelSlug(requestedModel);
        if (!parsed.provider || parsed.modelId.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `OMP model '${requestedModel}' must retain its provider/model identity. Refresh the provider catalog and choose an available model.`,
          });
        }
        yield* context.client
          .send({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "set_model",
                  detail: `OMP could not switch to model '${requestedModel}': ${cause.detail} Choose an available OMP model and retry.`,
                  cause,
                }),
            ),
          );
      }

      if (thinkingChanged && thinkingLevel !== undefined) {
        const thinkingExit = yield* context.client
          .send({ type: "set_thinking_level", level: thinkingLevel })
          .pipe(Effect.exit);
        if (Exit.isFailure(thinkingExit)) {
          let modelRestored = true;
          if (modelChanged && previousModel !== undefined) {
            const previous = splitOmpModelSlug(previousModel);
            if (!previous.provider || previous.modelId.length === 0) {
              modelRestored = false;
            } else {
              const rollbackExit = yield* context.client
                .send({
                  type: "set_model",
                  provider: previous.provider,
                  modelId: previous.modelId,
                })
                .pipe(Effect.exit);
              modelRestored = Exit.isSuccess(rollbackExit);
            }
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "set_thinking_level",
            detail: `OMP could not set thinking level '${thinkingLevel}'. Choose a tier supported by the selected model and retry.${modelRestored ? "" : " OMP also failed to restore the previous model; restart this session before sending another turn."}`,
            cause: thinkingExit,
          });
        }
        yield* Ref.set(context.lastThinkingLevelRef, thinkingLevel);
      }

      context.activeTurnId = turnId;
      context.activeTurnError = undefined;
      yield* Ref.set(context.denyPendingSelects, false);
      yield* updateSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          ...(modelSelection ? { model: modelSelection.model } : {}),
        },
        { clearLastError: true },
      );

      if (steeringTurnId === undefined) {
        yield* Ref.set(context.turnCostUsdRef, 0);
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: modelSelection ? { model: modelSelection.model } : {},
        });
        // Fresh-turn activity signal: reset so a prompt-timeout
        // reconciliation can tell whether the agent loop streamed for THIS
        // prompt rather than an earlier one.
        yield* Ref.set(context.agentActivitySincePromptRef, false);
      }

      const command = {
        type: steeringTurnId === undefined ? ("prompt" as const) : ("steer" as const),
        ...(text ? { message: text } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
      // Set when the stuck-prompt path decides to fail: the failure cleanup
      // below then aborts OMP once the turn state is cleared, so no queued
      // work executes after the failure.
      const stuckPromptAbort = yield* Ref.make(false);
      const promptResponse = yield* context.client.send(command).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: command.type,
              detail: cause.detail,
              cause,
            }),
        ),
        // A timed-out prompt is not necessarily a failed prompt: OMP may
        // have accepted it and be streaming the agent loop while its
        // response line is late. Declaring the turn failed then would
        // orphan the running work — turnId-less messages would keep
        // streaming, tools would keep executing, and no completion would
        // ever fire. Reconcile with the live loop before failing a fresh
        // turn. A failed steer leaves the still-running original turn
        // untouched, timeout or not.
        Effect.catch((requestError) => {
          if (steeringTurnId !== undefined || !isOmpPromptTimeoutError(requestError)) {
            return Effect.fail(requestError);
          }
          return reconcilePromptTimeout(context).pipe(
            Effect.flatMap((working) => {
              if (working) {
                // The agent loop is alive: keep the turn open and let the
                // late `agent_end` settle it normally.
                return Effect.void;
              }
              // Nothing streamed and OMP reports idle: the prompt is
              // stuck. Fail the turn; the failure cleanup aborts OMP so no
              // queued work executes after the failure.
              return Ref.set(stuckPromptAbort, true).pipe(
                Effect.andThen(Effect.fail(requestError)),
              );
            }),
          );
        }),
        // On failure of a fresh turn: clear active-turn state, flip the
        // session back to ready with lastError set, emit turn.aborted, then
        // propagate the typed error. A failed steer leaves the still-running
        // original turn untouched.
        Effect.tapError((requestError) =>
          steeringTurnId !== undefined
            ? Effect.void
            : Effect.gen(function* () {
                context.activeTurnId = undefined;
                yield* updateSession(
                  context,
                  {
                    status: "ready",
                    ...(modelSelection ? { model: modelSelection.model } : {}),
                    lastError: requestError.detail,
                  },
                  { clearActiveTurnId: true },
                );
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: input.threadId,
                    turnId,
                  })),
                  type: "turn.aborted",
                  payload: { reason: requestError.detail },
                });
                // Stuck-prompt failure: OMP may still have the prompt
                // queued. Abort now that the turn state is cleared — a
                // trailing `agent_end` is already blocked by the cleared
                // activeTurnId, so no suppress flag is needed (a one-shot
                // flag would leak into the next turn when no `agent_end`
                // follows, hanging that turn's settle).
                if (yield* Ref.getAndSet(stuckPromptAbort, false)) {
                  yield* context.client.send({ type: "abort" }).pipe(
                    // The channel may be wedged (that is why the prompt
                    // timed out); the best-effort abort must never extend
                    // the failure path.
                    Effect.timeout(Duration.millis(5_000)),
                    Effect.ignore,
                  );
                }
              }),
        ),
      );

      const promptData = (promptResponse?.data ?? {}) as Record<string, unknown>;
      if (
        promptResponse !== undefined &&
        steeringTurnId === undefined &&
        promptData.agentInvoked === false &&
        context.activeTurnId === turnId
      ) {
        yield* settleCommandTurnAfterGrace(context, turnId);
      } else if (
        promptResponse !== undefined &&
        steeringTurnId === undefined &&
        promptData.agentInvoked === undefined
      ) {
        context.activePromptRequestId = promptResponse.id;
        if (text?.startsWith("/") && context.activeTurnId === turnId) {
          yield* settleCommandTurnAfterGrace(context, turnId);
        }
      }

      const cursor = yield* buildResumeCursor(context);
      return {
        threadId: input.threadId,
        turnId,
        ...(cursor ? { resumeCursor: cursor } : {}),
      } satisfies ProviderTurnStartResult;
    },
  );

  const resolveOmpImage = Effect.fn("resolveOmpImage")(function* (
    input: ProviderSendTurnInput,
    attachment: ChatAttachment,
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return {
      type: "image" as const,
      data: Buffer.from(bytes).toString("base64"),
      mimeType: attachment.mimeType,
    };
  });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const activeTurnId = turnId ?? context.activeTurnId;
      yield* settlePendingInteractions(context);
      // OMP's `abort` response lands after the stream winds down, and the
      // trailing `agent_end` follows — the suppress flag must be armed up
      // front, arming it after the response is always too late.
      if (activeTurnId !== undefined && context.activeTurnId === activeTurnId) {
        yield* Ref.set(context.suppressNextSettled, true);
      }
      yield* context.client.send({ type: "abort" }).pipe(
        Effect.asVoid,
        Effect.timeout(Duration.seconds(5)),
        Effect.catch((cause) =>
          Effect.logWarning("OMP abort did not acknowledge before local interruption.", {
            threadId,
            cause,
          }),
        ),
        Effect.forkDetach,
      );
      if (activeTurnId !== undefined && context.activeTurnId === activeTurnId) {
        context.activeTurnId = undefined;
        context.activeTurnError = undefined;
        yield* Ref.set(context.denyPendingSelects, false);
        yield* updateSession(context, { status: "ready" }, { clearActiveTurnId: true });
        // The only turn-end event the orchestration layer consumes is
        // turn.completed — turn.aborted alone would leave the thread stuck
        // in "running". `thread.turn-interrupt-requested` (with the turn id
        // the web client always sends) already marked the turn row
        // interrupted; this closes the session side.
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
          type: "turn.completed",
          payload: {
            state: "interrupted",
            errorMessage: "Interrupted by user.",
            ...(yield* turnCostPayload(context)),
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
          type: "turn.aborted",
          payload: { reason: "Interrupted by user." },
        });
      }
    });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/approval",
          detail: `Unknown pending omp approval: ${requestId}`,
        });
      }
      context.pendingApprovals.delete(requestId);
      // ADR 0001 decision 4: `acceptForSession` has no OMP equivalent
      // (approval mode is a launch flag) and maps to a single Approve.
      // `cancel` (the web "Cancel turn" button) must never grant the tool:
      // OMP's dialog only speaks Approve/Deny, so it maps to Deny and the
      // original decision still rides the `request.resolved` payload.
      const value = decision === "accept" || decision === "acceptForSession" ? "Approve" : "Deny";
      yield* answerExtensionUi(context, String(requestId), value).pipe(
        Effect.mapError((cause) => mapOmpRequestError("thread/approval", cause)),
      );
      if (decision === "decline" || decision === "cancel") {
        // OMP may retry a denied tool request. Auto-answer further approval
        // dialogs with Deny for this turn instead of leaving it stalled.
        yield* Ref.set(context.denyPendingSelects, true);
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId,
          turnId: context.activeTurnId,
          requestId,
        })),
        type: "request.resolved",
        payload: {
          requestType: "dynamic_tool_call",
          decision,
        },
      });
    });

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const request = context.pendingUiRequests.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending omp user-input request: ${requestId}`,
        });
      }
      context.pendingUiRequests.delete(requestId);
      const answer = answers[requestId];
      const selected = Array.isArray(answer) ? answer[0] : answer;
      // extension_ui_response is fire-and-forget on OMP's side (the dialog
      // resolves and no response line ever comes), and the id must stay
      // OMP's dialog id — so this cannot go through `send`, which stamps
      // its own correlation id and awaits a reply that never arrives.
      const sendResponse = (payload: Record<string, unknown>) =>
        context.client
          .sendFireAndForget({ type: "extension_ui_response", id: String(requestId), ...payload })
          .pipe(Effect.mapError((cause) => mapOmpRequestError("extension_ui_response", cause)));

      if (request.method === "select") {
        if (typeof selected !== "string") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: "OMP select dialogs require exactly one answer.",
          });
        }
        yield* sendResponse({ value: selected });
      } else if (request.method === "confirm") {
        yield* sendResponse({ confirmed: selected === "Yes" });
      } else {
        // input / editor: non-empty value answers only (empty = unanswered,
        // matches the custom-answer machinery — the client blocks empty
        // submits; this is the server-side backstop).
        if (typeof selected !== "string" || selected.trim().length === 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: "OMP text dialogs require a non-empty answer.",
          });
        }
        yield* sendResponse({ value: selected });
      }

      // Close the T3-side question card: web and mobile derive open cards
      // from activities, and the projected pending count reads the same
      // stream, so a successful answer must resolve the request exactly
      // like the other adapters do.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
        })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
    Effect.gen(function* () {
      // OMP's session is a resumable model-state cache; T3's event store is
      // the conversation truth (same decision as Pi, #52 decision 8). No T3
      // turn structure maps onto the JSONL file, so the snapshot is
      // deliberately empty.
      yield* requireSession(threadId);
      return { threadId, turns: [] };
    });

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = Effect.fn(
    "rollbackThread",
  )(function* (threadId: ThreadId, numTurns: number) {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "numTurns must be an integer >= 1.",
      });
    }

    const context = sessions.get(threadId);
    if (!context) {
      // No OMP session bound — nothing to rewind; no-op success.
      return { threadId, turns: [] };
    }

    const [expectedSessionFile, expectedSessionId] = yield* Effect.all([
      Ref.get(context.sessionFileRef),
      Ref.get(context.sessionIdRef),
    ]);
    const state = yield* context.client
      .send({ type: "get_state" })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("thread/rollback", cause)));
    const stateData = (state.data ?? {}) as Record<string, unknown>;
    if (stateData.isStreaming === true) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "OMP is still working on a turn. Wait for it to settle before reverting.",
      });
    }
    const currentSessionFile =
      typeof stateData.sessionFile === "string" ? stateData.sessionFile : undefined;
    const currentSessionId =
      typeof stateData.sessionId === "string" ? stateData.sessionId : undefined;
    if (
      expectedSessionFile !== undefined &&
      currentSessionFile !== undefined &&
      currentSessionFile !== expectedSessionFile
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail:
          "OMP session identity changed since the checkpoint cursor was recorded. Restart or resume the intended session before reverting.",
      });
    }
    if (
      expectedSessionId !== undefined &&
      currentSessionId !== undefined &&
      currentSessionId !== expectedSessionId
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail:
          "OMP session id no longer matches the checkpoint cursor. Restart or resume the intended session before reverting.",
      });
    }

    const boundaries = yield* Ref.get(context.turnBoundariesRef);
    const keptCount = boundaries.length - numTurns;
    if (keptCount < 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: `OMP has ${boundaries.length} recorded turn boundaries and cannot revert ${numTurns} turn(s).`,
      });
    }
    // OMP `branch(entryId)` forks immediately BEFORE the selected user
    // message. Target the first discarded turn, not the last retained one.
    const targetBoundary = boundaries[keptCount];
    if (!targetBoundary) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "OMP session has no recorded restore point for this rewind.",
      });
    }

    const branchMessages = yield* context.client
      .send({ type: "get_branch_messages" })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("thread/rollback", cause)));
    const branchMessagesData = (branchMessages.data ?? {}) as {
      readonly messages?: unknown;
      readonly entries?: unknown;
    };
    const entries = Array.isArray(branchMessagesData.messages)
      ? branchMessagesData.messages
      : branchMessagesData.entries;
    const matchingBoundaries = Array.isArray(entries)
      ? entries.filter(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            (entry as { readonly entryId?: unknown }).entryId === targetBoundary,
        ).length
      : 0;
    if (matchingBoundaries !== 1) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail:
          matchingBoundaries === 0
            ? "OMP checkpoint boundary is stale or missing from the active branch."
            : "OMP checkpoint boundary is ambiguous in the active branch.",
      });
    }

    const branchResponse = yield* context.client
      .send({ type: "branch", entryId: targetBoundary })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("thread/rollback", cause)));
    const branchData = (branchResponse.data ?? {}) as Record<string, unknown>;
    if (branchData.cancelled === true) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail:
          "OMP refused to rewind: a session_before_branch extension handler cancelled the branch.",
      });
    }

    // Branch forks the RPC session in-process to a new session file. The old
    // file is retained as the abandoned path; the cursor adopts only the fork.
    const afterBranch = yield* context.client
      .send({ type: "get_state" })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("thread/rollback", cause)));
    const afterBranchData = (afterBranch.data ?? {}) as Record<string, unknown>;
    const forkedSessionFile =
      typeof afterBranchData.sessionFile === "string" ? afterBranchData.sessionFile : undefined;
    if (!forkedSessionFile) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "OMP rewound the session but did not report the forked session file.",
      });
    }
    const forkedSessionId =
      typeof afterBranchData.sessionId === "string" ? afterBranchData.sessionId : undefined;

    yield* Ref.set(context.sessionFileRef, forkedSessionFile);
    yield* Ref.set(context.sessionIdRef, forkedSessionId);
    yield* Ref.set(context.turnBoundariesRef, boundaries.slice(0, keptCount));
    yield* syncSessionCursor(context);

    yield* Effect.logInfo("Rewound omp session via branch", {
      threadId,
      numTurns,
      forkedSessionFile,
    });
    return { threadId, turns: [] };
  });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    Effect.gen(function* () {
      const result: Array<ProviderSession> = [];
      for (const context of sessions.values()) {
        if (yield* Ref.get(context.stopped)) {
          continue;
        }
        result.push(context.session);
      }
      return result;
    });

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return false;
      }
      return !(yield* Ref.get(context.stopped));
    });

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
