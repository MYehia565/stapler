import type {
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";

import {
  agentConfigurationDoc,
  modelProfiles,
  models,
  type,
} from "../metadata.js";
import {
  getConfigSchema,
} from "./config-schema.js";
import {
  execute,
} from "./execute.js";
import {
  discoverModelsForSlot,
  resolveProfileModel,
} from "./models.js";
import {
  discoverStaplerSlots,
  resolveActiveSlot,
  resolveProviderIdSource,
  slotApiKey,
} from "./providers.js";
import {
  listStaplerSkills,
  syncStaplerSkills,
} from "./skills.js";
import {
  testEnvironment,
} from "./test.js";

async function discoverUnionModels(): Promise<AdapterModel[]> {
  const slots = discoverStaplerSlots({});

  if (!slots.length) {
    return models;
  }

  const multiSlot = slots.length > 1;
  const union: AdapterModel[] = [];
  let succeeded = 0;

  const results = await Promise.allSettled(
    slots.map(async (slot) => {
      const key = slotApiKey(slot, {});

      if (!key) {
        throw new Error(
          `Slot ${slot.id} is missing ${slot.apiKeyEnv}.`,
        );
      }

      const discovered = await discoverModelsForSlot(slot, {});

      return discovered.map((entry) => ({
        id: multiSlot
          ? `${slot.id}::${entry.id}`
          : entry.id,
        label: multiSlot
          ? `${slot.label} / ${entry.label}`
          : entry.label,
      }));
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      succeeded += 1;
      union.push(...result.value);
    }
  }

  if (!union.length && succeeded === 0) {
    return models;
  }

  return union.sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates: string[];
} | null> {
  const slots = discoverStaplerSlots({});

  if (!slots.some((slot) => slotApiKey(slot, {}))) {
    return null;
  }

  let union: AdapterModel[];

  try {
    union = await discoverUnionModels();
  } catch {
    return null;
  }

  if (!union.length) {
    return null;
  }

  const configured =
    process.env.STAPLER_MODEL?.trim();
  const { slot } = resolveActiveSlot({});
  const preferredProvider = slot?.id ?? slots[0]!.id;
  const selection = resolveProviderIdSource({});

  const slotModels = union.filter((entry) =>
    entry.id.includes("::")
      ? entry.id.startsWith(`${preferredProvider}::`)
      : true,
  );

  const catalogue = slotModels.length
    ? slotModels
    : union;

  const bareCandidates = catalogue.map((entry) => entry.id);

  const model = configured ||
    resolveProfileModel(
      "standard",
      catalogue.map((entry) => ({
        id: entry.id.includes("::")
          ? entry.id.slice(entry.id.indexOf("::") + 2)
          : entry.id,
        label: entry.label,
      })),
    ) ||
    catalogue[0]?.id ||
    "";

  const prefixedModel =
    slots.length > 1 &&
    model &&
    !model.includes("::") &&
    slot
      ? `${slot.id}::${model}`
      : model;

  const queried = slots.length;
  const slotSuffix =
    queried > 1
      ? ` (${queried} slots configured)`
      : "";

  return {
    model: prefixedModel,
    provider: preferredProvider,
    source: configured
      ? `STAPLER_MODEL environment variable (provider from ${selection})${slotSuffix}`
      : `Stapler /models union (provider from ${selection})${slotSuffix}`,
    candidates: bareCandidates,
  };
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    models,
    modelProfiles,
    agentConfigurationDoc,
    execute,
    testEnvironment,
    getConfigSchema,
    listModels: discoverUnionModels,
    refreshModels: discoverUnionModels,
    detectModel,
    listSkills: listStaplerSkills,
    syncSkills: syncStaplerSkills,
    supportsInstructionsBundle: true,
    supportsLocalAgentJwt: true,
    instructionsPathKey: "instructionsFilePath",
  };
}
