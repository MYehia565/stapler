import type {
  AdapterModel,
  AdapterModelProfileDefinition,
} from "@paperclipai/adapter-utils";

export const type =
  "stapler";

export const label =
  "Stapler";

export const models: AdapterModel[] = [
  {
    id: "standard",
    label: "Standard",
  },
  {
    id: "fast",
    label: "Fast",
  },
  {
    id: "reasoning",
    label: "Reasoning",
  },
  {
    id: "cheap",
    label: "Cheap",
  },
];

export const modelProfiles:
AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description:
      "Use the active slot's cost-efficient model lane while preserving the primary model.",
    adapterConfig: {
      model: "cheap",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# Stapler agent configuration

Adapter: stapler (universal OpenAI-compatible gateway)

Server env (Paperclip process — restart after changes):
- STAPLER_WEB_URL_1 + STAPLER_API_KEY_1 … up to _16 (or STAPLER_WEB_URL_n / STAPLER_API_KEY_n without underscore)
- STAPLER_EXTRA_n optional JSON merged into /chat/completions for that slot
- STAPLER_PROVIDER optional Detect preference (slot id from URL hostname)
- STAPLER_MODEL optional global model override

Core fields:
- provider (select): extracted slot id (openai, groq, openrouter, …) — drives runs and environment test
- model (string, optional, default standard): profile alias, bare id, or slot::model prefix
- baseUrl (string, optional, default empty): leave empty to follow the selected slot
- cwd, instructionsFilePath, promptTemplate, temperature, maxTokens, maxToolRounds, extraBody, paperclipApiUrl, timeoutSec, runTimeoutSec
- env (object, optional): bind STAPLER_API_KEY_n via Paperclip Secret access
- extraBody (JSON, optional): merged after STAPLER_EXTRA_n; cannot set model, messages, or tools

Model discovery:
- listModels / refreshModels union every configured slot (prefixed ids when multiple slots exist)
- detectModel uses STAPLER_PROVIDER + STAPLER_MODEL; global hooks receive no agent config

Capabilities:
- supportsInstructionsBundle, supportsSkills (ephemeral), supportsLocalAgentJwt (Tool Gateway)

Tool availability, workspace tools, and issue disposition are part of the Stapler runtime.
`;
