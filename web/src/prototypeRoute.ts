export type PrototypeName = "time-picker" | "batch-run";

const PROTOTYPES = new Set<PrototypeName>(["time-picker", "batch-run"]);
const PROTOTYPE_PARAMS = ["prototype", "variant", "runId"] as const;

export function resolvePrototype(search: string, isDev: boolean): PrototypeName | null {
  if (!isDev) return null;
  const candidate = new URLSearchParams(search).get("prototype");
  return PROTOTYPES.has(candidate as PrototypeName) ? (candidate as PrototypeName) : null;
}

export function prototypeExitUrl(href: string): string {
  const url = new URL(href);
  for (const param of PROTOTYPE_PARAMS) url.searchParams.delete(param);
  return url.toString();
}
