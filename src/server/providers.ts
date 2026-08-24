import {
  asString,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

export const MAX_STAPLER_SLOTS = 16;

export interface StaplerSlot {
  index: number;
  id: string;
  label: string;
  baseUrl: string;
  webUrlEnv: string;
  apiKeyEnv: string;
  extraEnv: string;
}

export type SlotSelectionSource =
  | "model prefix"
  | "agent config"
  | "STAPLER_PROVIDER"
  | "first configured slot";

function environment(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return parseObject(config.env);
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isIpHost(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return true;
  }

  return hostname.includes(":");
}

/**
 * Leading labels that name the gateway, not the provider brand.
 * Stripped from the left only (e.g. api.openai.com → openai.com).
 */
const GENERIC_HOST_PREFIXES = new Set([
  "www",
  "api",
  "apis",
  "gateway",
  "proxy",
  "openai",
  "compatible",
  "compat",
  "v1",
  "v2",
  "v3",
]);

/**
 * Multi-label public suffixes where the brand is the label before the whole
 * suffix (example.co.uk → example, not co).
 */
const MULTI_PART_PUBLIC_SUFFIXES = [
  "co.uk",
  "com.au",
  "com.br",
  "com.cn",
  "com.mx",
  "com.tw",
  "co.jp",
  "co.in",
  "co.kr",
  "co.nz",
  "co.za",
  "com.sg",
  "org.uk",
  "net.au",
  "ac.uk",
  "gov.uk",
] as const;

function sanitizeProviderId(value: string): string {
  const parts = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const joined = parts.join("-").slice(0, 32);

  return joined || "";
}

function stripGenericHostPrefixes(hostname: string): string {
  const labels = hostname.split(".").filter(Boolean);

  while (
    labels.length > 2 &&
    GENERIC_HOST_PREFIXES.has(labels[0]!)
  ) {
    labels.shift();
  }

  // Still strip a single leading www/api even on two-label hosts
  // (api.openai.com → openai.com; www.x.ai → x.ai).
  while (
    labels.length >= 2 &&
    (labels[0] === "www" || labels[0] === "api" || labels[0] === "apis")
  ) {
    labels.shift();
  }

  return labels.join(".");
}

function publicSuffixLength(labels: string[]): number {
  if (labels.length < 2) {
    return Math.min(labels.length, 1);
  }

  const host = labels.join(".");

  for (const suffix of MULTI_PART_PUBLIC_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return suffix.split(".").length;
    }
  }

  return 1;
}

/**
 * Brand label immediately before the public suffix
 * (openai.com → openai, openrouter.ai → openrouter, foo.co.uk → foo).
 * Very short brands (x.ai → x) are joined with the TLD (xai) so the slot
 * id stays recognizable in the UI.
 */
function brandFromHostLabels(labels: string[]): string {
  if (labels.length === 0) {
    return "";
  }

  if (labels.length === 1) {
    return labels[0]!;
  }

  const suffixLen = publicSuffixLength(labels);
  const brandIndex = labels.length - suffixLen - 1;

  if (brandIndex < 0) {
    return labels[0]!;
  }

  const brand = labels[brandIndex]!;
  const tld = labels[brandIndex + 1] ?? "";

  if (brand.length <= 2 && tld && /^[a-z]+$/i.test(tld)) {
    return `${brand}${tld}`;
  }

  return brand;
}

/**
 * Derive a stable provider id from an OpenAI-compatible base URL hostname.
 * Prefer the registrable brand (label before .com / .net / .ai / …).
 */
export function providerNameFromWebUrl(
  webUrl: string,
  slotIndex = 1,
): string {
  let hostname = "";

  try {
    hostname = new URL(webUrl.trim()).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return `slot${slotIndex}`;
  }

  if (!hostname || isIpHost(hostname)) {
    return `slot${slotIndex}`;
  }

  const stripped = stripGenericHostPrefixes(hostname);
  const labels = stripped.split(".").filter(Boolean);
  const brand = brandFromHostLabels(labels);

  return sanitizeProviderId(brand) || `slot${slotIndex}`;
}

function readBinding(
  envNames: string[],
  configEnv: Record<string, unknown>,
): string {
  for (const name of envNames) {
    const fromConfig = asString(configEnv[name], "").trim();

    if (fromConfig) {
      return fromConfig;
    }

    const fromProcess = process.env[name]?.trim();

    if (fromProcess) {
      return fromProcess;
    }
  }

  return "";
}

function slotEnvNames(index: number): {
  webUrl: string[];
  apiKey: string[];
  extra: string[];
} {
  if (index === 0) {
    return {
      webUrl: ["STAPLER_WEB_URL"],
      apiKey: ["STAPLER_API_KEY"],
      extra: ["STAPLER_EXTRA"],
    };
  }

  const n = String(index);

  return {
    webUrl: [`STAPLER_WEB_URL_${n}`, `STAPLER_WEB_URL${n}`],
    apiKey: [`STAPLER_API_KEY_${n}`, `STAPLER_API_KEY${n}`],
    extra: [`STAPLER_EXTRA_${n}`, `STAPLER_EXTRA${n}`],
  };
}

function assignUniqueProviderId(
  baseId: string,
  used: Set<string>,
): string {
  if (!used.has(baseId)) {
    used.add(baseId);
    return baseId;
  }

  for (let suffix = 2; suffix <= MAX_STAPLER_SLOTS + 1; suffix += 1) {
    const candidate = `${baseId}-${suffix}`.slice(0, 32);

    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  const fallback = `${baseId}-${used.size + 1}`.slice(0, 32);
  used.add(fallback);

  return fallback;
}

/**
 * Scan numbered Stapler slots from process env and optional config.env bindings.
 */
export function discoverStaplerSlots(
  config: Record<string, unknown> = {},
): StaplerSlot[] {
  const configEnv = environment(config);
  const slots: StaplerSlot[] = [];
  const usedIds = new Set<string>();

  for (let index = 1; index <= MAX_STAPLER_SLOTS; index += 1) {
    const names = slotEnvNames(index);
    const webUrl = readBinding(names.webUrl, configEnv);
    const apiKey = readBinding(names.apiKey, configEnv);

    if (!webUrl || !apiKey) {
      continue;
    }

    const baseId = providerNameFromWebUrl(webUrl, index);
    const id = assignUniqueProviderId(baseId, usedIds);

    slots.push({
      index,
      id,
      label: id,
      baseUrl: normalizeBaseUrl(webUrl),
      webUrlEnv: names.webUrl[0]!,
      apiKeyEnv: names.apiKey[0]!,
      extraEnv: names.extra[0]!,
    });
  }

  const hasNumberedOne = slots.some((slot) => slot.index === 1);

  if (!hasNumberedOne) {
    const names = slotEnvNames(0);
    const webUrl = readBinding(names.webUrl, configEnv);
    const apiKey = readBinding(names.apiKey, configEnv);

    if (webUrl && apiKey) {
      const baseId = providerNameFromWebUrl(webUrl, 1);
      const id = assignUniqueProviderId(baseId, usedIds);

      slots.unshift({
        index: 1,
        id,
        label: id,
        baseUrl: normalizeBaseUrl(webUrl),
        webUrlEnv: names.webUrl[0]!,
        apiKeyEnv: names.apiKey[0]!,
        extraEnv: names.extra[0]!,
      });
    }
  }

  return slots.sort((a, b) => a.index - b.index);
}

export function parsePrefixedModelId(modelId: string): {
  providerId: string | null;
  bareModelId: string;
} {
  const trimmed = modelId.trim();
  const separator = trimmed.indexOf("::");

  if (separator <= 0 || separator >= trimmed.length - 2) {
    return {
      providerId: null,
      bareModelId: trimmed,
    };
  }

  return {
    providerId: trimmed.slice(0, separator).trim().toLowerCase(),
    bareModelId: trimmed.slice(separator + 2).trim(),
  };
}

function findSlotById(
  slots: StaplerSlot[],
  providerId: string,
): StaplerSlot | undefined {
  const normalized = providerId.trim().toLowerCase();

  return slots.find(
    (slot) => slot.id.toLowerCase() === normalized,
  );
}

function configuredModelId(
  config: Record<string, unknown>,
  runtime: Record<string, unknown> = {},
): string {
  return (
    asString(config.model, "").trim() ||
    asString(runtime.model, "").trim() ||
    process.env.STAPLER_MODEL?.trim() ||
    ""
  );
}

function configuredProviderId(
  config: Record<string, unknown>,
): string {
  return asString(config.provider, "").trim().toLowerCase();
}

function preferredProviderFromEnv(
  slots: StaplerSlot[],
): string {
  const preferred = (process.env.STAPLER_PROVIDER ?? "")
    .trim()
    .toLowerCase();

  if (preferred && findSlotById(slots, preferred)) {
    return preferred;
  }

  return "";
}

export function resolveActiveSlot(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): {
  slot: StaplerSlot | null;
  bareModelId: string;
  source: SlotSelectionSource;
} {
  const slots = discoverStaplerSlots(config);

  if (!slots.length) {
    return {
      slot: null,
      bareModelId: configuredModelId(config, runtime),
      source: "first configured slot",
    };
  }

  const modelId = configuredModelId(config, runtime);
  const prefixed = parsePrefixedModelId(modelId);

  if (prefixed.providerId) {
    const slot = findSlotById(slots, prefixed.providerId);

    if (slot) {
      return {
        slot,
        bareModelId: prefixed.bareModelId,
        source: "model prefix",
      };
    }
  }

  const fromConfig = configuredProviderId(config);

  if (fromConfig) {
    const slot = findSlotById(slots, fromConfig);

    if (slot) {
      return {
        slot,
        bareModelId: prefixed.bareModelId || modelId,
        source: "agent config",
      };
    }
  }

  const fromEnv = preferredProviderFromEnv(slots);

  if (fromEnv) {
    const slot = findSlotById(slots, fromEnv);

    if (slot) {
      return {
        slot,
        bareModelId: prefixed.bareModelId || modelId,
        source: "STAPLER_PROVIDER",
      };
    }
  }

  return {
    slot: slots[0]!,
    bareModelId: prefixed.bareModelId || modelId,
    source: "first configured slot",
  };
}

function isStaleOtherSlotPreset(
  url: string,
  activeSlot: StaplerSlot,
  slots: StaplerSlot[],
): boolean {
  const normalized = normalizeBaseUrl(url).toLowerCase();

  return slots.some(
    (slot) =>
      slot.id !== activeSlot.id &&
      slot.baseUrl.toLowerCase() === normalized,
  );
}

export function resolveProviderId(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): string {
  return resolveActiveSlot(config, runtime).slot?.id ?? "";
}

export function resolveProviderIdSource(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): SlotSelectionSource {
  return resolveActiveSlot(config, runtime).source;
}

export function getActiveSlot(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): StaplerSlot | null {
  return resolveActiveSlot(config, runtime).slot;
}

export function resolveProviderLabel(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): string {
  return getActiveSlot(config, runtime)?.label ?? "Stapler";
}

export function resolveProviderBaseUrl(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): string {
  const { slot } = resolveActiveSlot(config, runtime);

  if (!slot) {
    return "";
  }

  const slots = discoverStaplerSlots(config);
  const configured = asString(config.baseUrl, "").trim();

  if (
    configured &&
    !isStaleOtherSlotPreset(configured, slot, slots)
  ) {
    return normalizeBaseUrl(configured);
  }

  const runtimeUrl = asString(runtime.baseUrl, "").trim();

  if (
    runtimeUrl &&
    !isStaleOtherSlotPreset(runtimeUrl, slot, slots)
  ) {
    return normalizeBaseUrl(runtimeUrl);
  }

  return slot.baseUrl;
}

export function resolveProviderApiKey(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): string {
  const slot = getActiveSlot(config, runtime);

  if (!slot) {
    return "";
  }

  const configEnv = environment(config);

  return (
    readBinding([slot.apiKeyEnv], configEnv)
  );
}

function parseJsonObjectText(raw: string): {
  extra: Record<string, unknown>;
  error: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return {
        extra: parsed as Record<string, unknown>,
        error: null,
      };
    }
  } catch {
    return {
      extra: {},
      error: "invalid JSON",
    };
  }

  return {
    extra: {},
    error: "not an object",
  };
}

export function parseSlotExtra(
  slot: StaplerSlot,
  config: Record<string, unknown> = {},
): {
  extra: Record<string, unknown>;
  error: string | null;
} {
  const configEnv = environment(config);
  const raw = readBinding([slot.extraEnv], configEnv);

  if (!raw) {
    return { extra: {}, error: null };
  }

  return parseJsonObjectText(raw);
}

export function slotExtraValidationErrors(
  config: Record<string, unknown> = {},
): string[] {
  return discoverStaplerSlots(config).flatMap((slot) => {
    const parsed = parseSlotExtra(slot, config);

    if (!parsed.error) {
      return [];
    }

    return [
      `${slot.extraEnv} must be a JSON object.`,
    ];
  });
}

export function resolveSlotExtra(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): Record<string, unknown> {
  const slot = getActiveSlot(config, runtime);

  if (!slot) {
    return {};
  }

  return parseSlotExtra(slot, config).extra;
}

export function providerApiKeyEnvName(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): string {
  return getActiveSlot(config, runtime)?.apiKeyEnv ?? "STAPLER_API_KEY_1";
}

export function isValidProviderId(
  value: unknown,
  config: Record<string, unknown> = {},
): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  return Boolean(
    findSlotById(
      discoverStaplerSlots(config),
      value,
    ),
  );
}

export function resolveBareModelId(
  config: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): string {
  return resolveActiveSlot(config, runtime).bareModelId;
}

export function slotApiKey(
  slot: StaplerSlot,
  config: Record<string, unknown> = {},
): string {
  const configEnv = environment(config);

  return readBinding([slot.apiKeyEnv], configEnv);
}
