import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay } from "./ProviderInstanceCard";
import { getOmpProfileResolutionKey } from "./OmpProfileConfigEditor";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("getOmpProfileResolutionKey", () => {
  const base = {
    config: { launchArgs: "--profile work", profile: "fallback", customModels: ["one"] },
    environment: [
      { name: "HOME", value: "/tmp/home" },
      { name: "PI_CONFIG_DIR", value: ".omp" },
    ],
  } as const;

  it("changes when OMP profile resolution inputs change", () => {
    const original = getOmpProfileResolutionKey(base);
    expect(
      getOmpProfileResolutionKey({
        ...base,
        config: { ...base.config, customModels: ["two"] },
      }),
    ).toBe(original);
    expect(
      getOmpProfileResolutionKey({
        ...base,
        config: { ...base.config, launchArgs: "--profile other" },
      }),
    ).not.toBe(original);
    expect(
      getOmpProfileResolutionKey({
        ...base,
        environment: [{ name: "HOME", value: "/tmp/other" }],
      }),
    ).not.toBe(original);
  });
});
