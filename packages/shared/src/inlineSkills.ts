import type { ServerProviderSkill } from "@t3tools/contracts";

import { SKILL_MENTION_PATTERN } from "./composerInlineTokens.ts";

export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  return skill.displayName?.trim() || skill.name;
}

/** Known skills mentioned in `text`, with each `$name` token's span. */
export function* matchInlineSkills<Skill extends InlineSkill>(
  text: string,
  skills: readonly Skill[],
) {
  for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2] ?? "";
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) continue;
    // The pattern stops before trailing punctuation, so the span is the token itself.
    const start = match.index + (match[1]?.length ?? 0);
    yield { start, end: match.index + match[0].length, skill, rawText: `$${name}` };
  }
}
