import { Effect, type FileSystem, type Path } from "effect";
import {
  HerdrProtocolError,
  type VisibleWorkerRuntime,
  type WorkerLaunchEffectRequest,
  type WorkerLaunchRequest,
} from "../src/herdr.js";
import { liveLayer } from "../src/node-platform.js";
import type { WorkstreamStoreError } from "../src/workstream.js";
import type { RuntimeHerdrEffects } from "../src/workstream-runtime-services.js";

export function promiseWorkerEffects(worker: VisibleWorkerRuntime): RuntimeHerdrEffects {
  const attempt = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new HerdrProtocolError({
          operation,
          reason: "process",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  const runCheckpoint = (
    effect: Effect.Effect<void, WorkstreamStoreError, FileSystem.FileSystem | Path.Path>,
  ) => Effect.runPromise(Effect.provide(effect, liveLayer));
  return {
    launch: (
      request: WorkerLaunchEffectRequest<WorkstreamStoreError, FileSystem.FileSystem | Path.Path>,
    ) => {
      const { onTab, onResource, onIdentity, onSubmitted, ...base } = request;
      const adapted: WorkerLaunchRequest = { ...base };
      if (onTab !== undefined) adapted.onTab = (value) => runCheckpoint(onTab(value));
      if (onResource !== undefined)
        adapted.onResource = (value) => runCheckpoint(onResource(value));
      if (onIdentity !== undefined)
        adapted.onIdentity = (value) => runCheckpoint(onIdentity(value));
      if (onSubmitted !== undefined) adapted.onSubmitted = () => runCheckpoint(onSubmitted());
      return attempt("launch fixture worker", () => worker.launch(adapted));
    },
    recover: (request) =>
      attempt(
        "recover fixture worker",
        () => worker.recover?.(request) ?? Promise.resolve(undefined),
      ),
    inspectLaunch: (request) =>
      attempt(
        "inspect fixture launch",
        () => worker.inspectLaunch?.(request) ?? Promise.reject(new Error("No launch inspection.")),
      ),
    inspect: (identity) => attempt("inspect fixture worker", () => worker.inspect(identity)),
    observe: (identity) => attempt("observe fixture worker", () => worker.observe(identity)),
    interrupt: (identity) => attempt("interrupt fixture worker", () => worker.interrupt(identity)),
    steer: (identity, instruction) =>
      attempt(
        "steer fixture worker",
        () => worker.steer?.(identity, instruction) ?? Promise.resolve(),
      ),
    cleanup: (identity) =>
      attempt(
        "cleanup fixture worker",
        () => worker.cleanup?.(identity) ?? Promise.reject(new Error("No cleanup.")),
      ),
  };
}
