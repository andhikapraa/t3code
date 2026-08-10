import { defaultInstanceIdForDriver, ProviderDriverKind, ServerSettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

it("hydrates the default OMP instance from legacy settings", () => {
  const settings = decodeServerSettings({});
  const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("omp"));
  const instance = deriveProviderInstanceConfigMap(settings)[instanceId];

  expect(instance).toMatchObject({
    driver: "omp",
    config: {
      enabled: true,
      binaryPath: "omp",
    },
  });
});
