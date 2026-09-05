import type { Static } from "typebox";
import type {
  ImplementationReportSchema,
  WorkerReportSchema,
} from "./report-schema.js";

export type WorkerReport = Static<typeof WorkerReportSchema>;
export type ImplementationReport = Static<typeof ImplementationReportSchema>;
export type WorkerMode = WorkerReport["kind"];
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type WorkerObservationStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";

export interface CoordinatorRuntimeIdentity {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentName?: string;
  sessionFile: string;
  cwd: string;
}

export interface WorkerIdentity extends CoordinatorRuntimeIdentity {
  agentName: string;
}

export type WorkerResourceIdentity = Omit<WorkerIdentity, "sessionFile">;
