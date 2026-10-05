import { createFileRoute } from "@tanstack/react-router";

import { ScheduledTasksPage } from "../components/scheduledTasks/ScheduledTasksPage";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";

function ScheduledTasksRoute() {
  const target = Route.useSearch();
  return <ScheduledTasksPage {...target} />;
}

export const Route = createFileRoute("/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: ScheduledTasksRoute,
});
