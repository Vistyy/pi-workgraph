import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const HUMAN_INPUT_ENTRY = "pi-workgraph-human-input";
const NOTEPAD_STATE_ENTRY = "pi-workgraph-coordinator-notepad-state";
const LEGACY_NOTE_STATE_ENTRY = "pi-workgraph-coordinator-note-state";
const NOTEPAD_PREFIX = "[WORKGRAPH PENDING ITEMS]";

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
export type PendingItem = { id: string; text: string };
export type CoordinatorNotepadState = { version: 2; items: PendingItem[] };

const PendingItemSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const CoordinatorNotepadStateSchema = Type.Object(
  { version: Type.Literal(2), items: Type.Array(PendingItemSchema) },
  { additionalProperties: false },
);
const LegacyNoteStateSchema = Type.Object({
  version: Type.Literal(1),
  notes: Type.Array(
    Type.Object({
      id: Type.String(),
      summary: Type.String(),
      status: StringEnum(["pending", "resolved", "superseded"] as const),
      presentations: Type.Array(Type.Unknown()),
      resolution: Type.Optional(Type.Unknown()),
      supersededBy: Type.Optional(Type.String()),
    }),
  ),
  drafts: Type.Array(
    Type.Object({
      operation: StringEnum(["record", "update", "supersede"] as const),
      id: Type.String(),
      summary: Type.String(),
      toolCallId: Type.String(),
      supersedes: Type.Array(Type.String()),
    }),
  ),
});
const NotepadRequestSchema = Type.Object({
  action: StringEnum(["read", "add", "update", "remove"] as const),
  id: Type.Optional(Type.String({ minLength: 1 })),
  text: Type.Optional(Type.String({ minLength: 1 })),
});

type InstallOptions = {
  owner(ctx: ExtensionContext): SessionOwner;
  serialize<T>(run: () => Promise<T>): Promise<T>;
  onHumanInput?(receipt: HumanInputReceipt): Promise<void>;
};

export type CoordinatorSessionState = {
  getHumanReceipts(): HumanInputReceipt[];
  getNotepadState(): CoordinatorNotepadState;
};

/** Install genuine input receipts and the coordinator's compact pending-items notepad. */
export function installCoordinatorSessionState(
  pi: ExtensionAPI,
  options: InstallOptions,
): CoordinatorSessionState {
  let state = emptyState();
  let receipts: HumanInputReceipt[] = [];

  const persist = (): void => {
    pi.appendEntry(NOTEPAD_STATE_ENTRY, cloneState(state));
  };

  const restore = (ctx: ExtensionContext, persistMigration: boolean): void => {
    const owner = options.owner(ctx);
    const branch = ctx.sessionManager.getBranch();
    receipts = branch.flatMap((entry) => receiptFromEntry(entry, owner));
    const current = branch.findLast(
      (entry) => entry.type === "custom" && entry.customType === NOTEPAD_STATE_ENTRY,
    );
    if (current !== undefined) {
      if (current.type !== "custom" || !Value.Check(CoordinatorNotepadStateSchema, current.data)) {
        state = emptyState();
        ctx.ui.notify(
          "Coordinator notepad state is malformed on this branch; it was not interpreted or cleared.",
          "warning",
        );
        return;
      }
      state = cloneState(Value.Decode(CoordinatorNotepadStateSchema, current.data));
      return;
    }

    const legacy = branch.findLast(
      (entry) => entry.type === "custom" && entry.customType === LEGACY_NOTE_STATE_ENTRY,
    );
    if (legacy === undefined) {
      state = emptyState();
      return;
    }
    if (legacy.type !== "custom" || !Value.Check(LegacyNoteStateSchema, legacy.data)) {
      state = emptyState();
      ctx.ui.notify(
        "Legacy coordinator note state is malformed on this branch; it was not interpreted or cleared.",
        "warning",
      );
      return;
    }
    state = migrateLegacyState(Value.Decode(LegacyNoteStateSchema, legacy.data));
    if (persistMigration) persist();
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
      receipts.push(receipt);
      return Promise.resolve(options.onHumanInput?.(receipt)).then(() => undefined);
    });
  });

  pi.on("session_start", (_event, ctx) => restore(ctx, true));
  pi.on("session_tree", (_event, ctx) => restore(ctx, false));

  // Inject a compact snapshot only when the current branch does not already contain it.
  // The stable prefix makes the snapshot cache-friendly while state entries survive compaction.
  pi.on("before_agent_start", (_event, ctx) => {
    const content = reminderContent(state, ctx);
    return content === undefined
      ? undefined
      : { message: { customType: "pi-workgraph-coordinator-notepad", content, display: false } };
  });
  pi.on("session_compact", (_event, ctx) => {
    const content = reminderContent(state, ctx);
    if (content !== undefined)
      pi.sendMessage({
        customType: "pi-workgraph-coordinator-notepad",
        content,
        display: false,
      });
  });

  pi.registerTool({
    name: "workgraph_notepad",
    label: "Workgraph Notepad",
    description:
      "Read or edit the coordinator's current session-owned pending items. Actions are read, add, update, and remove. Items are plain id/text reminders, not acknowledgments, human receipts, authority, delivery state, evidence dispositions, or an append-only history. Removal is allowed whenever an item is mistaken or no longer useful; nothing expires or resolves automatically.",
    promptSnippet: "Read or edit coordinator pending items",
    promptGuidelines: [
      "Use workgraph_notepad only in the coordinator when a compact pending item will help future coordination; read it on demand instead of copying the list into every response.",
      "Use workgraph_notepad remove when an item is mistaken or no longer useful; do not infer acknowledgment, parse replies, or require a human receipt to edit pending items.",
    ],
    parameters: NotepadRequestSchema,
    execute(_toolCallId, params, _signal, _update, _ctx) {
      return options.serialize(() => {
        applyNotepadAction(state, params);
        if (params.action !== "read") persist();
        const snapshot = cloneState(state);
        return Promise.resolve({
          content: [{ type: "text" as const, text: formatNotepad(snapshot) }],
          details: { action: params.action, notepad: snapshot },
        });
      });
    },
  });

  return {
    getHumanReceipts: () => structuredClone(receipts),
    getNotepadState: () => cloneState(state),
  };
}

function emptyState(): CoordinatorNotepadState {
  return { version: 2, items: [] };
}

function cloneState(state: CoordinatorNotepadState): CoordinatorNotepadState {
  return structuredClone(state);
}

function receiptFromEntry(entry: SessionEntry, owner: SessionOwner): HumanInputReceipt[] {
  if (
    entry.type !== "custom" ||
    entry.customType !== HUMAN_INPUT_ENTRY ||
    !Value.Check(HumanInputReceiptSchema, entry.data) ||
    entry.data.sessionId !== owner.sessionId ||
    entry.data.sessionFile !== owner.sessionFile
  )
    return [];
  return [Value.Decode(HumanInputReceiptSchema, entry.data)];
}

function applyNotepadAction(
  state: CoordinatorNotepadState,
  request: { action: "read" | "add" | "update" | "remove"; id?: string; text?: string },
): void {
  if (request.action === "read") {
    if (request.id !== undefined || request.text !== undefined)
      throw new Error("Notepad read does not accept id or text.");
    return;
  }
  const id = requiredText(request.id, `${request.action} requires id`);
  const index = state.items.findIndex((item) => item.id === id);
  if (request.action === "add") {
    if (index >= 0) throw new Error(`Pending item ${id} already exists.`);
    state.items.push({ id, text: requiredText(request.text, "add requires text") });
    return;
  }
  if (index < 0) throw new Error(`Unknown pending item ${id}.`);
  if (request.action === "update") {
    const item = state.items[index];
    if (item === undefined) throw new Error(`Unknown pending item ${id}.`);
    item.text = requiredText(request.text, "update requires text");
    return;
  }
  if (request.text !== undefined) throw new Error("remove does not accept text.");
  state.items.splice(index, 1);
}

function requiredText(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") throw new Error(message);
  return value.trim();
}

function formatNotepad(state: CoordinatorNotepadState): string {
  if (state.items.length === 0) return `${NOTEPAD_PREFIX}\nNo pending items.`;
  return [
    NOTEPAD_PREFIX,
    ...state.items.map((item) => `- ${item.id}: ${compactLine(item.text)}`),
  ].join("\n");
}

function compactLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function reminderContent(
  state: CoordinatorNotepadState,
  ctx: ExtensionContext,
): string | undefined {
  const content = formatNotepad(state);
  const latest = ctx.sessionManager
    .buildContextEntries()
    .findLast(
      (entry) =>
        entry.type === "custom_message" && entry.customType === "pi-workgraph-coordinator-notepad",
    );
  return latest?.type === "custom_message" && latest.content === content ? undefined : content;
}

function migrateLegacyState(legacy: {
  notes: Array<{ id: string; summary: string; status: "pending" | "resolved" | "superseded" }>;
  drafts: Array<{
    operation: "record" | "update" | "supersede";
    id: string;
    summary: string;
    supersedes: string[];
  }>;
}): CoordinatorNotepadState {
  const items = new Map(
    legacy.notes
      .filter((note) => note.status === "pending")
      .map((note) => [note.id, { id: note.id, text: note.summary.trim() }]),
  );
  // Drafts were never presentation-grounded and therefore are not current pending substance.
  // Their schema is decoded for safe migration, but their ledger semantics end here.
  return { version: 2, items: [...items.values()].filter((item) => item.text !== "") };
}
