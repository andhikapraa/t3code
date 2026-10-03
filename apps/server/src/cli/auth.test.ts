import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes, AuthStandardClientScopes } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../binCli.ts";

const createPairing = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-auth-test-" });
    yield* Command.runWith(cli, { version: "0.0.0" })([
      "auth",
      "pairing",
      "create",
      "--base-dir",
      baseDir,
      "--json",
      ...args,
    ]);
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
    return JSON.parse(output) as { readonly scopes: ReadonlyArray<string> };
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

describe("auth pairing create", () => {
  it.effect("issues standard client scopes by default", () =>
    Effect.gen(function* () {
      const issued = yield* createPairing([]);
      assert.deepStrictEqual(issued.scopes, [...AuthStandardClientScopes]);
    }),
  );

  it.effect("issues administrative scopes with --admin", () =>
    Effect.gen(function* () {
      const issued = yield* createPairing(["--admin"]);
      assert.deepStrictEqual(issued.scopes, [...AuthAdministrativeScopes]);
    }),
  );
});
