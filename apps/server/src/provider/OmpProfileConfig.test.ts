import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  defaultInstanceIdForDriver,
  OmpProfileConfigError,
  ProviderDriverKind,
  ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OmpProfileConfig from "./OmpProfileConfig.ts";

const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("omp"));
const testHome = `/tmp/t3code-omp-profile-${NodeCrypto.randomUUID()}`;
const configPath = `${testHome}/.omp/profiles/work/agent/config.yml`;

const layer = OmpProfileConfig.layer.pipe(
  Layer.provideMerge(
    ServerSettings.layerTest({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("omp"),
          environment: [{ name: "HOME", value: testHome, sensitive: false }],
          config: {
            binaryPath: "omp-wrapper",
            launchArgs: "--profile work --config ./overlay.yml",
            profile: "ignored-profile",
          },
        },
      },
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest("/workspace", { prefix: "t3code-omp-profile-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin")),
);

it("resolves the legacy default OMP instance for profile editing", () => {
  const settings = Schema.decodeUnknownSync(ServerSettingsSchema)({});
  const instance = OmpProfileConfig.resolveOmpProfileInstance(settings, instanceId);

  assert.strictEqual(instance?.driver, ProviderDriverKind.make("omp"));
  assert.deepStrictEqual(instance?.config, settings.providers.omp);
});

it.layer(layer)("OmpProfileConfig", (it) => {
  it.effect("redacts credentials and preserves them through atomic YAML edits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profile = yield* OmpProfileConfig.OmpProfileConfigService;
      yield* fs.makeDirectory(`${testHome}/.omp/profiles/work/agent`, { recursive: true });
      yield* fs.writeFileString(
        configPath,
        "# retained comment\n" +
          "unknownField: keep-me\n" +
          "apiKey: super-secret\n" +
          "hindsight:\n" +
          "  apiToken: bearer-secret\n" +
          "compaction:\n" +
          "  thresholdTokens: 123\n" +
          "  reserveTokens: 456\n" +
          "theme:\n" +
          "  dark: true\n",
      );

      const before = yield* profile.read(instanceId);
      assert.strictEqual(before.profile, "work");
      assert.strictEqual(before.configPath, configPath);
      assert.notInclude(before.content, "super-secret");
      assert.include(before.content, 'apiKey: "********"');
      assert.notInclude(before.content, "bearer-secret");
      assert.include(before.content, 'apiToken: "********"');
      assert.include(before.content, "thresholdTokens: 123");
      assert.include(before.content, "reserveTokens: 456");
      assert.deepStrictEqual(before.overlayPaths, ["/workspace/overlay.yml"]);
      assert.include(before.guidance.join(" "), "custom OMP binary");

      const after = yield* profile.write({
        instanceId,
        expectedRevision: before.revision,
        content: before.content
          .replace("dark: true", "dark: false")
          .replace("thresholdTokens: 123", "thresholdTokens: 321"),
      });
      const persisted = yield* fs.readFileString(configPath);
      assert.include(persisted, "# retained comment");
      assert.include(persisted, "unknownField: keep-me");
      assert.include(persisted, "apiKey: super-secret");
      assert.include(persisted, "dark: false");
      assert.include(persisted, "apiToken: bearer-secret");
      assert.include(persisted, "thresholdTokens: 321");
      assert.notInclude(after.content, "super-secret");

      const conflict = yield* profile
        .write({
          instanceId,
          expectedRevision: before.revision,
          content: after.content,
        })
        .pipe(Effect.flip);
      assert.strictEqual(conflict.stage, "conflict");

      const nullRevisionConflict = yield* profile
        .write({
          instanceId,
          expectedRevision: null,
          content: after.content,
        })
        .pipe(Effect.flip);
      assert.strictEqual(nullRevisionConflict.stage, "conflict");

      const concurrentBase = yield* profile.read(instanceId);
      const firstConcurrentContent = concurrentBase.content.replace("dark: false", "dark: true");
      const secondConcurrentContent = concurrentBase.content.replace(
        "dark: false",
        "dark: false\n  compact: true",
      );
      const outcomes = yield* Effect.all(
        [
          Effect.gen(function* () {
            const service = yield* OmpProfileConfig.OmpProfileConfigService;
            return yield* service.write({
              instanceId,
              expectedRevision: concurrentBase.revision,
              content: firstConcurrentContent,
            });
          }).pipe(Effect.provide(layer), Effect.result),
          Effect.gen(function* () {
            const service = yield* OmpProfileConfig.OmpProfileConfigService;
            return yield* service.write({
              instanceId,
              expectedRevision: concurrentBase.revision,
              content: secondConcurrentContent,
            });
          }).pipe(Effect.provide(layer), Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
      const concurrentConflicts = outcomes.filter((outcome) => outcome._tag === "Failure");
      assert.strictEqual(concurrentConflicts.length, 1);
      const concurrentFailure = concurrentConflicts[0]?.failure;
      if (!Schema.is(OmpProfileConfigError)(concurrentFailure)) {
        throw new Error("Expected the concurrent stale write to fail with OmpProfileConfigError");
      }
      assert.strictEqual(concurrentFailure.stage, "conflict");
    }).pipe(
      Effect.ensuring(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.remove(testHome, { recursive: true }).pipe(Effect.ignore),
        ),
      ),
    ),
  );
});
