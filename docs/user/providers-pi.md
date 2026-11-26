# Pi

Run your existing [Pi](https://pi.dev) (**0.84.3+**, Node.js **22.19+**) installation in T3 Code while keeping Pi's models, auth, extensions, skills, and native session history.

## Set up Pi

1. Install Pi on the server machine (via Pi's installer or `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`).
2. Run `pi` and `/login` in a terminal on the server (over SSH for remote hosts, or set your model provider's API key in the Pi instance's environment variables).
3. Open **Settings → Providers**, enable **Pi**, and refresh. Set **Binary path** if `pi` isn't on `PATH`.

- In **Launch arguments**, `--provider` must be paired with `--model`. Flags that alter Pi's execution mode or session selection are rejected because T3 Code manages them.
- Update installer-managed Pi with `pi update`, or via your package manager (e.g. `nix profile upgrade pi`).

## Features and extensions

- **Models, thinking & speed**: Discovers Pi models, thinking levels, and `serviceTiers` (exposed as a speed picker).
- **Native sessions**: Resume, rollback, and same-instance forks use Pi's native session files; switching providers uses a [portable handoff](./portable-handoffs.md).
- **Skills & extensions**: Pi user and trusted project skills appear in `$`. Extension `select`, `confirm`, `input`, and `editor` dialogs render in the composer, notifications appear in the activity log, and status text appears near the composer.
- **Subagents**: T3 Code's `delegate_task` creates full child threads; Pi's example `subagent` extension also displays task progress/results (read-only).

## Permission modes

- **Supervised**: Asks before commands, file edits, and extension tools (reads proceed).
- **Auto-accept edits**: Allows Pi's edit/write tools; asks for commands and extension tools.
- **Full access**: Allows all tool calls without prompts.

**Auto** is not supported (behaves as Supervised). Changing modes restarts the Pi session and resumes the same conversation. Note that permissions govern Pi tool calls—not an OS sandbox.

## Side questions and handoff

- **Side questions**: `/side` or `/btw` opens a [side chat](./thread-sidebar.md#side-chats). A `/btw` command from a Pi extension is replaced by this one.
- **Handoff**: `/handoff` asks Pi to summarize the goal, progress, decisions, key files, and next steps, then opens a new thread in the same project and worktree with that summary as its first message. The original thread is unchanged. Add text after the command to steer the new thread (e.g. `/handoff now write the tests`). It uses the thread's model with tools off, so it can take up to a minute and uses your quota. A `/handoff` command from a Pi extension is replaced by this one; use `/compact` to shrink the current thread instead.

## Resume and rate limits

- **Resume**: After you stop a Pi turn, or it fails after Pi's own retries, click **Resume** in an empty composer to continue in the same session. T3 Code adds a hidden note asking Pi to continue from the last completed step; tool calls that already ran stay in context, but the unfinished reply does not.
- **Rate limits**: When Pi's retries give up on a rate limit, the usage-limit banner offers **Resume at reset**. For Claude and GPT models the reset time comes from your Claude Code or Codex usage limits when that window is full; a short burst limit has no published reset, so T3 Code waits 5 minutes.

## Troubleshooting

- **Untrusted project folder**: If Pi skips project extensions/skills/MCP, run `pi` in that folder on the server (with the same `PI_CODING_AGENT_DIR` if set), run `/trust`, and start a new thread in that worktree. Add `--no-approve` to launch arguments to keep project files disabled without the notice.
- **Discovery fails**: T3 Code keeps Pi usable with `Pi default` so an interactive session can handle startup prompts.
- **Context window**: Enable **Settings → Appearance → Thread details → Context window** (some model providers report usage only after the first reply completes).
