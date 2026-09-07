import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, type FileSystem, Layer, type Path } from "effect";

const nodeFileSystemPathLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

/** Live Node providers for Effect's public platform services. */
export const liveLayer = Layer.merge(
  nodeFileSystemPathLayer,
  NodeChildProcessSpawner.layer.pipe(Layer.provide(nodeFileSystemPathLayer)),
);

/** Promise boundary for host callers that do not yet run inside an Effect runtime. */
export function runNodePlatformPromise<A, E>(
  operation: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(operation, liveLayer));
}
