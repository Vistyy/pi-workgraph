import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const ENTRY_TYPE = "pi-workgraph-notepad";
const RECOVERY_MESSAGE_TYPE = "pi-workgraph-notepad-recovery";
const MAX_TEXT_LENGTH = 4_000;

const NotepadEntrySchema = Type.Object(
  { text: Type.String({ maxLength: MAX_TEXT_LENGTH }) },
  { additionalProperties: false },
);

const NotepadParameters = Type.Union([
  Type.Object({ action: Type.Literal("read") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("replace"),
      text: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("clear") }, { additionalProperties: false }),
]);

type NotepadEntry = Static<typeof NotepadEntrySchema>;

function currentMemo(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch.at(index);
    if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    return Value.Check(NotepadEntrySchema, entry.data)
      ? Value.Decode(NotepadEntrySchema, entry.data).text
      : "";
  }
  return "";
}

/** Register the branch-local bounded session notepad and compaction recovery hook. */
export function installNotepad(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workgraph_notepad",
    label: "Workgraph Notepad",
    description:
      "Read, replace, or clear the current branch's coordinator memo for pending context. It is not Task state, evidence, authority, or acceptance; replacement text is limited to 4,000 characters.",
    parameters: NotepadParameters,
    // oxlint-disable-next-line effecttsgo/async-function -- Pi's tool boundary requires a Promise; notepad persistence itself is synchronous.
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "read": {
          const text = currentMemo(ctx);
          return {
            content: [{ type: "text", text: text.length === 0 ? "Notepad is empty." : text }],
            details: { text },
          };
        }
        case "replace": {
          const entry: NotepadEntry = { text: params.text };
          pi.appendEntry(ENTRY_TYPE, entry);
          return {
            content: [{ type: "text", text: "Notepad replaced." }],
            details: {},
          };
        }
        case "clear":
          pi.appendEntry(ENTRY_TYPE, { text: "" } satisfies NotepadEntry);
          return {
            content: [{ type: "text", text: "Notepad cleared." }],
            details: {},
          };
      }
    },
  });

  pi.on("session_compact", (_event, ctx) => {
    const text = currentMemo(ctx);
    if (text.length === 0) return;
    pi.sendMessage({
      customType: RECOVERY_MESSAGE_TYPE,
      content: `Current Workgraph notepad:\n${text}`,
      display: false,
    });
  });
}
