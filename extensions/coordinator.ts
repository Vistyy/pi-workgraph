import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { GitRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import {
  loadModelPolicy,
  MODEL_ROLES,
  modelPolicyPath,
  SelectionRequestSchema as Selection,
  setModelPool,
  setModelRole,
  ModelTargetSchema as Target,
  ThinkingSchema as Thinking,
} from "../src/model-policy.js";
import { forkConversationSession } from "../src/pi-process.js";
import { EvidenceSchema } from "../src/report-schema.js";
import {
  type ResultDisposition,
  type SessionIdentity,
  type WorkAttempt,
  type WorkstreamState,
  WorkstreamStore,
} from "../src/workstream.js";
import {
  type QueueOptions,
  WorkstreamRuntime,
} from "../src/workstream-runtime.js";

const POINTER = "pi-workgraph-workstream";
const INPUT = "pi-workgraph-human-input";

function compactText(value: string, max = 240): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const InputReceipt = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  sessionFile: Type.String(),
  source: StringEnum(["interactive", "rpc"] as const),
  text: Type.String(),
});
const ModelOptions = {
  selection: Type.Optional(Selection),
  model: Type.Optional(Type.String()),
  modelReason: Type.Optional(Type.String()),
  thinking: Type.Optional(Thinking),
  continuationOf: Type.Optional(Type.String()),
  baseRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
};

export default function workgraphCoordinator(pi: ExtensionAPI): void {
  if (process.env.PI_WORKGRAPH_MODE) return;
  let runtime: WorkstreamRuntime | undefined;
  let pending: Static<typeof InputReceipt>[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => undefined);
    return next;
  };
  const owner = (ctx: ExtensionContext): SessionIdentity => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile)
      throw new Error("Workgraph requires a persistent Pi session.");
    return { sessionId: ctx.sessionManager.getSessionId(), sessionFile };
  };
  const current = (): WorkstreamRuntime => {
    if (!runtime)
      throw new Error(
        "No attached workstream. Delegate work or attach a retained workstream first.",
      );
    return runtime;
  };
  const remember = (
    state: WorkstreamState,
    ctx: ExtensionContext,
  ): WorkstreamState => {
    ctx.ui.setStatus(
      "workgraph",
      `WG ${state.lifecycle.state} - ${state.attempts.filter((item) => ["running", "starting"].includes(item.state)).length} active`,
    );
    return state;
  };
  const attach = async (
    ctx: ExtensionContext,
    target: WorkstreamStore,
    priorOwnerLiveness: "alive" | "dead" | "unknown" = "unknown",
  ) => {
    if (runtime?.store.path === target.path) {
      await runtime.perform(async () => undefined);
      return runtime;
    }
    const previous = runtime;
    const state = await target.load();
    const next = new WorkstreamRuntime(
      target,
      new GitRepository(state.projectRoot, state.gitCommonDir),
      new HerdrCliRuntime(),
      {
        workspaceId: process.env.HERDR_WORKSPACE_ID ?? "",
      },
      (resultId, latest) => {
        if (ctx.sessionManager.getSessionId() !== latest.coordinator.sessionId)
          throw new Error(
            "Coordinator session changed before result delivery.",
          );
        pi.sendMessage(
          {
            customType: POINTER,
            content: resultNotification(latest, resultId),
            display: true,
            details: {
              resultId,
              statePath: latest.statePath,
              view: coordinatorView(latest),
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
      (error) => {
        ctx.ui.notify(`Workgraph: ${error.message}`, "warning");
        pi.sendMessage(
          {
            customType: "pi-workgraph-attention",
            content: `Workgraph requires reconciliation: ${error.message}. Inspect retained status; this notification does not authorize new scope.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
      { owner: owner(ctx), priorOwnerLiveness },
    );
    try {
      await next.perform(async () => undefined);
      await previous?.stop();
    } catch (error) {
      await next.stop();
      throw error;
    }
    runtime = next;
    next.start();
    return next;
  };
  const importInputs = async (active: WorkstreamRuntime): Promise<void> => {
    await active.perform(async () => {
      for (const receipt of pending)
        await active.store.recordInputEvent(receipt);
    });
  };
  const ensure = async (
    ctx: ExtensionContext,
    purpose: string,
  ): Promise<WorkstreamRuntime> => {
    if (runtime) {
      const state = await runtime.store.load();
      if (state.lifecycle.state === "suspended")
        throw new Error(
          "Workstream is suspended; resume explicitly before delegating.",
        );
      if (state.lifecycle.state === "active") return runtime;
      await runtime.stop();
      runtime = undefined;
    }
    const repository = await GitRepository.inspect(ctx.cwd);
    const created = await WorkstreamStore.create({
      id: `ws-${randomUUID()}`,
      purpose,
      projectRoot: repository.root,
      gitCommonDir: repository.commonDir,
      coordinator: owner(ctx),
    });
    const active = await attach(ctx, created.store);
    await importInputs(active);
    pi.appendEntry(POINTER, { path: created.store.path });
    return active;
  };
  const authorize = async (
    active: WorkstreamRuntime,
    statement: string,
    receiptId?: string,
  ): Promise<{ receiptId: string; intentVersion: number }> =>
    active.perform(async () => {
      let state = await active.store.load();
      let intent = state.intents.at(-1);
      if (!intent) throw new Error("Missing workstream intent.");
      if (
        intent.version === 0 ||
        (receiptId && !intent.authorityReceiptIds.includes(receiptId))
      ) {
        const receipt = receiptId ?? state.inputs.at(-1)?.id;
        if (!receipt)
          throw new Error(
            "Mutation requires an actual retained human input receipt.",
          );
        state = await active.store.reviseIntent({
          authorityReceiptId: receipt,
          statement,
          constraints: intent.constraints,
        });
        intent = state.intents.at(-1);
      }
      const authorityReceipt = receiptId ?? intent?.authorityReceiptIds[0];
      if (!intent || !authorityReceipt)
        throw new Error("No applicable human-backed intent.");
      return { receiptId: authorityReceipt, intentVersion: intent.version };
    });

  pi.on("input", async (event, ctx) => {
    if (
      (event.source !== "interactive" && event.source !== "rpc") ||
      !event.text.trim()
    )
      return;
    const receipt = {
      id: randomUUID(),
      ...owner(ctx),
      source: event.source,
      text: event.text,
    };
    // This receipt exists even when delegation has not created a workstream yet.
    pi.appendEntry(INPUT, receipt);
    await serial(async () => {
      pending.push(receipt);
      if (!runtime) return;
      const state = await runtime.store.load();
      if (
        state.lifecycle.state === "active" ||
        state.lifecycle.state === "suspended"
      ) {
        await runtime.perform(async () => {
          await runtime?.store.recordInputEvent(receipt);
        });
      }
    });
  });
  pi.on("session_start", async (_event, ctx) => {
    await serial(async () => {
      if (runtime) await runtime.stop();
      runtime = undefined;
      const identity = owner(ctx);
      const entries = ctx.sessionManager.getBranch();
      pending = entries.flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === INPUT &&
        Value.Check(InputReceipt, entry.data) &&
        entry.data.sessionId === identity.sessionId &&
        entry.data.sessionFile === identity.sessionFile
          ? [entry.data]
          : [],
      );
      const pointer = [...entries]
        .reverse()
        .find(
          (entry) => entry.type === "custom" && entry.customType === POINTER,
        );
      const data = pointer?.type === "custom" ? pointer.data : undefined;
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        !("path" in data) ||
        typeof data.path !== "string" ||
        !data.path.trim()
      ) {
        if (pointer)
          ctx.ui.notify(
            "Workstream reattachment skipped: the retained pointer is malformed; inspect its session entry and repair it explicitly.",
            "warning",
          );
        return;
      }
      try {
        const inspection = await WorkstreamStore.inspectForReattachment(
          data.path,
        );
        if (inspection.kind === "retained_terminal") {
          ctx.ui.notify(
            `Workstream reattachment skipped: ${inspection.lifecycle.state} older history ${inspection.id} was preserved and not attached.`,
            "info",
          );
          return;
        }
        if (
          inspection.state.lifecycle.state === "completed" ||
          inspection.state.lifecycle.state === "archived" ||
          inspection.state.lifecycle.state === "abandoned"
        )
          return;
        await attach(ctx, WorkstreamStore.open(data.path, identity));
        await importInputs(current());
        remember(await current().store.load(), ctx);
      } catch (error) {
        ctx.ui.notify(
          `Workstream reattachment skipped for ${data.path}: ${error instanceof Error ? error.message : String(error)}. Inspect the retained pointer and state, then reconcile explicitly.`,
          "warning",
        );
      }
    });
  });
  pi.on("session_shutdown", async () => {
    await tail;
    await runtime?.stop();
  });
  pi.on("before_agent_start", async () => ({
    message: {
      customType: "pi-workgraph-policy",
      content:
        "[WORKGRAPH]\nUse research, implementation and selective review as needed, not a pipeline. The coordinator interprets human authority and judges evidence. Mutation tools reference genuine retained human inputs; worker reports and extension notifications do not grant authority. After queuing work, do immediately useful independent work if any; otherwise end the turn so retained-result notifications can resume coordination. Do not poll status or run waits for workers. Inspect status when handling a result or reconciling attention. Finish the requested work through verification and correction within scope.",
      display: false,
    },
  }));

  pi.registerTool({
    name: "workgraph_models",
    label: "Workgraph Models",
    description:
      "Get model defaults and their configuration path, or set one role when the user requests a persistent policy change. Assignment model/thinking/executor parameters override defaults without changing policy or the coordinator model.",
    promptSnippet: "Inspect or configure Workgraph model defaults",
    parameters: Type.Object({
      action: StringEnum(["get", "set", "set_pool", "rates"] as const),
      role: Type.Optional(StringEnum(MODEL_ROLES)),
      target: Type.Optional(Target),
      pool: Type.Optional(Type.Array(Target, { minItems: 1 })),
      models: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () => {
        if (params.action === "set" && (!params.role || !params.target))
          throw new Error("Setting a model default requires role and target.");
        if (params.action === "set_pool" && !params.pool)
          throw new Error("Setting the worker pool requires an ordered pool.");
        if (params.action === "rates") {
          const policy = await loadModelPolicy();
          const models =
            params.models ?? policy.workerPool.map((target) => target.model);
          const rates = models.map((modelId) => {
            const slash = modelId.indexOf("/");
            const model =
              slash > 0
                ? ctx.modelRegistry.find(
                    modelId.slice(0, slash),
                    modelId.slice(slash + 1),
                  )
                : undefined;
            return model
              ? {
                  model: modelId,
                  source: "Pi registry configured estimate",
                  verified: false,
                  ratesPerMillionTokens: { ...model.cost },
                }
              : {
                  model: modelId,
                  source: "Pi registry configured estimate unavailable",
                  verified: false,
                };
          });
          return {
            content: [
              { type: "text", text: JSON.stringify({ rates }, null, 2) },
            ],
            details: { rates },
          };
        }
        const policy =
          params.action === "set" && params.role && params.target
            ? await setModelRole(params.role, params.target)
            : params.action === "set_pool" && params.pool
              ? await setModelPool(params.pool)
              : await loadModelPolicy();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { path: modelPolicyPath(), policy },
                null,
                2,
              ),
            },
          ],
          details: { path: modelPolicyPath(), policy, rates: [] },
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_begin",
    label: "Workgraph Begin",
    description:
      "Optionally record a purpose before delegation. First delegation also creates a workstream.",
    parameters: Type.Object({ purpose: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () =>
        result(
          "Workstream ready.",
          remember(await (await ensure(ctx, params.purpose)).store.load(), ctx),
        ),
      );
    },
  });
  pi.registerTool({
    name: "workgraph_research",
    label: "Workgraph Research",
    description:
      "Delegate bounded research or an explicitly authorized disposable experiment.",
    promptSnippet: "Delegate research or a bounded experiment",
    parameters: Type.Object({
      id: Type.String(),
      question: Type.String(),
      expectedEvidence: Type.Array(Type.String(), { minItems: 1 }),
      ...ModelOptions,
      experiment: Type.Optional(
        Type.Object({
          authorityReceiptId: Type.Optional(Type.String()),
          permittedEffects: Type.Array(Type.String(), { minItems: 1 }),
          stopCondition: Type.String(),
          retain: Type.Array(Type.String()),
        }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () => {
        const active = await ensure(ctx, params.question);
        const authority = params.experiment
          ? await authorize(
              active,
              params.question,
              params.experiment.authorityReceiptId,
            )
          : undefined;
        const intent = (await active.store.load()).intents.at(-1);
        if (!intent) throw new Error("Missing intent.");
        const common = {
          id: params.id,
          capability: "research" as const,
          objective: params.question,
          intentVersion: intent.version,
          expectedEvidence: params.expectedEvidence,
        };
        const assignment =
          params.experiment && authority
            ? {
                ...common,
                artifactIntent: "disposable_experiment" as const,
                authority,
                permittedEffects: params.experiment.permittedEffects,
                stopCondition: params.experiment.stopCondition,
                artifactPolicy: {
                  retain: params.experiment.retain,
                  discardOthers: true as const,
                },
              }
            : { ...common, artifactIntent: "evidence_only" as const };
        const state = await active.queue(assignment, queueOptions(params));
        return result(
          `Queued ${params.id}; submission and execution are observed asynchronously.`,
          remember(state, ctx),
        );
      });
    },
  });
  pi.registerTool({
    name: "workgraph_intent",
    label: "Workgraph Intent",
    description:
      "Record changed human-authorized scope. Earlier results remain tied to their old intent.",
    parameters: Type.Object({
      authorityReceiptId: Type.String(),
      statement: Type.String(),
      constraints: Type.Array(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () =>
        result(
          "Recorded intent revision.",
          remember(
            await current().perform(() => current().store.reviseIntent(params)),
            ctx,
          ),
        ),
      );
    },
  });
  pi.registerTool({
    name: "workgraph_implement",
    label: "Workgraph Implement",
    description:
      "Delegate a maintained change covered by genuine human intent. Defaults to the current human-backed scope or latest human request, not an extra approval ceremony.",
    promptSnippet: "Delegate an authorized maintained change",
    parameters: Type.Object({
      id: Type.String(),
      objective: Type.String(),
      authorityReceiptId: Type.Optional(Type.String()),
      acceptance: Type.Array(Type.String(), { minItems: 1 }),
      ...ModelOptions,
      executor: Type.Optional(Target),
      modelReason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () => {
        const active = await ensure(ctx, params.objective);
        const authority = await authorize(
          active,
          params.objective,
          params.authorityReceiptId,
        );
        const state = await active.queue(
          {
            id: params.id,
            capability: "implement",
            artifactIntent: "maintained_change",
            objective: params.objective,
            intentVersion: authority.intentVersion,
            authority,
            acceptance: params.acceptance,
          },
          {
            ...queueOptions(params),
            ...(params.executor ? { executor: params.executor } : {}),
          },
        );
        return result(
          `Queued maintained change ${params.id}.`,
          remember(state, ctx),
        );
      });
    },
  });
  pi.registerTool({
    name: "workgraph_review",
    label: "Workgraph Review",
    description:
      "Delegate an independent review of a retained proposal, artifact or exact revision for a specified concern.",
    promptSnippet: "Delegate selective review",
    parameters: Type.Object({
      id: Type.String(),
      objective: Type.String(),
      concern: Type.String(),
      subject: Type.Union([
        Type.Object({ kind: Type.Literal("result"), resultId: Type.String() }),
        Type.Object({
          kind: Type.Literal("artifact"),
          resultId: Type.String(),
          artifactId: Type.String(),
        }),
        Type.Object({
          kind: Type.Literal("revision"),
          revision: Type.String(),
        }),
        Type.Object({
          kind: Type.Literal("comparison"),
          resultIds: Type.Array(Type.String(), { minItems: 2 }),
        }),
      ]),
      ...ModelOptions,
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () => {
        const active = await ensure(ctx, params.objective);
        const intent = (await active.store.load()).intents.at(-1);
        if (!intent) throw new Error("Missing intent.");
        return result(
          `Queued review ${params.id}.`,
          remember(
            await active.queue(
              {
                id: params.id,
                capability: "review",
                artifactIntent: "evidence_only",
                objective: params.objective,
                intentVersion: intent.version,
                subject: params.subject,
                concern: params.concern,
              },
              queueOptions(params),
            ),
            ctx,
          ),
        );
      });
    },
  });
  pi.registerTool({
    name: "workgraph_result",
    label: "Workgraph Result",
    description:
      "Retrieve one retained result without dumping the whole workstream. Use all, summary, evidence, findings, or attention as the focused view.",
    parameters: Type.Object({
      resultId: Type.String(),
      section: Type.Optional(
        StringEnum([
          "all",
          "summary",
          "evidence",
          "findings",
          "attention",
        ] as const),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params) {
      return serial(async () => {
        const state = await current().store.load();
        if (!state.results.some((item) => item.id === params.resultId))
          throw new Error(`Unknown result ${params.resultId}.`);
        await current().perform(() =>
          current().store.requestDelivery(params.resultId),
        );
        await current().perform(() =>
          current().store.markDelivered(params.resultId),
        );
        const latest = await current().store.load();
        const selected = focusedResult(
          latest,
          params.resultId,
          params.section ?? "all",
          params.offset ?? 0,
          params.limit ?? 20,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(selected, null, 2) },
          ],
          details: { result: selected, statePath: latest.statePath },
        };
      });
    },
  });
  pi.registerTool({
    name: "workgraph_status",
    label: "Workgraph Status",
    description:
      "Inspect compact progress, selected models and reasons, result handles, actionable attention and resource recovery.",
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params) {
      return serial(async () => {
        const state = await current().store.load();
        return result(
          `Workstream ${state.id}: ${state.lifecycle.state}`,
          state,
          compactStatus(state, params.offset ?? 0, params.limit ?? 20),
        );
      });
    },
  });
  pi.registerTool({
    name: "workgraph_acknowledge",
    label: "Workgraph Acknowledge",
    description:
      "Acknowledge evidence actually read, including through status after a failed notification. This records receipt, not acceptance or transport success.",
    parameters: Type.Object({
      resultId: Type.String(),
      acknowledgment: Type.String(),
    }),
    async execute(_id, params) {
      return serial(async () =>
        result(
          "Acknowledged result.",
          await current().perform(() =>
            current().store.acknowledge(params.resultId, params.acknowledgment),
          ),
        ),
      );
    },
  });
  pi.registerTool({
    name: "workgraph_disposition",
    label: "Workgraph Disposition",
    description:
      "Record coordinator judgment of retained evidence, not worker or transport success.",
    parameters: Type.Object({
      resultId: Type.String(),
      status: StringEnum(["accepted", "rejected", "needs_followup"] as const),
      reason: Type.String(),
    }),
    async execute(_id, params) {
      return serial(async () =>
        result(
          "Recorded disposition.",
          await current().perform(() =>
            current().store.disposition({
              ...params,
              status: params.status as ResultDisposition["status"],
            }),
          ),
        ),
      );
    },
  });
  pi.registerTool({
    name: "workgraph_control",
    label: "Workgraph Control",
    description:
      "Suspend or resume work, cancel or steer a live attempt, retry an inspected blocked boundary, or explicitly retain a conflicting commit as not applied.",
    parameters: Type.Object({
      action: StringEnum([
        "suspend",
        "resume",
        "cancel",
        "steer",
        "recover",
        "retain_not_applied",
      ] as const),
      reason: Type.String(),
      attemptId: Type.Optional(Type.String()),
      integratedRevision: Type.Optional(
        Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () => {
        const active = current();
        if (
          params.action === "cancel" ||
          params.action === "steer" ||
          params.action === "recover" ||
          params.action === "retain_not_applied"
        ) {
          if (!params.attemptId) throw new Error("An attempt id is required.");
          if (params.action === "cancel") await active.cancel(params.attemptId);
          else if (params.action === "steer")
            await active.steer(params.attemptId, params.reason);
          else
            await active.recoverAttempt({
              attemptId: params.attemptId,
              action:
                params.action === "recover" ? "retry" : "retain_not_applied",
              reason: params.reason,
              ...(params.integratedRevision
                ? { integratedRevision: params.integratedRevision }
                : {}),
            });
        } else
          await active.perform(() =>
            active.store.setLifecycle({
              state: params.action === "suspend" ? "suspended" : "active",
              reason: params.reason,
            }),
          );
        return result(
          params.action === "steer"
            ? "Steering submitted; application is not yet established."
            : params.action === "recover" ||
                params.action === "retain_not_applied"
              ? "Recovery inspected the exact boundary and recorded its outcome."
              : "Control request recorded.",
          remember(await active.store.load(), ctx),
        );
      });
    },
  });
  pi.registerTool({
    name: "workgraph_adopt",
    label: "Workgraph Adopt",
    description:
      "Attach a retained workstream only after expired prior ownership is authoritatively dead. Preserve suspension and original human receipts.",
    parameters: Type.Object({ statePath: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () => {
        const state = await WorkstreamStore.inspect(params.statePath);
        const repository = await GitRepository.inspect(ctx.cwd);
        if (repository.commonDir !== state.gitCommonDir)
          throw new Error(
            "The retained workstream belongs to another repository.",
          );
        const liveness = await new HerdrCliRuntime().coordinatorLiveness(
          state.coordinator.sessionFile,
        );
        const target = WorkstreamStore.open(
          params.statePath,
          state.coordinator,
        );
        const active = await attach(ctx, target, liveness);
        pi.appendEntry(POINTER, { path: target.path });
        await importInputs(active);
        return result(
          "Adopted without changing lifecycle.",
          remember(await active.store.load(), ctx),
        );
      });
    },
  });
  pi.registerTool({
    name: "workgraph_fork",
    label: "Workgraph Fork",
    description:
      "Explicitly fork the coordinator conversation into a new no-focus Herdr workspace; workers remain tabs in that coordinator workspace, not a worker continuation or workstream adoption.",
    parameters: Type.Object({ targetCwd: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () => {
        const sessionFile = await forkConversationSession({
          parentSessionFile: owner(ctx).sessionFile,
          targetCwd: params.targetCwd,
        });
        const identity = await new HerdrCliRuntime().launchCoordinator({
          cwd: params.targetCwd,
          sessionFile,
        });
        return {
          content: [
            {
              type: "text",
              text: `Forked coordinator: workspace ${identity.workspaceId}, tab ${identity.tabId}, pane ${identity.paneId}, cwd ${identity.cwd}, native session ${identity.sessionFile}.`,
            },
          ],
          details: identity,
        };
      });
    },
  });
  pi.registerTool({
    name: "workgraph_complete",
    label: "Workgraph Complete",
    description:
      "Complete after owned workers/resources settle, with evidence and explicit limitations.",
    parameters: Type.Object({
      conclusion: Type.String(),
      evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
      limitations: Type.Array(Type.String()),
      accounting: Type.Array(
        Type.Union([
          Type.Object({
            kind: Type.Literal("unresolved_assignment"),
            assignmentId: Type.String(),
            reason: Type.String({ minLength: 1 }),
          }),
          Type.Object({
            kind: Type.Literal("unresolved_attempt"),
            attemptId: Type.String(),
            reason: Type.String({ minLength: 1 }),
          }),
          Type.Object({
            kind: Type.Literal("unresolved_result"),
            resultId: Type.String(),
            reason: Type.String({ minLength: 1 }),
          }),
          Type.Object({
            kind: Type.Literal("undelivered_result"),
            resultId: Type.String(),
            reason: Type.String({ minLength: 1 }),
          }),
        ]),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return serial(async () => {
        const active = current();
        const state = await active.perform(() => active.store.complete(params));
        await active.stop();
        runtime = undefined;
        return result("Completed workstream.", remember(state, ctx));
      });
    },
  });
}

function coordinatorView(state: WorkstreamState) {
  return compactStatus(state);
}

function compactStatus(state: WorkstreamState, offset = 0, limit = 20) {
  const page = <T>(items: T[]) => ({
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    remaining: Math.max(0, items.length - offset - limit),
    ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}),
  });
  const effectiveModelView = (
    entries: NonNullable<WorkAttempt["effectiveModels"]> = [],
  ) => {
    const distinct = new Map<
      string,
      { model: string; thinking?: string; sources: Set<string> }
    >();
    const transitions: Array<{
      model: string;
      thinking?: string;
      source?: string;
    }> = [];
    let previous: string | undefined;
    for (const entry of entries) {
      const key = `${entry.model}|${entry.thinking ?? ""}`;
      if (!distinct.has(key))
        distinct.set(key, {
          model: entry.model,
          ...(entry.thinking ? { thinking: entry.thinking } : {}),
          sources: new Set(),
        });
      distinct.get(key)?.sources.add(entry.source ?? "unknown");
      if (key !== previous) {
        transitions.push({
          model: entry.model,
          ...(entry.thinking ? { thinking: entry.thinking } : {}),
          ...(entry.source ? { source: entry.source } : {}),
        });
        previous = key;
      }
    }
    return {
      observations: entries.length,
      distinctCount: distinct.size,
      omittedDistinct: Math.max(0, distinct.size - 8),
      distinct: [...distinct.values()]
        .slice(0, 8)
        .map(({ sources, ...entry }) => ({
          ...entry,
          sources: [...sources],
        })),
      transitions: transitions.slice(0, 8),
      truncatedTransitions: Math.max(0, transitions.length - 8),
    };
  };
  const selectionView = (models: WorkAttempt["models"]) =>
    models
      ? {
          guide: models.guide,
          ...(models.executor ? { executor: models.executor } : {}),
          source: models.source,
          ...(models.overrideReason
            ? { overrideReason: compactText(models.overrideReason) }
            : {}),
          ...(models.selection
            ? {
                selection: {
                  requested: models.selection.requested,
                  diversity: models.selection.diversity,
                  selected: models.selection.selected.slice(0, 8),
                  selectedCount: models.selection.selected.length,
                  ...(models.selection.selected.length > 8
                    ? { omittedSelected: models.selection.selected.length - 8 }
                    : {}),
                  unfulfilled: models.selection.unfulfilled.slice(0, 8),
                  unfulfilledCount: models.selection.unfulfilled.length,
                  ...(models.selection.unfulfilled.length > 8
                    ? {
                        omittedUnfulfilled:
                          models.selection.unfulfilled.length - 8,
                      }
                    : {}),
                  source: models.selection.source,
                  reason: compactText(models.selection.reason),
                },
              }
            : {}),
        }
      : undefined;
  const attemptView = (attempt: WorkAttempt) => {
    const result = state.results.find((item) => item.id === attempt.resultId);
    const report = result?.validity === "typed" ? result.report : undefined;
    return {
      id: attempt.id,
      state: attempt.state,
      submission: attempt.submission,
      placement: attempt.placement?.kind,
      resultId: attempt.resultId,
      outcome:
        report?.kind === "implementation" && report.status === "completed"
          ? report.outcome
          : report?.status,
      models: selectionView(attempt.models),
      effectiveModels: effectiveModelView(attempt.effectiveModels),
      composition: attempt.composition?.state,
      compositionReason: attempt.composition?.reason,
      retainedRef: attempt.composition?.retainedRef,
      cleanup: attempt.cleanup?.state,
      attention: attempt.error ? compactText(attempt.error, 320) : undefined,
    };
  };
  const attention = state.attempts.flatMap((attempt) =>
    attempt.error
      ? [{ attemptId: attempt.id, detail: compactText(attempt.error, 320) }]
      : attempt.composition?.state === "blocked" ||
          attempt.cleanup?.state === "blocked"
        ? [
            {
              attemptId: attempt.id,
              detail: compactText(
                attempt.composition?.error ??
                  attempt.cleanup?.error ??
                  "Blocked attempt requires recovery.",
                320,
              ),
            },
          ]
        : [],
  );
  const accounting = state.completion?.accounting ?? [];
  return {
    id: state.id,
    purpose: compactText(state.purpose),
    lifecycle: {
      ...state.lifecycle,
      reason: compactText(state.lifecycle.reason),
    },
    counts: {
      assignments: state.assignments.length,
      attempts: state.attempts.length,
      results: state.results.length,
      deliveries: state.deliveries.length,
      attention: attention.length,
      accounting: accounting.length,
    },
    assignments: page(
      state.assignments.map((assignment) => {
        const attempts = state.attempts.filter(
          (attempt) => attempt.assignmentId === assignment.id,
        );
        return {
          id: assignment.id,
          capability: assignment.capability,
          objective: compactText(assignment.objective),
          attempts: {
            count: attempts.length,
            active: attempts.filter((attempt) =>
              ["starting", "running", "cancel_requested"].includes(
                attempt.state,
              ),
            ).length,
            items: attempts.slice(-3).map(attemptView),
            ...(attempts.length > 3
              ? { omittedHistory: attempts.length - 3 }
              : {}),
          },
        };
      }),
    ),
    results: page(
      state.results.map((item) => ({
        id: item.id,
        assignmentId: item.assignmentId,
        validity: item.validity,
        ...(item.validity === "typed"
          ? {
              kind: item.report.kind,
              status: item.report.status,
              ...(item.report.kind === "implementation" &&
              item.report.status === "completed"
                ? {
                    outcome: item.report.outcome,
                    ...(item.report.outcome === "no_change"
                      ? {
                          revision: item.report.revision,
                          reason: compactText(item.report.reason),
                        }
                      : {}),
                  }
                : {}),
            }
          : {}),
        summary: compactText(
          item.validity === "typed"
            ? item.report.summary
            : item.validity === "untyped"
              ? item.text
              : item.detail,
        ),
        undeliveredEvidence: accounting
          .filter(
            (entry) =>
              entry.kind === "undelivered_result" && entry.resultId === item.id,
          )
          .map((entry) => ({
            ...entry,
            reason: compactText(entry.reason, 320),
          })),
        retainedNotApplied: state.attempts
          .filter(
            (attempt) =>
              attempt.resultId === item.id &&
              attempt.composition?.state === "retained_not_applied",
          )
          .map((attempt) => ({
            attemptId: attempt.id,
            reason: attempt.composition?.reason
              ? compactText(attempt.composition.reason, 320)
              : undefined,
            retainedRef: attempt.composition?.retainedRef,
            integratedRevision: attempt.composition?.integratedRevision,
          })),
        handles: {
          summary: "summary",
          evidence: "evidence",
          findings: "findings",
          attention: "attention",
        },
      })),
    ),
    delivery: page(
      state.deliveries.map((delivery) => ({
        resultId: delivery.resultId,
        state: delivery.state,
        error: delivery.error ? compactText(delivery.error, 320) : undefined,
        failureCount: delivery.failureHistory?.length ?? 0,
      })),
    ),
    attention: page(attention),
    accounting: page(
      accounting.map((entry) => ({
        ...entry,
        reason: compactText(entry.reason, 320),
      })),
    ),
    judgment: page(
      state.dispositions.map(({ resultId, status, reason }) => ({
        resultId,
        status,
        reason: compactText(reason, 320),
      })),
    ),
    completion: state.completion
      ? {
          completedAt: state.completion.completedAt,
          accountingCount: state.completion.accounting.length,
        }
      : undefined,
  };
}

function focusedResult(
  state: WorkstreamState,
  resultId: string,
  section: "all" | "summary" | "evidence" | "findings" | "attention",
  offset: number,
  limit: number,
): Record<string, unknown> {
  const item = state.results.find((candidate) => candidate.id === resultId);
  if (!item) throw new Error(`Unknown result ${resultId}.`);
  const base = {
    id: item.id,
    assignmentId: item.assignmentId,
    validity: item.validity,
    accounting: state.completion?.accounting.filter(
      (entry) =>
        (entry.kind === "unresolved_result" ||
          entry.kind === "undelivered_result") &&
        entry.resultId === item.id,
    ),
  };
  if (item.validity !== "typed")
    return {
      ...base,
      ...(item.validity === "untyped"
        ? { text: item.text }
        : { detail: item.detail }),
    };
  const report = item.report;
  const page = (values: unknown[]) => ({
    items: values.slice(offset, offset + limit),
    total: values.length,
    offset,
    limit,
    remaining: Math.max(0, values.length - offset - limit),
    ...(offset + limit < values.length ? { nextOffset: offset + limit } : {}),
    continuation: "Call workgraph_result with the same section and nextOffset.",
  });
  if (section === "summary")
    return {
      ...base,
      kind: report.kind,
      status: report.status,
      summary: report.summary,
      uncertainty: report.uncertainty ?? [],
      evidenceCount: report.evidence.length,
      findingsCount: report.findings.length,
      ...(report.kind === "implementation" && report.status === "completed"
        ? {
            outcome: report.outcome,
            ...(report.outcome === "no_change"
              ? { revision: report.revision, reason: report.reason }
              : { commit: report.commit }),
          }
        : {}),
    };
  if (section === "evidence")
    return { ...base, evidence: page(report.evidence) };
  if (section === "findings")
    return { ...base, findings: page(report.findings) };
  if (section === "attention")
    return {
      ...base,
      delivery: state.deliveries.find(
        (delivery) => delivery.resultId === resultId,
      ),
      judgments: state.dispositions.filter(
        (disposition) => disposition.resultId === resultId,
      ),
      accounting: state.completion?.accounting.filter(
        (entry) =>
          (entry.kind === "unresolved_result" ||
            entry.kind === "undelivered_result") &&
          entry.resultId === resultId,
      ),
      retainedNotApplied: state.attempts
        .filter(
          (attempt) =>
            attempt.resultId === resultId &&
            attempt.composition?.state === "retained_not_applied",
        )
        .map((attempt) => ({
          attemptId: attempt.id,
          reason: attempt.composition?.reason,
          retainedRef: attempt.composition?.retainedRef,
          integratedRevision: attempt.composition?.integratedRevision,
        })),
    };
  return {
    ...base,
    kind: report.kind,
    status: report.status,
    summary: report.summary,
    uncertainty: report.uncertainty ?? [],
    evidence: page(report.evidence),
    findings: page(report.findings),
    ...(report.kind === "implementation" && report.status === "completed"
      ? {
          outcome: report.outcome,
          ...(report.outcome === "no_change"
            ? { revision: report.revision, reason: report.reason }
            : { commit: report.commit }),
        }
      : {}),
    artifacts: item.artifacts,
  };
}

function resultNotification(state: WorkstreamState, resultId: string): string {
  return [
    `Workgraph retained result ${resultId} is available for ${state.id}.`,
    "This is a retained-result availability notice, not new outstanding work.",
    "It may be presented after the result was already inspected or the workstream was completed; do not reprocess or reopen work solely because of this notice.",
    JSON.stringify(focusedResult(state, resultId, "summary", 0, 20), null, 2),
    "Use workgraph_result with this resultId and section evidence or findings for bounded detail; continuation offsets are returned when needed.",
  ].join("\n");
}

function result(
  text: string,
  state: WorkstreamState,
  view = coordinatorView(state),
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${text}\n\n${JSON.stringify(view, null, 2)}`,
      },
    ],
    details: { workstream: state, view, statePath: state.statePath },
  };
}

function queueOptions(params: {
  selection?: QueueOptions["selection"];
  model?: string;
  modelReason?: string;
  thinking?: QueueOptions["thinking"];
  continuationOf?: string;
  baseRevision?: string;
}): QueueOptions {
  return {
    ...(params.selection ? { selection: params.selection } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.modelReason ? { modelReason: params.modelReason } : {}),
    ...(params.thinking ? { thinking: params.thinking } : {}),
    ...(params.continuationOf ? { continuationOf: params.continuationOf } : {}),
    ...(params.baseRevision ? { baseRevision: params.baseRevision } : {}),
  };
}
