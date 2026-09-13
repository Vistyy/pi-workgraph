import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DateTime } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const HumanInputReceiptDataSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    sessionFile: Type.String({ minLength: 1 }),
    source: Type.Union([Type.Literal("interactive"), Type.Literal("rpc")]),
    text: Type.String({ minLength: 1 }),
    receivedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
type HumanInputReceiptData = Static<typeof HumanInputReceiptDataSchema>;
type SessionOwner = Pick<HumanInputReceiptData, "sessionId" | "sessionFile">;
export interface CoordinatorReceipts {
  getHumanReceipts(): HumanInputReceiptData[];
}
const HUMAN_INPUT_ENTRY = "pi-workgraph-human-input";

/** Persist and restore genuine current-session human input receipts. */
export function installCoordinatorReceipts(
  pi: ExtensionAPI,
  options: {
    owner(ctx: ExtensionContext): SessionOwner;
    serialize<T>(run: () => Promise<T>): Promise<T>;
  },
): CoordinatorReceipts {
  let receipts: HumanInputReceiptData[] = [];
  const restore = (ctx: ExtensionContext): void => {
    const owner = options.owner(ctx);
    receipts = ctx.sessionManager.getBranch().flatMap((entry) => receiptFromEntry(entry, owner));
  };
  pi.on("input", (event, ctx) => {
    if ((event.source !== "interactive" && event.source !== "rpc") || event.text.trim() === "")
      return;
    return options.serialize(() => {
      const source: "interactive" | "rpc" = event.source === "interactive" ? "interactive" : "rpc";
      const receipt: HumanInputReceiptData = {
        id: randomUUID(),
        ...options.owner(ctx),
        source,
        text: event.text,
        receivedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      };
      pi.appendEntry(HUMAN_INPUT_ENTRY, receipt);
      receipts.push(receipt);
      return Promise.resolve();
    });
  });
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  return { getHumanReceipts: () => structuredClone(receipts) };
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
