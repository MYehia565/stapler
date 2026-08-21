import type {
  AdapterConfigSchema,
} from "@paperclipai/adapter-utils";

import {
  DEFAULT_PAPERCLIP_API_URL,
  DEFAULT_REQUEST_TIMEOUT_SEC,
  DEFAULT_RUN_TIMEOUT_SEC,
  MAX_REQUEST_TIMEOUT_SEC,
  MAX_RUN_TIMEOUT_SEC,
  MIN_REQUEST_TIMEOUT_SEC,
  MIN_RUN_TIMEOUT_SEC,
} from "./config.js";
import {
  discoverStaplerSlots,
} from "./providers.js";

export function getConfigSchema(): AdapterConfigSchema {
  const slots = discoverStaplerSlots({});
  const defaultProvider = slots[0]?.id ?? "";

  return {
    fields: [
      {
        key: "provider",
        label: "LLM provider",
        type: "select",
        default: defaultProvider,
        required: slots.length > 0,
        group: "Connection",
        options: slots.map((slot) => ({
          label: slot.label,
          value: slot.id,
        })),
        hint: slots.length
          ? "Drives agent runs and the environment test. Configure hosts on the Paperclip server with STAPLER_WEB_URL_n and STAPLER_API_KEY_n, then restart. Models / Detect list every configured slot; prefix a model with name:: to pin the slot."
          : "No Stapler slots found in process env. Bind STAPLER_WEB_URL_1 and STAPLER_API_KEY_1 (or numbered pairs up to 16) on the Paperclip server, then restart.",
      },
      {
        key: "baseUrl",
        label: "API base URL override",
        type: "combobox",
        default: "",
        group: "Connection",
        options: slots.map((slot) => ({
          label: `${slot.label} — ${slot.baseUrl}`,
          value: slot.baseUrl,
        })),
        hint:
          "Leave empty to follow the selected provider slot. Set a value only for a custom proxy. A leftover URL from another slot is ignored automatically.",
      },
      {
        key: "cwd",
        label: "Fallback workspace directory",
        type: "text",
        group: "Connection",
        hint:
          "Optional fallback when Paperclip has not realized a workspace for this run. Local tools remain sandboxed to the resolved root.",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file path",
        type: "text",
        group: "Generation",
        hint:
          "Path to a managed instructions bundle (AGENTS.md). Paperclip's instructions editor writes this key when supportsInstructionsBundle is enabled.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        group: "Generation",
        hint:
          "Optional template prepended to the deterministic Paperclip execution context.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        group: "Generation",
        hint:
          "Optional sampling temperature from 0 through 2. Leave empty to use the upstream model default.",
        meta: {
          min: 0,
          max: 2,
          step: 0.1,
        },
      },
      {
        key: "maxTokens",
        label: "Max output tokens",
        type: "number",
        group: "Generation",
        hint:
          "Optional positive output-token limit. The adapter caps this value at 200,000.",
        meta: {
          min: 1,
          max: 200000,
          step: 1,
        },
      },
      {
        key: "maxToolRounds",
        label: "Max tool rounds",
        type: "number",
        default: 8,
        group: "Tools",
        hint:
          "Maximum LLM function-call rounds for one run (1–20).",
        meta: {
          min: 1,
          max: 20,
          step: 1,
        },
      },
      {
        key: "timeoutSec",
        label: "Request timeout (seconds)",
        type: "number",
        default: DEFAULT_REQUEST_TIMEOUT_SEC,
        group: "Tools",
        hint:
          "Deadline for a single /chat/completions request. Each tool round gets its own deadline.",
        meta: {
          min: MIN_REQUEST_TIMEOUT_SEC,
          max: MAX_REQUEST_TIMEOUT_SEC,
          step: 5,
        },
      },
      {
        key: "runTimeoutSec",
        label: "Run timeout (seconds)",
        type: "number",
        default: DEFAULT_RUN_TIMEOUT_SEC,
        group: "Tools",
        hint:
          "Wall-clock budget for the whole run: every tool round plus the tool execution between them. Raise this for long multi-step tasks.",
        meta: {
          min: MIN_RUN_TIMEOUT_SEC,
          max: MAX_RUN_TIMEOUT_SEC,
          step: 30,
        },
      },
      {
        key: "extraBody",
        label: "Extra request body (JSON)",
        type: "textarea",
        group: "Advanced",
        hint:
          "Optional JSON object merged into /chat/completions after the slot STAPLER_EXTRA_n object. Cannot override model, messages, or tools.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        default: DEFAULT_PAPERCLIP_API_URL,
        group: "Advanced",
        hint:
          "Paperclip server used to create governed Tool Gateway sessions. Defaults to the public Signalpost API.",
      },
    ],
  };
}
