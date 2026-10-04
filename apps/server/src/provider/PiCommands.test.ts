import { expect, it } from "@effect/vitest";

import {
  expandPiSkillReference,
  parsePiCompactCommand,
  parsePiDiscoveredCommands,
  PI_BTW_SLASH_COMMAND,
  PI_COMPACT_SLASH_COMMAND,
  withPiBuiltinSlashCommands,
} from "./PiCommands.ts";

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

it("maps Pi global location and interface labels onto T3 skill fields", () => {
  expect(
    parsePiDiscoveredCommands({
      commands: [
        {
          name: "skill:global-review",
          description: "Review changes.",
          source: "skill",
          location: "global",
          interface: {
            displayName: "Global Review",
            shortDescription: "Review diffs.",
          },
        },
      ],
    }),
  ).toEqual({
    skills: [
      {
        name: "global-review",
        description: "Review changes.",
        path: "pi:skill:global-review",
        scope: "user",
        enabled: true,
        displayName: "Global Review",
        shortDescription: "Review diffs.",
      },
    ],
    slashCommands: [],
  });
});

it("parses a standalone /compact command and optional instructions", () => {
  expect(parsePiCompactCommand("/compact")).toEqual({});
  expect(parsePiCompactCommand("  /compact  ")).toEqual({});
  expect(parsePiCompactCommand("/compact keep the auth rewrite")).toEqual({
    customInstructions: "keep the auth rewrite",
  });
  expect(parsePiCompactCommand("/compacted")).toBeNull();
  expect(parsePiCompactCommand("/compact-now")).toBeNull();
  expect(parsePiCompactCommand("please /compact")).toBeNull();
});

it("prepends the builtin commands without duplicating discovered ones", () => {
  expect(withPiBuiltinSlashCommands([{ name: "hello", description: "Say hello." }])).toEqual([
    PI_COMPACT_SLASH_COMMAND,
    PI_BTW_SLASH_COMMAND,
    { name: "hello", description: "Say hello." },
  ]);
  // A user's TUI-only /btw extension is replaced by T3's side question.
  expect(
    withPiBuiltinSlashCommands([
      { name: "compact", description: "Extension compact." },
      { name: "btw", description: "Extension btw." },
      { name: "hello" },
    ]),
  ).toEqual([PI_COMPACT_SLASH_COMMAND, PI_BTW_SLASH_COMMAND, { name: "hello" }]);
});

const skills = (...names: string[]) =>
  new Map(names.map((name) => [name, `/skills/${name}/SKILL.md`]));

it("leaves unrelated dollar-prefixed text unchanged", () => {
  expect(expandPiSkillReference("Explain $HOME", skills("global-review"))).toBe("Explain $HOME");
  expect(expandPiSkillReference("pay $5.", skills("review"))).toBe("pay $5.");
  expect(expandPiSkillReference("see a$review", skills("review"))).toBe("see a$review");
});

it("prefixes a $ skill natively and keeps the prompt verbatim", () => {
  expect(expandPiSkillReference("can we use $dokploy to do it?", skills("dokploy"))).toBe(
    "/skill:dokploy can we use $dokploy to do it?",
  );
  expect(expandPiSkillReference("$review", skills("review"))).toBe("/skill:review $review");
});

it.each(["use $dokploy, then", "run $dokploy.", "($dokploy) please", 'say "$dokploy"?'])(
  "recognizes a $ skill wrapped in punctuation: %s",
  (text) => {
    expect(expandPiSkillReference(text, skills("dokploy"))).toBe(`/skill:dokploy ${text}`);
  },
);

it("keeps namespaced names intact and drops a trailing colon", () => {
  expect(expandPiSkillReference("try $ns:tool.", skills("ns:tool"))).toBe(
    "/skill:ns:tool try $ns:tool.",
  );
  expect(expandPiSkillReference("$review: the diff", skills("review"))).toBe(
    "/skill:review $review: the diff",
  );
});

it("points the model at the files of additional skills", () => {
  expect(expandPiSkillReference("use $alpha then $beta and $alpha", skills("alpha", "beta"))).toBe(
    "/skill:alpha use $alpha then $beta and $alpha\n\n" +
      "Also load these skills by reading their files:\n- beta: /skills/beta/SKILL.md",
  );
});

it("preserves code indentation and line breaks when expanding a skill", () => {
  expect(expandPiSkillReference("$review\n```ts\n  const x = 1;\n```", skills("review"))).toBe(
    "/skill:review $review\n```ts\n  const x = 1;\n```",
  );
});
