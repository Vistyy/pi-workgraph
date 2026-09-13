import { Data, Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isWorkerIdentityData, type WorkerContextIdentity } from "./worker-context.js";

const TodoStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("blocked"),
]);
const TodoIdSchema = Type.String({ minLength: 1, maxLength: 64 });
const TodoSchema = Type.Object(
  {
    id: TodoIdSchema,
    text: Type.String({ minLength: 3, maxLength: 1000 }),
    validation: Type.String({ minLength: 3, maxLength: 1000 }),
    status: TodoStatusSchema,
    note: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
const TodoListSchema = Type.Array(TodoSchema, { minItems: 1, maxItems: 9 });
const TodoPatchSchema = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 3, maxLength: 1000 })),
    validation: Type.Optional(Type.String({ minLength: 3, maxLength: 1000 })),
    status: Type.Optional(TodoStatusSchema),
    note: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export const WorkerPlanToolSchema = Type.Union(
  [
    Type.Object({ action: Type.Literal("get") }, { additionalProperties: false }),
    Type.Object(
      { action: Type.Literal("set"), todos: TodoListSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal("update"), id: TodoIdSchema, patch: TodoPatchSchema },
      { additionalProperties: false },
    ),
  ],
  { type: "object" },
);
const PlanAttemptDetailsSchema = Type.Object({
  attempt: Type.Object({ runId: Type.String(), nodeId: Type.String() }),
});
const PlanResultDetailsSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("get"), Type.Literal("set"), Type.Literal("update")]),
    todos: Type.Optional(TodoListSchema),
    attempt: Type.Object({ runId: Type.String(), nodeId: Type.String() }),
  },
  { additionalProperties: false },
);

export type WorkerTodo = Static<typeof TodoSchema>;
export type WorkerPlanToolInput = Static<typeof WorkerPlanToolSchema>;
export type WorkerAttemptIdentity = WorkerContextIdentity;
export interface WorkerPlanEntry {
  readonly type: string;
  readonly message?: {
    readonly role?: string;
    readonly toolName?: string;
    readonly isError?: boolean;
    readonly details?: unknown;
  };
}
export interface WorkerPlanToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: Static<typeof PlanResultDetailsSchema>;
}

export class WorkerContractError extends Data.TaggedError("WorkerContractError")<{
  readonly message: string;
}> {}

function contractFailure(message: string) {
  return Effect.fail(new WorkerContractError({ message }));
}

function validTodos(todos: readonly WorkerTodo[]): boolean {
  return new Set(todos.map((todo) => todo.id)).size === todos.length;
}

export class WorkerPlanState {
  todos: WorkerTodo[] | undefined;

  constructor(readonly identity: WorkerAttemptIdentity) {}

  restore(entries: readonly WorkerPlanEntry[]): void {
    this.todos = undefined;
    for (const entry of entries) {
      if (
        entry.type !== "message" ||
        entry.message?.role !== "toolResult" ||
        entry.message.toolName !== "workgraph_plan" ||
        entry.message.isError === true ||
        !Value.Check(PlanAttemptDetailsSchema, entry.message.details)
      )
        continue;
      const attempt = Value.Decode(PlanAttemptDetailsSchema, entry.message.details).attempt;
      if (!isWorkerIdentityData(attempt, this.identity)) continue;
      if (!Value.Check(PlanResultDetailsSchema, entry.message.details)) {
        this.todos = undefined;
        continue;
      }
      const details = Value.Decode(PlanResultDetailsSchema, entry.message.details);
      this.todos =
        details.todos !== undefined && validTodos(details.todos)
          ? structuredClone(details.todos)
          : undefined;
    }
  }

  execute(input: WorkerPlanToolInput): Effect.Effect<WorkerPlanToolResult, WorkerContractError> {
    if (input.action === "get") return Effect.succeed(this.result("get"));
    if (input.action === "set") {
      if (!validTodos(input.todos))
        return contractFailure("TODO ids must be unique; no changes were made.");
      this.todos = structuredClone(input.todos);
      return Effect.succeed(this.result("set"));
    }
    if (this.todos === undefined)
      return contractFailure("No TODO is initialized; use workgraph_plan set first.");
    if (Object.keys(input.patch).length === 0)
      return contractFailure(
        "A TODO update requires at least one changed field; no changes were made.",
      );
    const index = this.todos.findIndex((todo) => todo.id === input.id);
    if (index < 0) return contractFailure(`Unknown TODO id: ${input.id}. No changes were made.`);
    const current = this.todos[index];
    if (current === undefined) return contractFailure(`Unknown TODO id: ${input.id}.`);
    const next = this.todos.map((todo, todoIndex) =>
      todoIndex === index ? { ...todo, ...input.patch } : { ...todo },
    );
    this.todos = next;
    return Effect.succeed(this.result("update"));
  }

  text(): string {
    if (this.todos === undefined) return "Current TODO: not initialized.";
    return [
      "Current TODO (navigation only; status is not completion evidence):",
      ...this.todos.map(
        (todo) =>
          `${todo.id} ${todo.status}: ${todo.text} | validate: ${todo.validation}${todo.note === undefined ? "" : ` | ${todo.note}`}`,
      ),
    ].join("\n");
  }

  hasActionableItems(): boolean {
    return (
      this.todos?.some((todo) => todo.status === "pending" || todo.status === "in_progress") ??
      false
    );
  }

  private result(action: "get" | "set" | "update"): WorkerPlanToolResult {
    const details: WorkerPlanToolResult["details"] = { action, attempt: this.identity };
    if (this.todos !== undefined) details.todos = structuredClone(this.todos);
    return { content: [{ type: "text", text: this.text() }], details };
  }
}
