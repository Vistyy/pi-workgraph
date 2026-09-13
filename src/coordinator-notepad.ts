import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DateTime } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type HumanInputReceiptData, HumanInputReceiptDataSchema } from "./domain/records.js";

const HUMAN_INPUT_ENTRY = "pi-workgraph-human-input";
const NOTEPAD_STATE_ENTRY = "pi-workgraph-coordinator-notepad-state";
const NOTEPAD_PREFIX = "[WORKGRAPH PENDING ITEMS]";

type SessionOwner = Pick<HumanInputReceiptData, "sessionId" | "sessionFile">;
type PendingItem = { id: string; text: string };
type CoordinatorNotepadState = { version: 2; items: PendingItem[] };

const PendingItemSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const CoordinatorNotepadStateSchema = Type.Object(
  { version: Type.Literal(2), items: Type.Array(PendingItemSchema) },
  { additionalProperties: false },
);
const NotepadRequestSchema = Type.Object({
  action: StringEnum(["read", "add", "update", "remove"] as const),
  id: Type.Optional(Type.String({ minLength: 1 })),
  text: Type.Optional(Type.String({ minLength: 1 })),
});

type InstallOptions = {
  owner(ctx: ExtensionContext): SessionOwner;
  serialize<T>(run: () => Promise<T>): Promise<T>;
};

export type CoordinatorSessionState = {
  getHumanReceipts(): HumanInputReceiptData[];
  getNotepadState(): CoordinatorNotepadState;
};

/** Install genuine input receipts and the coordinator's compact pending-items notepad. */
export function installCoordinatorSessionState(
  pi: ExtensionAPI,
  options: InstallOptions,
): CoordinatorSessionState {
  let state = emptyState();
  let receipts: HumanInputReceiptData[] = [];

  const persist = (): void => {
    pi.appendEntry(NOTEPAD_STATE_ENTRY, cloneState(state));
  };

  const restore = (ctx: ExtensionContext): void => {
    const owner = options.owner(ctx);
    const branch = ctx.sessionManager.getBranch();
    receipts = branch.flatMap((entry) => receiptFromEntry(entry, owner));
    const current = branch.findLast(
      (entry) => entry.type === "custom" && entry.customType === NOTEPAD_STATE_ENTRY,
    );
    if (current === undefined) {
      state = emptyState();
      return;
    }
    if (current.type !== "custom" || !Value.Check(CoordinatorNotepadStateSchema, current.data)) {
      state = emptyState();
      ctx.ui.notify(
        "Coordinator notepad state is malformed on this branch; it was not interpreted or cleared.",
        "warning",
      );
      return;
    }
    state = cloneState(Value.Decode(CoordinatorNotepadStateSchema, current.data));
  };

  pi.on("input", (event, ctx) => {
    if ((event.source !== "interactive" && event.source !== "rpc") || event.text.trim() === "")
      return;
    const source = event.source;
    const receivedAt = DateTime.formatIso(DateTime.nowUnsafe());
    return options.serialize(() => {
      const receipt: HumanInputReceiptData = {
        id: randomUUID(),
        ...options.owner(ctx),
        source,
        text: event.text,
        receivedAt,
      };
      pi.appendEntry(HUMAN_INPUT_ENTRY, receipt);
      receipts.push(receipt);
      return Promise.resolve();
    });
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  // Compaction removes earlier tool results, so restore only current nonempty pending memory.
  pi.on("session_compact", (_event, ctx) => {
    if (state.items.length === 0) return;
    const content = formatNotepad(state);
    const latest = ctx.sessionManager
      .buildContextEntries()
      .findLast(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "pi-workgraph-coordinator-notepad",
      );
    if (latest?.type === "custom_message" && latest.content === content) return;
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
      "Read or edit sparse session-owned reminders that must survive compaction. Items are not approvals, authority, delivery state, or completion accounting; add, update, or remove them whenever their pending substance changes.",
    promptSnippet: "Read or edit coordinator pending reminders",
    promptGuidelines: [
      "Use workgraph_notepad only for pending information worth restoring after compaction, and remove stale items promptly.",
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

function receiptFromEntry(entry: SessionEntry, owner: SessionOwner): HumanInputReceiptData[] {
  if (
    entry.type !== "custom" ||
    entry.customType !== HUMAN_INPUT_ENTRY ||
    !Value.Check(HumanInputReceiptDataSchema, entry.data) ||
    entry.data.sessionId !== owner.sessionId ||
    entry.data.sessionFile !== owner.sessionFile
  )
    return [];
  return [Value.Decode(HumanInputReceiptDataSchema, entry.data)];
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
