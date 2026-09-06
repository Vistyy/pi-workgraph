import { createHash, randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const HUMAN_INPUT_ENTRY = "pi-workgraph-human-input";
const NOTE_STATE_ENTRY = "pi-workgraph-coordinator-note-state";
const NOTE_CONTEXT_TYPE = "pi-workgraph-coordinator-notes";

export const HumanInputReceiptSchema = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  sessionFile: Type.String(),
  source: StringEnum(["interactive", "rpc"] as const),
  text: Type.String(),
});

export type HumanInputReceipt = {
  id: string;
  sessionId: string;
  sessionFile: string;
  source: "interactive" | "rpc";
  text: string;
};

type SessionOwner = Pick<HumanInputReceipt, "sessionId" | "sessionFile">;
type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];
type AssistantMessage = Extract<SessionMessage, { role: "assistant" }>;
type AssistantText = Extract<AssistantMessage["content"][number], { type: "text" }>;

type VisiblePresentation = {
  summary: string;
  toolCallId: string;
  assistantTimestamp: number;
  assistantDigest: string;
  assistantEntryId?: string;
};

type NoteResolution = {
  receiptId: string;
  receiptSource: HumanInputReceipt["source"];
  interpretation: string;
};

type CoordinatorNote = {
  id: string;
  summary: string;
  status: "pending" | "resolved" | "superseded";
  presentations: VisiblePresentation[];
  resolution?: NoteResolution;
  supersededBy?: string;
};

type NoteDraft = {
  operation: "record" | "update" | "supersede";
  id: string;
  summary: string;
  toolCallId: string;
  supersedes: string[];
};

export type CoordinatorNoteState = {
  version: 1;
  notes: CoordinatorNote[];
  drafts: NoteDraft[];
};

type ReceiptWithEntry = HumanInputReceipt & { entryId: string };

type NoteChange = {
  operation: "record" | "update" | "supersede" | "resolve";
  id: string;
  summary?: string;
  supersedes?: string[];
  receiptId?: string;
  interpretation?: string;
};

const VisiblePresentationSchema = Type.Object({
  summary: Type.String(),
  toolCallId: Type.String(),
  assistantTimestamp: Type.Number(),
  assistantDigest: Type.String(),
  assistantEntryId: Type.Optional(Type.String()),
});
const NoteResolutionSchema = Type.Object({
  receiptId: Type.String(),
  receiptSource: StringEnum(["interactive", "rpc"] as const),
  interpretation: Type.String(),
});
const CoordinatorNoteSchema = Type.Object({
  id: Type.String(),
  summary: Type.String(),
  status: StringEnum(["pending", "resolved", "superseded"] as const),
  presentations: Type.Array(VisiblePresentationSchema),
  resolution: Type.Optional(NoteResolutionSchema),
  supersededBy: Type.Optional(Type.String()),
});
const NoteDraftSchema = Type.Object({
  operation: StringEnum(["record", "update", "supersede"] as const),
  id: Type.String(),
  summary: Type.String(),
  toolCallId: Type.String(),
  supersedes: Type.Array(Type.String()),
});
const CoordinatorNoteStateSchema = Type.Object({
  version: Type.Literal(1),
  notes: Type.Array(CoordinatorNoteSchema),
  drafts: Type.Array(NoteDraftSchema),
});
const NoteChangeSchema = Type.Object({
  operation: StringEnum(["record", "update", "supersede", "resolve"] as const),
  id: Type.String({ minLength: 1 }),
  summary: Type.Optional(Type.String({ minLength: 1 })),
  supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  receiptId: Type.Optional(Type.String({ minLength: 1 })),
  interpretation: Type.Optional(Type.String({ minLength: 1 })),
});

export type CoordinatorNotes = {
  getHumanReceipts(): HumanInputReceipt[];
  getState(): CoordinatorNoteState;
};

type ApplyResult = { state: CoordinatorNoteState; affected: string[]; message: string };

type InstallOptions = {
  owner(ctx: ExtensionContext): SessionOwner;
  serialize<T>(run: () => Promise<T>): Promise<T>;
  onHumanInput?(receipt: HumanInputReceipt): Promise<void>;
};

export function installCoordinatorNotes(
  pi: ExtensionAPI,
  options: InstallOptions,
): CoordinatorNotes {
  let state = emptyState();
  let receipts: ReceiptWithEntry[] = [];
  let entryOrder = new Map<string, number>();

  const restore = (ctx: ExtensionContext): void => {
    const owner = options.owner(ctx);
    const branch = ctx.sessionManager.getBranch();
    entryOrder = new Map(branch.map((entry, index) => [entry.id, index]));
    receipts = branch.flatMap((entry) => receiptFromEntry(entry, owner));
    const snapshots = branch.filter(
      (entry) => entry.type === "custom" && entry.customType === NOTE_STATE_ENTRY,
    );
    const latest = snapshots.at(-1);
    if (latest === undefined) {
      state = emptyState();
      return;
    }
    if (latest.type !== "custom" || !Value.Check(CoordinatorNoteStateSchema, latest.data)) {
      state = emptyState();
      ctx.ui.notify(
        "Coordinator note state is malformed on this branch; it was not interpreted or cleared.",
        "warning",
      );
      return;
    }
    state = cloneState(Value.Decode(CoordinatorNoteStateSchema, latest.data));
  };

  const refreshOrder = (ctx: ExtensionContext): void => {
    entryOrder = new Map(ctx.sessionManager.getBranch().map((entry, index) => [entry.id, index]));
  };

  const persist = (ctx: ExtensionContext): void => {
    pi.appendEntry(NOTE_STATE_ENTRY, cloneState(state));
    refreshOrder(ctx);
  };

  pi.on("input", (event, ctx) => {
    if ((event.source !== "interactive" && event.source !== "rpc") || event.text.trim() === "")
      return;
    const source = event.source;
    return options.serialize(() => {
      const receipt: HumanInputReceipt = {
        id: randomUUID(),
        ...options.owner(ctx),
        source,
        text: event.text,
      };
      pi.appendEntry(HUMAN_INPUT_ENTRY, receipt);
      const entryId = ctx.sessionManager.getLeafId();
      if (entryId === null)
        throw new Error("Human input receipt was not persisted in the session.");
      receipts.push({ ...receipt, entryId });
      refreshOrder(ctx);
      return Promise.resolve(options.onHumanInput?.(receipt)).then(() => undefined);
    });
  });

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    if (!isVisibleFinalAnswer(event.message) || state.drafts.length === 0) return;
    const answer = event.message;
    return options.serialize(() => {
      const source = visibleSource(answer, ctx);
      state = presentDrafts(state, source);
      persist(ctx);
      return Promise.resolve();
    });
  });

  pi.on("context", (event) => {
    const content = formatNoteContext(state);
    if (content === undefined) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: NOTE_CONTEXT_TYPE,
          content,
          display: false,
          timestamp: Effect.runSync(Clock.currentTimeMillis),
        },
      ],
    };
  });

  pi.registerTool({
    name: "workgraph_note",
    label: "Workgraph Note",
    description:
      "Record, update, supersede, or resolve compact session-owned notes for substantive answers, requested outcomes, or status that genuinely await a later human response. This is semantic coordinator memory, not a notebook, read detector, workflow gate, Workstream delivery acknowledgment, disposition, or mutation authority. Record before presenting the human-facing answer. Resolve only specifically addressed pending note ids and cite a genuine later interactive/RPC receipt; unrelated input and operational notifications clear nothing. Superseding status must consolidate every still-unresolved substantive point from the replaced notes. Batch changes are supported.",
    promptSnippet:
      "Track substantive human-facing answers or status awaiting a later human response",
    promptGuidelines: [
      "Use workgraph_note before a substantive human-facing answer, requested outcome, or status that needs a later human response; do not record filler narration or every update.",
      "Use workgraph_note resolve only as your interpretation of a cited later genuine human reply and only for the note ids that reply addresses; the tool call is not itself acknowledgment or authority.",
      "When workgraph_note reminders exist, mention only brief relevant reminders, never replay the whole answer, and do not demand clarification merely to classify an ambiguous courtesy such as 'thanks'.",
    ],
    parameters: Type.Object({
      changes: Type.Array(NoteChangeSchema, { minItems: 1 }),
    }),
    execute(toolCallId, params, _signal, _update, ctx) {
      return options.serialize(() => {
        const next = applyChanges(state, params.changes, toolCallId, receipts, entryOrder);
        state = next.state;
        persist(ctx);
        return Promise.resolve({
          content: [{ type: "text" as const, text: next.message }],
          details: {
            affected: next.affected,
            pending: state.notes.filter((note) => note.status === "pending").length,
            drafted: state.drafts.length,
          },
        });
      });
    },
  });

  return {
    getHumanReceipts: () => receipts.map(withoutEntryId),
    getState: () => cloneState(state),
  };
}

function emptyState(): CoordinatorNoteState {
  return { version: 1, notes: [], drafts: [] };
}

function cloneState(state: CoordinatorNoteState): CoordinatorNoteState {
  return structuredClone(state);
}

function receiptFromEntry(entry: SessionEntry, owner: SessionOwner): ReceiptWithEntry[] {
  if (
    entry.type !== "custom" ||
    entry.customType !== HUMAN_INPUT_ENTRY ||
    !Value.Check(HumanInputReceiptSchema, entry.data) ||
    entry.data.sessionId !== owner.sessionId ||
    entry.data.sessionFile !== owner.sessionFile
  )
    return [];
  return [{ ...Value.Decode(HumanInputReceiptSchema, entry.data), entryId: entry.id }];
}

function withoutEntryId(receipt: ReceiptWithEntry): HumanInputReceipt {
  const { entryId: _entryId, ...input } = receipt;
  return input;
}

function isVisibleFinalAnswer(message: SessionMessage): message is AssistantMessage {
  return (
    message.role === "assistant" &&
    message.stopReason === "stop" &&
    message.content.some((part) => part.type === "text" && part.text.trim() !== "")
  );
}

function visibleSource(
  message: AssistantMessage,
  ctx: ExtensionContext,
): Omit<VisiblePresentation, "summary" | "toolCallId"> {
  const assistantText = message.content
    .filter((part): part is AssistantText => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const digest = createHash("sha256").update(assistantText).digest("hex");
  const assistantEntryId = [...ctx.sessionManager.getBranch()]
    .reverse()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.timestamp === message.timestamp,
    )?.id;
  return assistantEntryId === undefined
    ? { assistantTimestamp: message.timestamp, assistantDigest: digest }
    : { assistantTimestamp: message.timestamp, assistantDigest: digest, assistantEntryId };
}

function presentDrafts(
  current: CoordinatorNoteState,
  source: Omit<VisiblePresentation, "summary" | "toolCallId">,
): CoordinatorNoteState {
  const next = cloneState(current);
  for (const draft of next.drafts) {
    const presentation: VisiblePresentation = {
      summary: draft.summary,
      toolCallId: draft.toolCallId,
      ...source,
    };
    if (draft.operation === "record") {
      next.notes.push({
        id: draft.id,
        summary: draft.summary,
        status: "pending",
        presentations: [presentation],
      });
      continue;
    }
    if (draft.operation === "update") {
      const note = requiredPendingNote(next.notes, draft.id);
      note.summary = draft.summary;
      note.presentations.push(presentation);
      continue;
    }
    for (const replacedId of draft.supersedes) {
      const replaced = requiredPendingNote(next.notes, replacedId);
      replaced.status = "superseded";
      replaced.supersededBy = draft.id;
    }
    next.notes.push({
      id: draft.id,
      summary: draft.summary,
      status: "pending",
      presentations: [presentation],
    });
  }
  next.drafts = [];
  return next;
}

function applyChanges(
  current: CoordinatorNoteState,
  changes: NoteChange[],
  toolCallId: string,
  receipts: ReceiptWithEntry[],
  entryOrder: Map<string, number>,
): ApplyResult {
  const next = cloneState(current);
  const affected = changes.flatMap((change) =>
    applyChange(next, change, toolCallId, receipts, entryOrder),
  );
  const uniqueAffected = unique(affected);
  const drafted = next.drafts.length;
  return {
    state: next,
    affected: uniqueAffected,
    message:
      drafted === 0
        ? `Resolved coordinator note changes for: ${uniqueAffected.join(", ")}.`
        : `Recorded coordinator note changes for: ${uniqueAffected.join(", ")}. ${drafted} draft change(s) are persisted but are not evidence that an answer was shown; a later finalized visible assistant answer must establish presentation.`,
  };
}

function applyChange(
  state: CoordinatorNoteState,
  change: NoteChange,
  toolCallId: string,
  receipts: ReceiptWithEntry[],
  entryOrder: Map<string, number>,
): string[] {
  if (change.operation === "resolve") {
    resolveNote(state, change, receipts, entryOrder);
    return [change.id];
  }
  const summary = requiredText(change.summary, `${change.operation} requires summary`);
  if (change.operation === "record") return [recordDraft(state, change.id, summary, toolCallId)];
  if (change.operation === "update") return [updateDraft(state, change.id, summary, toolCallId)];
  return supersedeDraft(state, change, summary, toolCallId);
}

function recordDraft(
  state: CoordinatorNoteState,
  id: string,
  summary: string,
  toolCallId: string,
): string {
  if (findNoteOrDraft(state, id) !== undefined)
    throw new Error(`Coordinator note ${id} already exists.`);
  state.drafts.push({ operation: "record", id, summary, toolCallId, supersedes: [] });
  return id;
}

function updateDraft(
  state: CoordinatorNoteState,
  id: string,
  summary: string,
  toolCallId: string,
): string {
  const existingDraft = state.drafts.find((draft) => draft.id === id);
  if (existingDraft !== undefined) {
    existingDraft.summary = summary;
    existingDraft.toolCallId = toolCallId;
  } else {
    requiredPendingNote(state.notes, id);
    state.drafts.push({ operation: "update", id, summary, toolCallId, supersedes: [] });
  }
  return id;
}

function supersedeDraft(
  state: CoordinatorNoteState,
  change: NoteChange,
  summary: string,
  toolCallId: string,
): string[] {
  const supersedes = unique(change.supersedes ?? []);
  if (supersedes.length === 0) throw new Error("supersede requires supersedes note ids.");
  if (findNoteOrDraft(state, change.id) !== undefined)
    throw new Error(`Replacement coordinator note ${change.id} already exists.`);
  for (const id of supersedes) requiredPendingNote(state.notes, id);
  state.drafts.push({ operation: "supersede", id: change.id, summary, toolCallId, supersedes });
  return [change.id, ...supersedes];
}

function resolveNote(
  state: CoordinatorNoteState,
  change: NoteChange,
  receipts: ReceiptWithEntry[],
  entryOrder: Map<string, number>,
): void {
  const existing = state.notes.find((candidate) => candidate.id === change.id);
  if (existing === undefined && state.drafts.some((draft) => draft.id === change.id))
    throw new Error(
      `Coordinator note ${change.id} was drafted but has no finalized visible assistant answer yet.`,
    );
  const note = requiredPendingNote(state.notes, change.id);
  const receiptId = requiredText(change.receiptId, "resolve requires receiptId");
  const interpretation = requiredText(
    change.interpretation,
    "resolve requires an interpretation of the cited human reply",
  );
  const receipt = receipts.find((candidate) => candidate.id === receiptId);
  if (receipt === undefined)
    throw new Error(`Unknown genuine human input receipt ${receiptId} in this session branch.`);
  const presentedEntryId = note.presentations.at(-1)?.assistantEntryId;
  if (presentedEntryId === undefined)
    throw new Error(
      `Coordinator note ${note.id} lacks a persisted visible assistant entry and cannot be resolved as shown.`,
    );
  const presentedOrder = entryOrder.get(presentedEntryId);
  const receiptOrder = entryOrder.get(receipt.entryId);
  if (presentedOrder === undefined || receiptOrder === undefined || receiptOrder <= presentedOrder)
    throw new Error(
      `Human input receipt ${receiptId} is not later than the visible answer for coordinator note ${note.id}.`,
    );
  note.status = "resolved";
  note.resolution = {
    receiptId,
    receiptSource: receipt.source,
    interpretation,
  };
}

function findNoteOrDraft(
  state: CoordinatorNoteState,
  id: string,
): CoordinatorNote | NoteDraft | undefined {
  return (
    state.notes.find((note) => note.id === id) ?? state.drafts.find((draft) => draft.id === id)
  );
}

function requiredPendingNote(notes: CoordinatorNote[], id: string): CoordinatorNote {
  const note = notes.find((candidate) => candidate.id === id);
  if (note === undefined) throw new Error(`Unknown coordinator note ${id}.`);
  if (note.status !== "pending")
    throw new Error(`Coordinator note ${id} is ${note.status}, not pending.`);
  return note;
}

function requiredText(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") throw new Error(message);
  return value.trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatNoteContext(state: CoordinatorNoteState): string | undefined {
  const pending = state.notes.filter((note) => note.status === "pending");
  if (pending.length === 0 && state.drafts.length === 0) return undefined;
  const lines = [
    "[COORDINATOR RESPONSE NOTES]",
    "Session-owned semantic reminders only. They do not prove reading, acknowledgment, authority, delivery, or acceptance.",
  ];
  if (pending.length > 0) {
    lines.push("Pending genuine later human response:");
    for (const note of pending) lines.push(`- ${note.id}: ${compactLine(note.summary)}`);
  }
  if (state.drafts.length > 0) {
    lines.push("Drafted but not yet grounded in a finalized visible assistant answer:");
    for (const draft of state.drafts) lines.push(`- ${draft.id}: ${compactLine(draft.summary)}`);
  }
  lines.push(
    "Mention only a brief relevant reminder when useful; never replay whole answers or turn this into acknowledgment ceremony.",
    "Resolve only addressed ids via workgraph_note with a genuine later human receipt. Unrelated input and operational notifications clear nothing. Ambiguous courtesy does not require a clarification request merely for note bookkeeping.",
  );
  return lines.join("\n");
}

function compactLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
