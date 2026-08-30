import type { PrototypeName } from "./prototypeRoute";

type RootLoaders<T> = {
  app: () => Promise<T>;
  timePicker: () => Promise<T>;
  batchRun: () => Promise<T>;
};

export async function loadApplicationRoot<T>(
  prototype: PrototypeName | null,
  loaders: RootLoaders<T>,
): Promise<T> {
  if (prototype === "time-picker") return loaders.timePicker();
  if (prototype === "batch-run") return loaders.batchRun();
  return loaders.app();
}
