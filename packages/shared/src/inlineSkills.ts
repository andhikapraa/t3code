import type { ServerProviderSkill } from "@t3tools/contracts";

import { SKILL_MENTION_PATTERN } from "./composerInlineTokens.ts";

export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

/** Known skills mentioned in `text`, with each `$name` token's span. */
export function* matchInlineSkills(text: string, skills: readonly InlineSkill[]) {
  for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2] ?? "";
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) continue;
    // The pattern stops before trailing punctuation, so the span is the token itself.
    const start = match.index + (match[1]?.length ?? 0);
    yield { start, end: match.index + match[0].length, skill, rawText: `$${name}` };
  }
}
