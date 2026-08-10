import {
  type ModelCapabilities,
  type OmpSettings,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownOption(UnknownJson);

export const MINIMUM_OMP_VERSION = "17.0.9";

const OMP_PRESENTATION = {
  displayName: "OMP",
} as const;

const DEFAULT_OMP_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const OMP_MODELS_PROBE_TIMEOUT_MS = 90_000;
const OMP_COMMANDS_PROBE_TIMEOUT_MS = 30_000;

// OMP's current official headless startup is `omp --mode rpc`. Catalog probes
// add `--no-session` so discovery never reads or writes a live session. Keep
// this fixed: provider launchArgs belong to interactive sessions, not probes.
const OMP_RPC_PROBE_ARGS = ["--mode", "rpc", "--no-session"] as const;

export const makePendingOmpProvider = (
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings(
      [],
      ompSettings.customModels,
      DEFAULT_OMP_MODEL_CAPABILITIES,
    );

    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: ompSettings.enabled
          ? "OMP provider status has not been checked in this session yet."
          : "OMP is disabled in T3 Code settings.",
      },
    });
  });

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) {
    return undefined;
  }
  const message = cause.message.trim();
  if (
    message.length === 0 ||
    message === "An error occurred in Effect.tryPromise" ||
    message === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return message;
}

function formatOmpVersionProbeFailure(cause: unknown): {
  readonly installed: boolean;
  readonly message: string;
} {
  if (isCommandMissingCause(cause)) {
    return {
      installed: false,
      message: "OMP CLI (`omp`) is not installed or not on PATH.",
    };
  }

  const detail = normalizedErrorMessage(cause);
  return {
    installed: true,
    message: detail
      ? `Failed to execute OMP CLI health check: ${detail}`
      : "Failed to execute OMP CLI health check.",
  };
}

export function parseOmpVersion(output: string): string | null {
  const match = output.match(/(?:^|[^\d])v?(\d+\.\d+\.\d+)\b/i);
  return match?.[1] ?? parseGenericCliVersion(output);
}

export interface OmpModelRow {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly thinkingEffects: ReadonlyArray<string>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseThinkingEffects(value: unknown): ReadonlyArray<string> {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const thinking = value as Record<string, unknown>;
  const candidates = thinking.efforts ?? thinking.effects;
  if (!Array.isArray(candidates)) {
    return [];
  }

  const seen = new Set<string>();
  const effects: Array<string> = [];
  for (const candidate of candidates) {
    const effect = nonEmptyString(candidate);
    if (!effect || seen.has(effect)) {
      continue;
    }
    seen.add(effect);
    effects.push(effect);
  }
  return effects;
}

function parseOmpModelRow(record: Record<string, unknown>): OmpModelRow | undefined {
  const modelRecord =
    typeof record.model === "object" && record.model !== null
      ? (record.model as Record<string, unknown>)
      : record;
  const provider = nonEmptyString(record.provider) ?? nonEmptyString(modelRecord.provider);
  const rawId = nonEmptyString(modelRecord.id);
  const rawName = nonEmptyString(modelRecord.name);
  const id = rawId ?? rawName;
  const name = rawName ?? rawId;
  if (!provider || !id || !name) {
    return undefined;
  }

  return {
    provider,
    id,
    name,
    thinkingEffects: parseThinkingEffects(modelRecord.thinking ?? record.thinking),
  };
}

interface OmpRpcRows<T> {
  readonly foundResponse: boolean;
  readonly rows: ReadonlyArray<T>;
}

function scanOmpRpcResponseRows<T>(
  stdout: string,
  commandName: string,
  key: string,
  parseRow: (record: Record<string, unknown>) => T | undefined,
): OmpRpcRows<T> {
  let foundResponse = false;
  const rows: Array<T> = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = Option.getOrUndefined(decodeUnknownJson(trimmed));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }

    const response = parsed as Record<string, unknown>;
    if (
      response.type !== "response" ||
      response.command !== commandName ||
      response.success === false
    ) {
      continue;
    }

    const data = response.data;
    let entries: ReadonlyArray<unknown> | undefined;
    if (Array.isArray(data)) {
      entries = data;
    } else if (typeof data === "object" && data !== null) {
      const nested = (data as Record<string, unknown>)[key];
      if (Array.isArray(nested)) {
        entries = nested;
      }
    }
    if (!entries && Array.isArray(response[key])) {
      entries = response[key] as ReadonlyArray<unknown>;
    }
    if (!entries) {
      continue;
    }

    foundResponse = true;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const row = parseRow(entry as Record<string, unknown>);
      if (row !== undefined) {
        rows.push(row);
      }
    }
  }

  return { foundResponse, rows };
}

export function parseOmpModels(stdout: string): ReadonlyArray<OmpModelRow> {
  return scanOmpRpcResponseRows(stdout, "get_available_models", "models", parseOmpModelRow).rows;
}

export function flattenOmpModels(
  rows: ReadonlyArray<OmpModelRow>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];

  for (const row of rows) {
    const slug = `${row.provider}/${row.id}`;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: row.name,
      subProvider: row.provider,
      isCustom: false,
      capabilities:
        row.thinkingEffects.length > 0
          ? createModelCapabilities({
              optionDescriptors: [
                buildSelectOptionDescriptor({
                  id: "thinkingLevel",
                  label: "Thinking",
                  options: row.thinkingEffects.map((effect) => ({
                    value: effect,
                    label: effect,
                  })),
                }),
              ],
            })
          : DEFAULT_OMP_MODEL_CAPABILITIES,
    });
  }

  return models;
}

export interface OmpCommandRow {
  readonly name: string;
  readonly description: string | undefined;
  readonly hint: string | undefined;
  readonly group: string | undefined;
}

const OMP_COMMAND_GROUP_BY_SOURCE: Partial<Record<string, string>> = {
  builtin: "Builtin",
  extension: "Extension",
  custom: "Custom",
  file: "Prompt",
  skill: "Skill",
};
const OMP_COMMAND_GROUP_ORDER = ["Builtin", "Extension", "Custom", "Prompt", "Skill"] as const;

function parseOmpCommandRow(record: Record<string, unknown>): OmpCommandRow | undefined {
  const name = nonEmptyString(record.name);
  if (!name) {
    return undefined;
  }
  const input =
    typeof record.input === "object" && record.input !== null
      ? (record.input as Record<string, unknown>)
      : undefined;
  const source = nonEmptyString(record.source);

  return {
    name,
    description: nonEmptyString(record.description),
    hint: nonEmptyString(input?.hint),
    group: source ? OMP_COMMAND_GROUP_BY_SOURCE[source] : undefined,
  };
}

export function parseOmpCommands(stdout: string): ReadonlyArray<OmpCommandRow> {
  return scanOmpRpcResponseRows(stdout, "get_available_commands", "commands", parseOmpCommandRow)
    .rows;
}

export function flattenOmpCommands(
  rows: ReadonlyArray<OmpCommandRow>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  const commands: Array<ServerProviderSlashCommand> = [];

  const append = (row: OmpCommandRow) => {
    const key = row.name.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    commands.push({
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      ...(row.hint ? { input: { hint: row.hint } } : {}),
    });
  };

  for (const group of OMP_COMMAND_GROUP_ORDER) {
    for (const row of rows) {
      if (row.group === group) {
        append(row);
      }
    }
  }
  for (const row of rows) {
    if (row.group === undefined) {
      append(row);
    }
  }

  return commands;
}

class OmpRpcProbeError extends Data.TaggedError("OmpRpcProbeError")<{
  readonly reason: "timeout" | "failed" | "invalid-response";
  readonly detail: string;
}> {}

function asOmpRpcProbeError(cause: unknown): OmpRpcProbeError {
  if (cause instanceof OmpRpcProbeError) {
    return cause;
  }
  return new OmpRpcProbeError({
    reason: "failed",
    detail: normalizedErrorMessage(cause) ?? "Unknown error.",
  });
}

const runOmpRpcProbe = (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly commandLine: string;
  readonly timeoutMs: number;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(input.binaryPath, [...OMP_RPC_PROBE_ARGS], {
        cwd: input.cwd,
        env: input.environment,
        extendEnv: false,
        stdin: {
          stream: Stream.encodeText(Stream.make(`${input.commandLine}\n`)),
          endOnDone: true,
        },
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new OmpRpcProbeError({
        reason: "failed",
        detail: `OMP RPC probe exited with status ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
      });
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.mapError(asOmpRpcProbeError),
    Effect.timeout(Duration.millis(input.timeoutMs)),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new OmpRpcProbeError({
          reason: "timeout",
          detail: `OMP RPC probe timed out after ${input.timeoutMs}ms.`,
        }),
      ),
    ),
  );

function buildOmpSnapshot(input: {
  readonly settings: OmpSettings;
  readonly checkedAt: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  readonly message?: string;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: input.models,
    slashCommands: input.slashCommands ?? [],
    probe: {
      installed: input.installed,
      version: input.version,
      status: input.status,
      auth: { status: "unknown" },
      ...(input.message ? { message: input.message } : {}),
    },
  });
}

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = () =>
    providerModelsFromSettings([], ompSettings.customModels, DEFAULT_OMP_MODEL_CAPABILITIES);

  if (!ompSettings.enabled) {
    return buildOmpSnapshot({
      settings: ompSettings,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      models: fallbackModels(),
      message: "OMP is disabled in T3 Code settings.",
    });
  }

  const versionExit = yield* spawnAndCollect(
    ompSettings.binaryPath,
    ChildProcess.make(ompSettings.binaryPath, ["--version"], {
      cwd,
      env: resolvedEnvironment,
      extendEnv: false,
    }),
  ).pipe(Effect.exit);

  if (versionExit._tag === "Failure") {
    const failure = formatOmpVersionProbeFailure(Cause.squash(versionExit.cause));
    return buildOmpSnapshot({
      settings: ompSettings,
      checkedAt,
      installed: failure.installed,
      version: null,
      status: "error",
      models: fallbackModels(),
      message: failure.message,
    });
  }

  const versionResult = versionExit.value;
  const version = parseOmpVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    return buildOmpSnapshot({
      settings: ompSettings,
      checkedAt,
      installed: true,
      version,
      status: "error",
      models: fallbackModels(),
      message: `OMP CLI is installed but \`omp --version\` exited with status ${versionResult.code}.`,
    });
  }
  if (!version) {
    return buildOmpSnapshot({
      settings: ompSettings,
      checkedAt,
      installed: true,
      version: null,
      status: "error",
      models: fallbackModels(),
      message: `Unable to determine OMP version from \`omp --version\` output. T3 Code requires OMP v${MINIMUM_OMP_VERSION} or newer.`,
    });
  }
  if (compareSemverVersions(version, MINIMUM_OMP_VERSION) < 0) {
    return buildOmpSnapshot({
      settings: ompSettings,
      checkedAt,
      installed: true,
      version,
      status: "error",
      models: fallbackModels(),
      message: `OMP v${version} is too old. Upgrade to v${MINIMUM_OMP_VERSION} or newer.`,
    });
  }

  const runRpcProbe = (commandLine: string, timeoutMs: number) =>
    runOmpRpcProbe({
      binaryPath: ompSettings.binaryPath,
      cwd,
      environment: resolvedEnvironment,
      commandLine,
      timeoutMs,
    });

  const modelProbeExit = yield* runRpcProbe(
    '{"type":"get_available_models"}',
    OMP_MODELS_PROBE_TIMEOUT_MS,
  ).pipe(Effect.exit);

  let modelRows: ReadonlyArray<OmpModelRow> = [];
  let modelProbeFailure: OmpRpcProbeError | undefined;
  if (modelProbeExit._tag === "Failure") {
    modelProbeFailure = asOmpRpcProbeError(Cause.squash(modelProbeExit.cause));
  } else {
    const parsed = scanOmpRpcResponseRows(
      modelProbeExit.value,
      "get_available_models",
      "models",
      parseOmpModelRow,
    );
    if (parsed.foundResponse) {
      modelRows = parsed.rows;
    } else {
      modelProbeFailure = new OmpRpcProbeError({
        reason: "invalid-response",
        detail: "OMP RPC probe completed without a usable get_available_models response.",
      });
    }
  }
  if (modelProbeFailure) {
    yield* Effect.logWarning("OMP model catalog probe did not complete.", {
      reason: modelProbeFailure.reason,
      detail: modelProbeFailure.detail,
      version,
    });
  }

  const models = providerModelsFromSettings(
    flattenOmpModels(modelRows),
    ompSettings.customModels,
    DEFAULT_OMP_MODEL_CAPABILITIES,
  );
  const discoveredModelCount = models.reduce((count, model) => count + (model.isCustom ? 0 : 1), 0);

  const commandProbeExit = yield* runRpcProbe(
    '{"type":"get_available_commands"}',
    OMP_COMMANDS_PROBE_TIMEOUT_MS,
  ).pipe(Effect.exit);
  let slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [];
  if (commandProbeExit._tag === "Success") {
    const parsed = scanOmpRpcResponseRows(
      commandProbeExit.value,
      "get_available_commands",
      "commands",
      parseOmpCommandRow,
    );
    if (parsed.foundResponse) {
      slashCommands = flattenOmpCommands(parsed.rows);
    } else {
      yield* Effect.logWarning("OMP command catalog probe returned no usable response.", {
        version,
      });
    }
  } else {
    const failure = asOmpRpcProbeError(Cause.squash(commandProbeExit.cause));
    yield* Effect.logWarning("OMP command catalog enrichment failed.", {
      reason: failure.reason,
      detail: failure.detail,
      version,
    });
  }

  const message = modelProbeFailure
    ? modelProbeFailure.reason === "timeout"
      ? "OMP is available, but the model catalog probe timed out. Models appear once a later probe completes."
      : "OMP is available, but the model catalog probe did not complete. Models appear once a later probe succeeds."
    : discoveredModelCount > 0
      ? `${discoveredModelCount} model${discoveredModelCount === 1 ? "" : "s"} available through OMP.`
      : "OMP is available, but it did not report any available models. Verify that the provider instance environment contains the credentials required by the configured OMP providers.";

  return buildOmpSnapshot({
    settings: ompSettings,
    checkedAt,
    installed: true,
    version,
    status: discoveredModelCount > 0 ? "ready" : "warning",
    models,
    slashCommands,
    message,
  });
});
