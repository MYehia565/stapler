# Stapler

[![CI](https://github.com/MYehia565/stapler/actions/workflows/ci.yml/badge.svg)](https://github.com/MYehia565/stapler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**Bring any OpenAI-compatible provider to Paperclip. Your keys. Your models. Your infrastructure.**

[Paperclip](https://github.com/paperclipai/paperclip) gives teams an agent orchestration layer. Stapler expands the provider choices available to those agents: configure your own OpenAI-compatible API endpoints and credentials, then select the provider and model you want each agent to use.

Paperclip already supports bring-your-own credentials for its built-in provider integrations. **Stapler takes that flexibility further** by letting operators connect compatible endpoints without waiting for each provider to become a dedicated built-in integration.

With up to **16 provider slots**, a combined model catalogue, and requests sent directly to the selected endpoint, Stapler keeps provider choice in your hands. Your provider account and billing relationship remain yours; Stapler is an adapter, not a hosted inference service.

**Current version:** 1.3.1 · [Adapter specification](./docs/stapler-spec.md) · [Changelog](./CHANGELOG.md) · [Report a bug](https://github.com/MYehia565/stapler/issues/new?template=bug_report.md)

---

## Why Stapler exists

Paperclip's built-in provider integrations and BYOK support are useful—but they are not the same as being able to point an agent at any OpenAI-compatible endpoint. Stapler closes that gap.

- **Bring your own endpoint and key:** connect the compatible API you already use or operate.
- **Avoid provider-by-provider adapter work:** configure a new compatible endpoint through environment variables instead of adding another vendor integration to Stapler.
- **Keep provider choice flexible:** use up to **16** configured endpoint/key pairs in one adapter.
- **Choose from one model catalogue:** discover models across configured providers and select the provider/model combination that fits each agent.
- **Keep the provider relationship yours:** requests go directly to the endpoint you configure; Stapler does not proxy inference through its own hosted service.
- **Stay in the Paperclip workflow:** Stapler uses Paperclip's adapter model and supports its Tool Gateway / MCP integration when host authentication is available, plus Paperclip issue tools.

**In short:** Paperclip orchestrates the work. Stapler broadens the models and compatible providers your agents can use.

## Features

- Up to **16 provider slots** via `STAPLER_WEB_URL_n` + `STAPLER_API_KEY_n`
- Union model discovery across configured slots
- Provider-prefixed model IDs when multiple slots exist (`openai::gpt-4o`, `groq::llama-3.3-70b`)
- Workspace file/search tools: `list_dir`, `read_file`, `write_file`, `str_replace`, `delete_file`, `move_file`, `grep_search`, `glob_files`, `http_fetch`, `web_search`, and `exec_command`
- Default **1000** tool rounds with configurable **loop protection** (`off`, `advisory`, `balanced`, `strict`, or custom thresholds)
- Default run timeout **7200s** (raise further for very long jobs)
- Paperclip Tool Gateway + MCP when host auth is available
- Issue tools: `paperclip_checkout_issue`, `paperclip_update_issue`, `paperclip_add_comment`, `paperclip_create_issue`, `paperclip_get_issue`, `paperclip_list_my_issues`, `paperclip_list_agents`
- Bundled **stapler** operating skill injected on every run (handoffs + structured mentions)

---

## Quick start

You need a running Paperclip instance, Node.js 20 or newer, and an API key for at least one provider with an OpenAI-compatible API. Stapler is an adapter, not a model host; provider usage may incur charges.

### 1. Configure provider keys on the Paperclip host

Restart Paperclip after setting these on the **server process**:

```bash
# Slot 1 — example: OpenAI
STAPLER_WEB_URL_1=https://api.openai.com/v1
STAPLER_API_KEY_1=sk-...

# Slot 2 — example: Groq
STAPLER_WEB_URL_2=https://api.groq.com/openai/v1
STAPLER_API_KEY_2=gsk_...

# Optional: prefer a slot for global Detect
STAPLER_PROVIDER=groq
STAPLER_MODEL=llama-3.3-70b-versatile
```

Set these variables in the Paperclip server environment or bind them through Paperclip **Secret access** using the same variable names. Do not commit keys, put them in screenshots, or paste them into issues.

### 2. Build and install the adapter

```bash
git clone https://github.com/MYehia565/stapler.git
cd stapler
npm ci
npm run build
# Install into Paperclip via Adapter Manager or POST /api/adapters/install
```

### 3. Configure an agent

- Adapter type: **`stapler`**
- **LLM provider** select: pick a slot id from the dropdown (derived from hostname)
- **Loop protection mode**: `balanced` by default; choose `off`, `advisory`, `balanced`, `strict`, or `custom`
- Run **Environment test**, then a heartbeat run

### 4. Stapler skill (automatic + optional company import)

Every Stapler heartbeat **always** injects the bundled operating skill (tools, handoffs, structured `@mentions`). The body is **embedded in the adapter** so it still loads when Paperclip installs only `dist/` and `skills/` is missing on disk. `skills/stapler/SKILL.md` remains the source for optional company-library import.

You do **not** need to attach it manually for agents to see it (manual attach still works and is fine as a backup).

Optional — import into the company skill library so it also appears in the Paperclip Skills UI:

```bash
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "source": "https://github.com/MYehia565/stapler/tree/main/skills/stapler" }'
```

Then attach `stapler` (plus your other skills) on each agent via Skills → sync if you want it listed in the UI. Runtime injection still happens even without that attach.

---

## Agent runtime controls

- **Max tool rounds** defaults to `1000`. A round is one model response that can request one or more tool calls, followed by the next model turn.
- **Run timeout** defaults to `7200` seconds and still caps the total wall-clock runtime even if tool rounds remain.
- **Loop protection mode** defaults to `balanced`:
  - `off`: no loop intervention
  - `advisory`: warnings only
  - `balanced`: warn early, optionally block redundant tools later, hard-stop mainly repeated failures
  - `strict`: intervene earlier and can hard-stop repeated successful no-op loops
  - `custom`: keep the mode UI but override thresholds below
- **Advanced loop overrides** available in adapter config:
  - `loopSoftAfter`
  - `loopFirmAfter`
  - `loopHardAfter`
  - `loopSameCallSoftAfter`
  - `loopSameCallFirmAfter`
  - `loopSameCallHardAfter`
  - `loopBlockRepeatedTools`
  - `loopAbortRepeatedSuccesses`

Stapler now treats repeated **same calls with the same results** as a stronger loop signal than repeated calls alone, which reduces false positives during normal work.

---

## Compatible provider examples

The endpoints below are configuration examples for APIs that expose OpenAI-compatible `/models` and `/chat/completions` routes. They illustrate how to configure providers; exact behavior depends on the endpoint and API features it exposes. The **slot id** column is what appears in the UI and in prefixed model ids — it is extracted from the URL hostname (see [How slot ids work](#how-slot-ids-work)).

### Major cloud APIs

| Provider | `STAPLER_WEB_URL_n` | Slot id | Notes |
| --- | --- | --- | --- |
| [OpenAI](https://platform.openai.com) | `https://api.openai.com/v1` | `openai` | Official API |
| [Groq](https://groq.com) | `https://api.groq.com/openai/v1` | `groq` | Fast inference |
| [DeepSeek](https://platform.deepseek.com) | `https://api.deepseek.com/v1` | `deepseek` | DeepSeek models |
| [Mistral](https://docs.mistral.ai) | `https://api.mistral.ai/v1` | `mistral` | Mistral API |
| [Cerebras](https://inference-docs.cerebras.ai) | `https://api.cerebras.ai/v1` | `cerebras` | Low-latency inference |
| [xAI (Grok)](https://docs.x.ai) | `https://api.x.ai/v1` | `xai` | Grok API |
| [Perplexity](https://docs.perplexity.ai) | `https://api.perplexity.ai` | `perplexity` | Sonar models |
| [Google Gemini](https://ai.google.dev/gemini-api/docs/openai) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `googleapis` | OpenAI-compat layer |
| [Azure OpenAI](https://learn.microsoft.com/azure/ai-services/openai/) | `https://{resource}.openai.azure.com/openai/deployments/{deployment}` | `azure` | Use deployment-specific path |
| [Alibaba DashScope](https://www.alibabacloud.com/help/en/model-studio/) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `aliyuncs` | Qwen and compatible models |
| [Moonshot (Kimi)](https://platform.moonshot.cn) | `https://api.moonshot.cn/v1` | `moonshot` | Kimi API |

### Routers & hosted open-model platforms

| Provider | `STAPLER_WEB_URL_n` | Slot id | Notes |
| --- | --- | --- | --- |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api/v1` | `openrouter` | Multi-vendor router; use `STAPLER_EXTRA_n` for routing hints |
| [Together AI](https://www.together.ai) | `https://api.together.xyz/v1` | `together` | Open models |
| [Fireworks AI](https://fireworks.ai) | `https://api.fireworks.ai/inference/v1` | `fireworks` | Serverless models |
| [Hugging Face Inference](https://huggingface.co/docs/inference-providers) | `https://router.huggingface.co/v1` | `huggingface` | Router endpoint |
| [Anyscale Endpoints](https://docs.anyscale.com/endpoints/overview) | `https://api.endpoints.anyscale.com/v1` | `anyscale` | Hosted open models |
| [Novita AI](https://novita.ai) | `https://api.novita.ai/v3/openai` | `novita` | Open-model API |
| [SiliconFlow](https://siliconflow.cn) | `https://api.siliconflow.cn/v1` | `siliconflow` | CN-hosted open models |
| [Lambda Labs](https://lambda.ai) | `https://api.lambdalabs.com/v1` | `lambdalabs` | Cloud GPU inference |

### Self-hosted & local

| Provider | `STAPLER_WEB_URL_n` | Slot id | Notes |
| --- | --- | --- | --- |
| [Ollama](https://ollama.com) | `http://127.0.0.1:11434/v1` | `slot1` | IP addresses → `slot{n}` |
| [LM Studio](https://lmstudio.ai) | `http://127.0.0.1:1234/v1` | `slot1` | Local OpenAI-compat server |
| [LiteLLM proxy](https://docs.litellm.ai/docs/simple_proxy) | `http://localhost:4000/v1` | `localhost` | Hostname `localhost` stays `localhost` |
| [vLLM](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) | `http://127.0.0.1:8000/v1` | `slot1` | Self-hosted serving |

**Anthropic Claude** does not expose a native OpenAI-compatible API. Route through [OpenRouter](#routers--hosted-open-model-platforms) or a [LiteLLM proxy](#self-hosted--local), then set `STAPLER_EXTRA_n` if the router needs provider hints.

### How slot ids work

Given `STAPLER_WEB_URL_n`, Stapler parses the hostname, strips common gateway prefixes (`api.`, `www.`, `gateway.`, …), and uses the **brand label immediately before the public suffix** (e.g. `api.openai.com` → `openai`, `openrouter.ai` → `openrouter`, `api.x.ai` → `xai`, `foo.example.co.uk` → `example`). Bare IP addresses become `slot1`, `slot2`, … by slot index. The hostname `localhost` becomes `localhost`. When two URLs would collide, ids are deduplicated (`openai`, `openai-2`).

### Multi-provider example

```bash
STAPLER_WEB_URL_1=https://api.openai.com/v1
STAPLER_API_KEY_1=sk-openai-...

STAPLER_WEB_URL_2=https://openrouter.ai/api/v1
STAPLER_API_KEY_2=sk-or-...

STAPLER_WEB_URL_3=https://api.groq.com/openai/v1
STAPLER_API_KEY_3=gsk-...
```

Models UI shows a union catalogue. Pick `openai::gpt-4o` or set the agent model field to pin a slot even if Provider is stale.

### Per-slot extra JSON

Merge provider-specific body fields into every `/chat/completions` call for that slot:

```bash
STAPLER_EXTRA_2='{"provider":{"order":["Anthropic"]}}'   # OpenRouter example
```

Agent `extraBody` merges on top (agent wins on key conflicts). Invalid `STAPLER_EXTRA_n` JSON fails Environment test. Extra cannot set `model`, `messages`, or `tools`.

---

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `STAPLER_WEB_URL_1` … `_16` | Yes (per slot) | OpenAI-compatible base URL |
| `STAPLER_API_KEY_1` … `_16` | Yes (per slot) | Bearer token for that URL |
| `STAPLER_WEB_URL` + `STAPLER_API_KEY` | Alt slot 1 | Used when `_1` pair is absent |
| `STAPLER_EXTRA_n` | No | JSON object merged into requests |
| `STAPLER_PROVIDER` | No | Global Detect preference (slot id) |
| `STAPLER_MODEL` | No | Global model override |

Aliases accepted: `STAPLER_API_KEY1` (no underscore before number).

---

## Security and execution boundaries

- Configure API keys through the Paperclip host environment or its secret-management flow. Never commit secrets.
- Stapler sends requests to the provider URLs you configure. Only use endpoints you trust, and review provider retention and data policies.
- **Important:** workspace file tools operate relative to the configured workspace, but `exec_command` runs a shell command. Treat it as privileged code execution on the Paperclip host; the working directory alone is not an operating-system security sandbox. Run Paperclip with least privilege and isolate it appropriately.
- Stapler does not automatically fail over between provider slots. A run uses the selected slot; keep credentials and endpoint configuration aligned.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run verify:e2e
npm run verify:runtime
```

See [CONTRIBUTING.md](./CONTRIBUTING.md), [VERIFICATION.md](./VERIFICATION.md), [docs/e2e-checklist.md](./docs/e2e-checklist.md), and [CHANGELOG.md](./CHANGELOG.md).

---

## Support and contributions

Bug reports and focused feature requests are welcome through [GitHub Issues](https://github.com/MYehia565/stapler/issues). Before opening an issue, check existing reports and never include API keys, personal data, or unredacted logs. Pull requests should include tests for behavior changes; see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

[MIT](./LICENSE)
