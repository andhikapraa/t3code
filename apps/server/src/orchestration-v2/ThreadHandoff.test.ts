import { expect, it } from "@effect/vitest";

import { handoffWorkspaceStrategy } from "./ThreadHandoff.ts";

it("hands off into the source thread's worktree and branch", () => {
  expect(
    handoffWorkspaceStrategy({ worktreePath: "/repo/.t3/worktrees/feature", branch: "feature" }),
  ).toEqual({
    type: "existing_worktree",
    worktreePath: "/repo/.t3/worktrees/feature",
    branch: "feature",
  });
});

it("hands off at the project root when the source has no worktree", () => {
  expect(handoffWorkspaceStrategy({ worktreePath: null, branch: "main" })).toEqual({
    type: "root",
    branch: "main",
  });
  expect(handoffWorkspaceStrategy({ worktreePath: null, branch: null })).toEqual({ type: "root" });
});
