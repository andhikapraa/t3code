import type {
  OrchestrationV2ProviderFailure,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Upstream accounts whose published usage windows also gate a gateway model.
 * A Pi model routed to Claude spends the same subscription as Claude Code.
 */
const UPSTREAM_DRIVERS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly driver: ProviderDriverKind;
}> = [
  { pattern: /(^|\/)claude-/i, driver: "claudeAgent" as ProviderDriverKind },
  { pattern: /(^|\/)(gpt-|o\d|codex)/i, driver: "codex" as ProviderDriverKind },
];

/** The upstream account whose windows gate this gateway model, if any. */
export function upstreamDriverForModel(model: string): ProviderDriverKind | undefined {
  return UPSTREAM_DRIVERS.find(({ pattern }) => pattern.test(model))?.driver;
}

/**
 * When a gateway's limit shows no reset time, the matching upstream account's
 * exhausted window supplies one. A short burst limit leaves every window
 * below 100%, so it falls back to `fallbackMs` after the failure instead.
 */
export function estimateUsageLimitResetAt(input: {
  readonly model: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly failedAtMs: number;
  readonly fallbackMs: number;
}): string {
  const upstream = upstreamDriverForModel(input.model);
  let latest: number | null = null;
  for (const provider of input.providers) {
    if (upstream === undefined || provider.driver !== upstream) continue;
    for (const window of provider.usageLimits?.windows ?? []) {
      if (window.usedPercent < 100 || window.resetsAt === undefined) continue;
      const resetMs = Date.parse(window.resetsAt);
      if (resetMs > input.failedAtMs && (latest === null || resetMs > latest)) latest = resetMs;
    }
  }
  return DateTime.formatIso(DateTime.makeUnsafe(latest ?? input.failedAtMs + input.fallbackMs));
}

/** A gateway usage-limit failure that still needs a reset time. */
export function needsResetEstimate(failure: OrchestrationV2ProviderFailure): boolean {
  return failure.class === "usage_limit" && failure.resetAt == null;
}
