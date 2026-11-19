import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/**
 * Handoffs (`/handoff`): continue a thread's work in a new thread in the same
 * project and workspace. The server writes the handoff and sends it as the new
 * thread's first message.
 */

/** `/handoff [focus]` returns the focus ("" when none); anything else is not a handoff. */
export function parseHandoffCommand(text: string): string | null {
  const match = /^\/handoff(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  return match[1]?.trim() ?? "";
}

// Mirrors the `ThreadHandoffInput` limit so the client never clears a draft the
// server would reject.
const HANDOFF_FOCUS_MAX_CHARS = 20_000;

/** Why a parsed `/handoff` focus cannot be sent, or null when it can. */
export function handoffBlockReason(
  focus: string,
  resolve: MFunctionType = mFallback,
): string | null {
  return focus.length > HANDOFF_FOCUS_MAX_CHARS
    ? resolve(
        msg("Handoff focus is limited to {limit} characters.", {
          limit: HANDOFF_FOCUS_MAX_CHARS.toLocaleString("en-US"),
        }),
      )
    : null;
}

/** Handoffs are written from a fork of the provider's native session. */
export function supportsHandoff(driver: string | null | undefined): boolean {
  return driver === "pi";
}
