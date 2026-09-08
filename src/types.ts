import type { Static } from "typebox";
import type {
  ConsultationReportSchema,
  EnrichmentPacketSchema,
  ImplementationReportSchema,
  WorkerReportInputSchema,
  WorkerReportSchema,
} from "./report-schema.js";

export type WorkerReport = Static<typeof WorkerReportSchema>;
export type WorkerReportInput = Static<typeof WorkerReportInputSchema>;
export type ImplementationReport = Static<typeof ImplementationReportSchema>;
export type ConsultationReport = Static<typeof ConsultationReportSchema>;
export type EnrichmentPacket = Static<typeof EnrichmentPacketSchema>;
export type WorkerMode = WorkerReport["kind"];
export type WorkerSessionMode = WorkerMode | "consultation_enricher";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkerObservationStatus = "idle" | "working" | "blocked" | "done" | "unknown";

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
