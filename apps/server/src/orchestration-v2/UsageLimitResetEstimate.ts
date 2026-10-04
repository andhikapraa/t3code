import type {
  OrchestrationV2ProviderFailure,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Gateway providers such as Pi report subscription limits as plain 429 text
 * after their own short retries give up. Their wording varies by gateway, so
 * this matches the shared vocabulary rather than one gateway's error codes.
 */
const USAGE_LIMIT_PATTERN =
  /\b429\b|rate.?limit|too many requests|usage.?limit|cooling down|model_cooldown|quota/i;

export function isUsageLimitMessage(message: string): boolean {
  return USAGE_LIMIT_PATTERN.test(message);
}

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
  const upstream = UPSTREAM_DRIVERS.find(({ pattern }) => pattern.test(input.model))?.driver;
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
