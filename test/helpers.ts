import type {
  Agreement,
  AssuranceFinding,
  AssuranceReviewReport,
  AssuranceSynthesisReport,
  DiscoveryReport,
  ImplementationReport,
  VerificationReport,
  WorkNodeSpec,
} from "../src/types.js";

export const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

export const testOutcome = {
  outcome: { kind: "product_change" as const, statement: "The requested behavior is present.", completionPredicate: "The requested behavior is verified." },
  milestones: ["understand", "design", "decompose", "implement", "verify"].map((id) => ({ id, description: `Complete ${id}.` })),
};

export const commandAgreement: Agreement = {
  outcome: "The requested behavior is present.", nonGoals: [], reuseDecision: "Reuse the existing fixture.", structure: "One bounded owner.", expectedScale: "Small.", verificationBoundary: "Observe the fixture output.", verificationCommands: ["true"], verificationMethod: "commands", verificationProcedure: "Run the composed-root command.", requiredEvidence: ["A successful composed-root command."], unresolvedDecisions: [], approvedAt: new Date(0).toISOString(),
};

export function nodeSpec(id: string, claimedPaths: string[], dependencies: string[] = []): WorkNodeSpec { return { id, brief: { goal: `Implement ${id}.`, context: ["Use the fixture."], acceptance: [`${id} is complete.`], timeboxMinutes: 20, forbidden: ["Do not change unrelated files."], report: "Return the commit and verification evidence." }, claimedPaths, dependencies, verificationCommands: [], supersedes: [], guideModel: "provider/guide", executorModel: "provider/executor", guideThinking: "high", executorThinking: "high" }; }
export function discoveryReport(summary = "Evidence found."): DiscoveryReport { return { kind: "discovery", status: "completed", summary, evidence: [], findings: [] }; }
export function implementationReport(summary = "Implemented.", commit?: string, changedFiles?: string[]): ImplementationReport { return { kind: "implementation", status: "completed", summary, evidence: [], findings: [], ...(commit ? { commit } : {}), ...(changedFiles ? { changedFiles } : {}) }; }
export function verificationReport(verdict: VerificationReport["verdict"] = "verified"): VerificationReport { return { kind: "verification", status: "completed", summary: verdict === "verified" ? "Product behavior verified." : "Product behavior was not verified.", evidence: [], findings: [], verdict }; }
export function assuranceFinding(id: string, envelopeImpact: AssuranceFinding["envelopeImpact"] = "none"): AssuranceFinding { return { id, category: "correctness", violatedInvariant: `Invariant ${id} is violated.`, evidence: ["Concrete repository evidence."], reachableScenario: "A supported request reaches the affected branch.", consequence: "The requested result is incorrect.", simplestResponse: "Correct the affected branch.", complexityEffect: "neutral", confidence: "high", envelopeImpact }; }
export function assuranceReview(responsibility: AssuranceReviewReport["responsibility"], findings: AssuranceFinding[] = []): AssuranceReviewReport { return { kind: "assurance_review", status: "completed", summary: findings.length > 0 ? "Found a material candidate." : "No material findings.", evidence: [], responsibility, recommendation: findings.length > 0 ? "changes_required" : "approve", findings }; }
export function assuranceSynthesis(findings: AssuranceFinding[], disposition: "accept" | "dismiss" = "accept"): AssuranceSynthesisReport { const accepted = disposition === "accept" && findings.length > 0; return { kind: "assurance_synthesis", status: "completed", summary: findings.length > 0 ? "Candidates reconciled." : "No candidates to reconcile.", evidence: [], verdict: accepted ? findings.some((finding) => finding.envelopeImpact !== "none") ? "needs_decision" : "revision_required" : "approve", dispositions: findings.map((finding) => ({ finding, disposition, reason: disposition === "accept" ? "The evidence is material." : "The evidence is not material." })) }; }
