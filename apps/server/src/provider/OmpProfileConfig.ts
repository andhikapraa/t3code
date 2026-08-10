import * as NodeOS from "node:os";
import {
  defaultInstanceIdForDriver,
  OmpProfileConfigError,
  type OmpProfileConfigSnapshot,
  type OmpProfileConfigWriteInput,
  OmpSettings,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironment,
  type ServerSettings as ServerSettingsContract,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { isMap, isSeq, Scalar, parseDocument } from "yaml";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const decodeOmpSettings = Schema.decodeUnknownSync(OmpSettings);
const isOmpProfileConfigError = Schema.is(OmpProfileConfigError);
const REDACTED = "********";
const OMP_PROFILE_WRITE_SEMAPHORE = Semaphore.makeUnsafe(1);
const SENSITIVE_KEY =
  /(?:api[-_]?key|(?:access|refresh|auth|bearer|session)?[-_]?token|secret|password|credentials?|private[-_]?key)$/i;
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");
const DEFAULT_OMP_INSTANCE_ID = defaultInstanceIdForDriver(OMP_DRIVER_KIND);

type ResolvedConfig = {
  readonly instanceId: OmpProfileConfigSnapshot["instanceId"];
  readonly profile: string;
  readonly configPath: string;
  readonly binaryPath: string;
  readonly overlayPaths: ReadonlyArray<string>;
  readonly guidance: ReadonlyArray<string>;
};

const error = (
  stage: OmpProfileConfigError["stage"],
  detail: string,
  configPath?: string,
  cause?: unknown,
) =>
  new OmpProfileConfigError({
    stage,
    detail,
    ...(configPath ? { configPath } : {}),
    ...(cause ? { cause } : {}),
  });

export function resolveOmpProfileInstance(
  settings: ServerSettingsContract,
  instanceId: ResolvedConfig["instanceId"],
): ProviderInstanceConfig | undefined {
  const explicit = settings.providerInstances?.[instanceId];
  if (explicit !== undefined) return explicit;
  if (instanceId !== DEFAULT_OMP_INSTANCE_ID) return undefined;
  return {
    driver: OMP_DRIVER_KIND,
    config: settings.providers.omp,
  };
}

function environmentRecord(
  environment: ProviderInstanceEnvironment | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of environment ?? []) result[variable.name] = variable.value;
  return result;
}

function explicitProfileFromArgs(launchArgs: string): string | undefined {
  let profile: string | undefined;
  const args = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--profile") {
      const value = args[index + 1];
      if (value !== undefined) {
        profile = value;
        index += 1;
      }
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    }
  }
  return profile;
}

function normalizedProfile(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "default") return undefined;
  if (!PROFILE_NAME.test(trimmed)) throw new Error(`invalid OMP profile name '${value}'`);
  return trimmed;
}

function expandHome(pathService: Path.Path, value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return pathService.join(home, value.slice(2));
  return value;
}

function overlayPaths(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly launchArgs: string;
  readonly cwd: string;
  readonly platform: string;
  readonly path: Path.Path;
}): string[] {
  const delimiter = input.platform === "win32" ? ";" : ":";
  const home = input.env.HOME ?? NodeOS.homedir();
  const result = (input.env.PI_CONFIG_FILES ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((value) => input.path.resolve(input.cwd, expandHome(input.path, value, home)));
  const args = tokenizeCliArgs(input.launchArgs);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--config") continue;
    const value = args[index + 1];
    if (value !== undefined) {
      result.push(input.path.resolve(input.cwd, expandHome(input.path, value, home)));
      index += 1;
    }
  }
  return [...new Set(result)];
}

function redactDocument(document: unknown, fields: string[], restoreFrom?: unknown): void {
  const redact = (node: unknown, current: unknown, prefix: string): void => {
    if (isMap(node)) {
      const currentItems = isMap(current) ? current.items : [];
      for (const pair of node.items) {
        const key = String(
          pair.key && typeof pair.key === "object" && "value" in pair.key
            ? pair.key.value
            : (pair.key ?? ""),
        );
        const currentPair = currentItems.find((candidate) => {
          const candidateKey =
            candidate.key && typeof candidate.key === "object" && "value" in candidate.key
              ? candidate.key.value
              : candidate.key;
          return String(candidateKey ?? "") === key;
        });
        const nextPath = prefix ? `${prefix}.${key}` : key;
        if (SENSITIVE_KEY.test(key) && pair.value !== null && pair.value !== undefined) {
          const value = pair.value;
          if (
            restoreFrom !== undefined &&
            value instanceof Scalar &&
            value.value === REDACTED &&
            currentPair?.value !== undefined
          ) {
            pair.value = currentPair.value;
          } else if (restoreFrom === undefined) {
            fields.push(nextPath);
            pair.value = new Scalar(REDACTED);
          } else if (value instanceof Scalar && value.value === REDACTED) {
            throw error(
              "parse",
              `redacted value at '${nextPath}' has no existing secret to preserve`,
            );
          }
        } else {
          redact(pair.value, currentPair?.value, nextPath);
        }
      }
      return;
    }
    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        const currentItem = isSeq(current) ? current.items[index] : undefined;
        redact(item, currentItem, `${prefix}[${index}]`);
      });
    }
  };
  redact(document, restoreFrom, "");
}

export interface OmpProfileConfigServiceShape {
  readonly read: (
    instanceId: OmpProfileConfigSnapshot["instanceId"],
  ) => Effect.Effect<OmpProfileConfigSnapshot, OmpProfileConfigError>;
  readonly write: (
    input: OmpProfileConfigWriteInput,
  ) => Effect.Effect<OmpProfileConfigSnapshot, OmpProfileConfigError>;
}

export class OmpProfileConfigService extends Context.Service<
  OmpProfileConfigService,
  OmpProfileConfigServiceShape
>()("t3/provider/OmpProfileConfig/OmpProfileConfigService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcessPlatform;

  const fileExists = (filePath: string, stage: OmpProfileConfigError["stage"]) =>
    fs
      .exists(filePath)
      .pipe(
        Effect.mapError((cause) =>
          error(stage, "failed to inspect configuration path", filePath, cause),
        ),
      );
  const readFile = (filePath: string) =>
    fs
      .readFileString(filePath)
      .pipe(
        Effect.mapError((cause) =>
          error("read", "failed to read configuration file", filePath, cause),
        ),
      );
  const revisionOf = (contents: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(contents))
      .pipe(Effect.map(Encoding.encodeHex), Effect.orDie);

  const resolve = (
    instanceId: ResolvedConfig["instanceId"],
  ): Effect.Effect<ResolvedConfig, OmpProfileConfigError> =>
    Effect.gen(function* () {
      const serverSettings = yield* settings.getSettings.pipe(
        Effect.mapError((cause) =>
          error("resolve", "failed to read server settings", undefined, cause),
        ),
      );
      const instance = resolveOmpProfileInstance(serverSettings, instanceId);
      if (!instance || instance.driver !== ProviderDriverKind.make("omp")) {
        return yield* error("resolve", `provider instance '${instanceId}' is not an OMP instance`);
      }
      const derived = yield* Effect.try({
        try: () => {
          const config = decodeOmpSettings(instance.config ?? {});
          const env = environmentRecord(instance.environment);
          const configuredProfile =
            explicitProfileFromArgs(config.launchArgs)?.trim() ||
            config.profile.trim() ||
            env.OMP_PROFILE ||
            env.PI_PROFILE;
          const profile = normalizedProfile(configuredProfile);
          const home = env.HOME?.trim() || NodeOS.homedir();
          const configDirName = env.PI_CONFIG_DIR?.trim() || ".omp";
          const configRoot = pathService.join(home, configDirName);
          const profileRoot = profile
            ? pathService.join(configRoot, "profiles", profile)
            : configRoot;
          const defaultAgentDir = pathService.join(profileRoot, "agent");
          const agentDir = profile
            ? defaultAgentDir
            : env.PI_CODING_AGENT_DIR?.trim()
              ? pathService.resolve(
                  serverConfig.cwd,
                  expandHome(pathService, env.PI_CODING_AGENT_DIR.trim(), home),
                )
              : defaultAgentDir;
          return { config, env, profile, agentDir };
        },
        catch: (cause) => error("resolve", "invalid OMP profile configuration", undefined, cause),
      });
      const xdgBase = derived.profile
        ? pathService.join(derived.env.XDG_DATA_HOME ?? "", "omp", "profiles", derived.profile)
        : pathService.join(derived.env.XDG_DATA_HOME ?? "", "omp");
      const usesXdg =
        (platform === "linux" || platform === "darwin") &&
        Boolean(derived.env.XDG_DATA_HOME) &&
        (yield* fileExists(xdgBase, "resolve"));
      const agentDir = usesXdg ? xdgBase : derived.agentDir;
      const yml = pathService.join(agentDir, "config.yml");
      const yaml = pathService.join(agentDir, "config.yaml");
      const configPath = (yield* fileExists(yml, "resolve"))
        ? yml
        : (yield* fileExists(yaml, "resolve"))
          ? yaml
          : yml;
      const overlays = overlayPaths({
        env: derived.env,
        launchArgs: derived.config.launchArgs,
        cwd: serverConfig.cwd,
        platform,
        path: pathService,
      });
      const guidance = [
        derived.profile
          ? `Selected OMP profile: ${derived.profile}.`
          : "Selected OMP default profile.",
        "Credentials are redacted in this editor; leave ******** unchanged to preserve an existing secret.",
        ...(derived.config.binaryPath.trim() !== "omp"
          ? [
              "This instance uses a custom OMP binary; wrapper-provided config overrides are not inspectable here.",
            ]
          : []),
        ...(overlays.length > 0
          ? ["Explicit config overlays are read by OMP but are not edited by this panel."]
          : []),
      ];
      return {
        instanceId,
        profile: derived.profile ?? "default",
        configPath,
        binaryPath: derived.config.binaryPath,
        overlayPaths: overlays,
        guidance,
      } satisfies ResolvedConfig;
    });

  const read = (
    instanceId: ResolvedConfig["instanceId"],
  ): Effect.Effect<OmpProfileConfigSnapshot, OmpProfileConfigError> =>
    Effect.gen(function* () {
      const resolved = yield* resolve(instanceId);
      const exists = yield* fileExists(resolved.configPath, "read");
      const raw = exists ? yield* readFile(resolved.configPath) : "";
      if (raw.length > 0) {
        const document = parseDocument(raw);
        if (document.errors.length > 0) {
          return yield* error("parse", document.errors[0]!.message, resolved.configPath);
        }
        redactDocument(document.contents, []);
        return {
          ...resolved,
          exists,
          content: document.toString(),
          revision: yield* revisionOf(raw),
        } satisfies OmpProfileConfigSnapshot;
      }
      return {
        ...resolved,
        exists,
        content: "",
        revision: exists ? yield* revisionOf(raw) : null,
      } satisfies OmpProfileConfigSnapshot;
    });

  const write = (
    input: OmpProfileConfigWriteInput,
  ): Effect.Effect<OmpProfileConfigSnapshot, OmpProfileConfigError> =>
    OMP_PROFILE_WRITE_SEMAPHORE.withPermits(1)(
      Effect.gen(function* () {
        const resolved = yield* resolve(input.instanceId);
        const exists = yield* fileExists(resolved.configPath, "write");
        const current = exists ? yield* readFile(resolved.configPath) : "";
        const currentRevision = yield* revisionOf(current);
        const revisionMatches =
          input.expectedRevision === null ? !exists : input.expectedRevision === currentRevision;
        if (!revisionMatches) {
          return yield* error(
            "conflict",
            "the profile changed in another session; reload before saving",
            resolved.configPath,
          );
        }
        const document = parseDocument(input.content);
        if (document.errors.length > 0) {
          return yield* error("parse", document.errors[0]!.message, resolved.configPath);
        }
        if (current.length > 0) {
          const existing = parseDocument(current);
          if (existing.errors.length > 0) {
            return yield* error("parse", existing.errors[0]!.message, resolved.configPath);
          }
          yield* Effect.try({
            try: () => redactDocument(document.contents, [], existing.contents),
            catch: (cause) =>
              isOmpProfileConfigError(cause)
                ? cause
                : error(
                    "parse",
                    "failed to preserve redacted credentials",
                    resolved.configPath,
                    cause,
                  ),
          });
        }
        yield* writeFileStringAtomically({
          filePath: resolved.configPath,
          contents: document.toString(),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
          Effect.mapError((cause) =>
            error("write", "atomic write failed", resolved.configPath, cause),
          ),
        );
        return yield* read(input.instanceId);
      }),
    );

  return { read, write } satisfies OmpProfileConfigServiceShape;
});

export const layer = Layer.effect(OmpProfileConfigService, make);
