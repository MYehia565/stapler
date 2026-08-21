export type HostExecutionFields = {
  model?: unknown;
  systemPrompt?: unknown;
  cwd?: unknown;
};

function asHost(
  ctx: object,
): HostExecutionFields {
  return ctx as HostExecutionFields;
}

export function hostModel(ctx: object): string {
  const value = asHost(ctx).model;
  return typeof value === "string" ? value.trim() : "";
}

export function hostSystemPrompt(ctx: object): string {
  const value = asHost(ctx).systemPrompt;
  return typeof value === "string" ? value.trim() : "";
}

export function hostCwd(ctx: object): string {
  const value = asHost(ctx).cwd;
  return typeof value === "string" ? value.trim() : "";
}
