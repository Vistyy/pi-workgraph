import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Observe the capability scenario at Pi's actual message boundary, not queued delivery state. */
export function notificationDrivenProgress(
  entries: SessionEntry[],
  resultIds: string[],
  baselineResultId: string,
): boolean {
  const notificationIndex = (resultId: string) =>
    entries.findIndex(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-workgraph-workstream" &&
        entry.details !== null &&
        typeof entry.details === "object" &&
        "resultId" in entry.details &&
        entry.details.resultId === resultId,
    );
  const experimentIndex = entries.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some(
        (block) =>
          block.type === "toolCall" &&
          block.name === "workgraph_research" &&
          block.arguments.id === "uppercase-experiment",
      ),
  );
  const baselineIndex = notificationIndex(baselineResultId);
  // A later drained notification cannot repair a transition made by polling.
  if (
    experimentIndex >= 0 &&
    (baselineIndex < 0 || experimentIndex < baselineIndex)
  )
    throw new Error(
      "Experiment was queued before the actual baseline result notification; notification-driven progression was not observed.",
    );
  return (
    experimentIndex >= 0 &&
    resultIds.every((resultId) => {
      const index = notificationIndex(resultId);
      return (
        index >= 0 &&
        entries
          .slice(index + 1)
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              !["error", "aborted", "pending"].includes(
                entry.message.stopReason,
              ),
          )
      );
    })
  );
}
