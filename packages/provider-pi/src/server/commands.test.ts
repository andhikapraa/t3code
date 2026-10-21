import { expect, it } from "@effect/vitest";

import {
  parsePiDiscoveredCommands,
  PI_BTW_SLASH_COMMAND,
  PI_HANDOFF_SLASH_COMMAND,
  withPiBuiltinSlashCommands,
} from "./commands.ts";

it("maps current Pi skill metadata to T3's user and project skill scopes", () => {
  expect(
    parsePiDiscoveredCommands({
      commands: [
        {
          name: "skill:global-review",
          description: "Review changes.",
          source: "skill",
          sourceInfo: {
            path: "/home/test/.agents/skills/global-review/SKILL.md",
            scope: "user",
          },
        },
        {
          name: "skill:project-deploy",
          description: "Deploy this project.",
          source: "skill",
          sourceInfo: {
            path: "/workspace/.agents/skills/project-deploy/SKILL.md",
            scope: "project",
          },
        },
        { name: "hello", description: "Say hello.", source: "extension" },
      ],
    }),
  ).toEqual({
    skills: [
      {
        name: "global-review",
        description: "Review changes.",
        path: "/home/test/.agents/skills/global-review/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "project-deploy",
        description: "Deploy this project.",
        path: "/workspace/.agents/skills/project-deploy/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ],
    slashCommands: [{ name: "hello", description: "Say hello." }],
  });
});

it("prepends the builtin commands without duplicating discovered ones", () => {
  const [compact] = withPiBuiltinSlashCommands([]);
  expect(compact?.name).toBe("compact");
  expect(withPiBuiltinSlashCommands([{ name: "hello", description: "Say hello." }])).toEqual([
    compact,
    PI_BTW_SLASH_COMMAND,
    PI_HANDOFF_SLASH_COMMAND,
    { name: "hello", description: "Say hello." },
  ]);
  // User extensions' /btw and /handoff are replaced by T3's own versions.
  expect(
    withPiBuiltinSlashCommands([
      { name: "compact", description: "Extension compact." },
      { name: "btw", description: "Extension btw." },
      { name: "handoff", description: "Extension handoff." },
      { name: "hello" },
    ]),
  ).toEqual([compact, PI_BTW_SLASH_COMMAND, PI_HANDOFF_SLASH_COMMAND, { name: "hello" }]);
});
