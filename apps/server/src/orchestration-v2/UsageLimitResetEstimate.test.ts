import { describe, expect, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";

import { estimateUsageLimitResetAt, isUsageLimitMessage } from "./UsageLimitResetEstimate.ts";

const failedAtMs = Date.parse("2026-10-04T12:00:00.000Z");
const fallbackMs = 5 * 60_000;

function provider(
  driver: string,
  windows: ReadonlyArray<{ usedPercent: number; resetsAt?: string }>,
): ServerProvider {
  return {
    driver,
    usageLimits: {
      checkedAt: "2026-10-04T11:59:00.000Z",
      windows: windows.map((window, index) => ({
        id: `w${index}`,
        kind: "session",
        label: "Session",
        ...window,
      })),
    },
  } as unknown as ServerProvider;
}

describe("isUsageLimitMessage", () => {
  it("recognizes gateway cooldowns and rate limits", () => {
    expect(
      isUsageLimitMessage(
        'axon API error (429): {"message":"All credentials for model claude-opus-5-5 are cooling down","code":"model_cooldown"}',
      ),
    ).toBe(true);
    expect(isUsageLimitMessage("Too Many Requests")).toBe(true);
  });

  it("leaves connection failures to ordinary resume", () => {
    expect(isUsageLimitMessage("socket timed out")).toBe(false);
    expect(isUsageLimitMessage("502 Bad Gateway")).toBe(false);
  });
});

describe("estimateUsageLimitResetAt", () => {
  it("waits for the exhausted Claude window when a Pi Claude model is limited", () => {
    const resetAt = estimateUsageLimitResetAt({
      model: "axon/claude-opus-5-5",
      providers: [
        provider("claudeAgent", [
          { usedPercent: 100, resetsAt: "2026-10-04T14:00:00.000Z" },
          { usedPercent: 40, resetsAt: "2026-10-09T00:00:00.000Z" },
        ]),
        provider("codex", [{ usedPercent: 100, resetsAt: "2026-10-05T00:00:00.000Z" }]),
      ],
      failedAtMs,
      fallbackMs,
    });
    expect(resetAt).toBe("2026-10-04T14:00:00.000Z");
  });

  it("falls back to a short wait for a burst limit below every window", () => {
    const resetAt = estimateUsageLimitResetAt({
      model: "axon/claude-opus-5-5",
      providers: [
        provider("claudeAgent", [{ usedPercent: 80, resetsAt: "2026-10-04T14:00:00.000Z" }]),
      ],
      failedAtMs,
      fallbackMs,
    });
    expect(resetAt).toBe("2026-10-04T12:05:00.000Z");
  });

  it("ignores a window whose reset already passed", () => {
    const resetAt = estimateUsageLimitResetAt({
      model: "claude-sonnet-5-5",
      providers: [
        provider("claudeAgent", [{ usedPercent: 100, resetsAt: "2026-10-04T11:00:00.000Z" }]),
      ],
      failedAtMs,
      fallbackMs,
    });
    expect(resetAt).toBe("2026-10-04T12:05:00.000Z");
  });
});
