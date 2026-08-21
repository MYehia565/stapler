# Implementation Plan: Stapler 1.0.0

Spec: [docs/stapler-spec.md](../docs/stapler-spec.md)

Shipped as the first public release. Architecture:

| Decision | Rationale |
| --- | --- |
| Slot discovery from `STAPLER_WEB_URL_n` + `STAPLER_API_KEY_n` | Any OpenAI-compatible host without a code change |
| `providerNameFromWebUrl()` extracts slot ids from hostnames | Stable ids for schema, logs, and `provider::model` prefixes |
| `listModels` / `detectModel` union all slots | Host hooks receive no agent config |
| Prefixed model ids only when `slots.length > 1` | Single-slot setups keep bare ids |
| Active slot: `model::prefix` → `config.provider` → `STAPLER_PROVIDER` → lowest index | Execute/test follow agent config; Detect uses env preference |
| Adapter `type: stapler`, package `name: stapler` | Public product identity |
