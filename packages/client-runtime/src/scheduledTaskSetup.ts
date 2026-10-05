/**
 * First message of a "set up with agent" thread, shared by web and mobile.
 * It steers the agent to a fresh-thread-per-run task, so each run starts
 * with a clean context instead of accumulating every previous run in one
 * provider session.
 */
export function scheduledTaskSetupMessage(request: string): string {
  return [
    "Set up a recurring scheduled task in T3 Code for the request below.",
    "",
    "- Ask me first if the cadence, time, or what to report is unclear.",
    "- Before scheduling, try the checks the task depends on (commands, URLs, CLIs, credentials) so the first scheduled run will not fail.",
    "- Write the task prompt so it stands alone: each run starts in a fresh thread with no memory of this conversation or of earlier runs. If it must compare against a previous run, have it keep state in a file, or read the previous run's thread with t3_thread_read.",
    '- Call schedule_task with bindToCurrentThread=false. Pass workspace="worktree" only if runs will edit files.',
    "- Then tell me the cadence and next run time.",
    "",
    "<request>",
    request.trim(),
    "</request>",
  ].join("\n");
}
