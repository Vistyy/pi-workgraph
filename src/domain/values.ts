import { DateTime, Option } from "effect";
import { Type } from "typebox";

export const NonEmptyStringSchema = Type.String({ minLength: 1 });
export const CommitSchema = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
export const InstantSchema = Type.String({
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});

export function instantMillis(value: string): number {
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed) || DateTime.toDate(parsed.value).toISOString() !== value)
    throw new Error(`Invalid UTC-millisecond instant: ${value}.`);
  return DateTime.toDate(parsed.value).getTime();
}
