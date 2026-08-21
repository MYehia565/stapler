import {
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  slotApiKey,
  type StaplerSlot,
} from "./providers.js";
import {
  fetchWithTimeout,
  MODEL_DISCOVERY_TIMEOUT_MS,
} from "./http.js";

export interface StaplerModel {
  id: string;
  label: string;
  [key: string]: unknown;
}

function uniqueByModelId(models: StaplerModel[]): StaplerModel[] {
  const seen = new Set<string>();
  const unique: StaplerModel[] = [];

  for (const model of models) {
    if (seen.has(model.id)) {
      continue;
    }

    seen.add(model.id);
    unique.push(model);
  }

  return unique;
}

function normalizeModel(item: unknown): StaplerModel | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const value = item as Record<string, unknown>;

  const id = String(
    value.id ??
      value.name ??
      value.model ??
      "",
  ).trim();

  if (!id) {
    return null;
  }

  const label = String(
    value.label ??
      value.display_name ??
      value.displayName ??
      value.name ??
      id,
  ).trim();

  return {
    ...value,
    id,
    label: label || id,
  };
}

function extractModels(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const value = payload as Record<string, unknown>;

  if (Array.isArray(value.data)) {
    return value.data;
  }

  if (Array.isArray(value.models)) {
    return value.models;
  }

  if (Array.isArray(value.results)) {
    return value.results;
  }

  return [];
}

function sortModels(models: StaplerModel[]): StaplerModel[] {
  return [...models].sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

export async function discoverModels(
  baseUrl: string,
  headers: Record<string, string> = {},
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<StaplerModel[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...headers,
    },
    timeoutMs:
      options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS,
    label: `Provider model discovery (${url})`,
    signal: options.signal,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Model discovery failed: HTTP ${response.status} ${response.statusText}: ${text.slice(0, 2000)}`,
    );
  }

  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Model discovery returned invalid JSON: ${text.slice(0, 2000)}`,
    );
  }

  return sortModels(
    uniqueByModelId(
      extractModels(payload)
        .map(normalizeModel)
        .filter((model): model is StaplerModel => model !== null),
    ),
  );
}

export async function discoverModelsForSlot(
  slot: StaplerSlot,
  config: Record<string, unknown> = {},
): Promise<StaplerModel[]> {
  const apiKey = slotApiKey(slot, config);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return discoverModels(slot.baseUrl, headers);
}

/**
 * Compatibility wrapper used by the execution and test layers.
 */
export async function listStaplerModels(
  configOrBaseUrl:
    | Record<string, unknown>
    | string,
): Promise<StaplerModel[]> {
  if (typeof configOrBaseUrl === "string") {
    return discoverModels(configOrBaseUrl);
  }

  const config = configOrBaseUrl;
  const baseUrl = resolveProviderBaseUrl(config);
  const apiKey = resolveProviderApiKey(config);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return discoverModels(baseUrl, headers);
}

/**
 * Resolve adapter-level aliases to actual provider models.
 *
 * The exact model names exposed by a provider may change. We therefore use
 * deterministic keyword matching rather than hard-coding a model that may
 * disappear.
 */
export function resolveProfileModel(
  profile: string,
  models: StaplerModel[],
): string {
  const requested = profile.trim().toLowerCase();

  if (!models.length) {
    return "";
  }

  const exact =
    models.find(
      (model) =>
        model.id.toLowerCase() === requested,
    );

  if (exact) {
    return exact.id;
  }

  const find = (patterns: RegExp[]): StaplerModel | undefined =>
    models.find((model) => {
      const value = `${model.id} ${model.label}`.toLowerCase();
      return patterns.some((pattern) => pattern.test(value));
    });

  let selected: StaplerModel | undefined;

  switch (requested) {
    case "cheap":
      selected =
        find([
          /cheap/,
          /mini/,
          /small/,
          /flash/,
          /lite/,
        ]) ?? models[0];
      break;

    case "fast":
      selected =
        find([
          /fast/,
          /flash/,
          /turbo/,
          /speed/,
          /instant/,
        ]) ?? models[0];
      break;

    case "reasoning":
      selected =
        find([
          /reason/,
          /thinking/,
          /o[1-9]/,
          /o[0-9]/,
        ]) ??
        models[models.length - 1];
      break;

    case "standard":
    default:
      selected =
        find([
          /standard/,
          /\bpro\b/,
          /\blarge\b/,
          /\bmedium\b/,
        ]) ?? models[0];
      break;
  }

  return selected?.id ?? models[0]?.id ?? "";
}
