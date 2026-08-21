# Spec: Stapler — Universal OpenAI-Compatible Provider Adapter

**Status:** Implemented in **1.0.0**

**Product name:** Stapler  
**Package:** `stapler`  
**Adapter type:** `stapler`  
**Git / folder:** `stapler`

---

## Objective

Operators configure **Stapler** as a universal OpenAI-compatible gateway: add providers by binding `STAPLER_WEB_URL_n` + `STAPLER_API_KEY_n`. There is no hardcoded vendor list. Slot ids (`openai`, `groq`, `openrouter`, …) are extracted from each URL hostname.

**User:** Paperclip operator who installs one adapter, binds secrets, and assigns agents.

**Success looks like:**

- Bind `STAPLER_WEB_URL_1` + `STAPLER_API_KEY_1` (and `_2`, `_3`, …) on the Paperclip server. Restart once. The Connection **LLM provider** select lists names extracted from each URL.
- Environment test and execute use the **agent-selected** slot’s URL + key + extra.
- Models / Detect / Refresh show catalogues from **all configured slots** (prefixed ids when more than one slot exists).
- If the chosen model id is prefixed with a known slot (`openai::gpt-4o`), execute uses that slot even if the Provider field is stale.

---

## Why Detect unions all slots

From `@paperclipai/adapter-utils` `ServerAdapterModule`:

```ts
listModels?: () => Promise<AdapterModel[]>;
refreshModels?: () => Promise<AdapterModel[]>;
detectModel?: () => Promise<{ model; provider; source; candidates? } | null>;
getConfigSchema?: () => Promise<AdapterConfigSchema> | AdapterConfigSchema;
```

None of these receive agent `config`. Execute and `testEnvironment` do. So:

- **Runs and Environment test** follow `config.provider` (the extracted slot id).
- **Adapter-page Models / Detect / Refresh** cannot see the form.

Stapler makes Detect useful without that: union of every configured slot, prefixed model ids, and `STAPLER_PROVIDER` only as a Detect *preference*.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript ES2022, `NodeNext` |
| Runtime | Node.js, loaded by Paperclip |
| Host contract | `@paperclipai/adapter-utils` (current `^2026.722.0`) |
| LLM API | OpenAI-compatible `/models` + `/chat/completions` |
| Auth | Bearer from the selected slot’s `STAPLER_API_KEY_n` |
| Tests | `node:test` via `npm test` |

```text
Build:      npm run build
Typecheck:  npm run typecheck
Test:       npm test
Verify e2e: npm run verify:e2e
```

---

## Hostname → slot id

```ts
providerNameFromWebUrl("https://api.openai.com/v1")     // "openai"
providerNameFromWebUrl("https://openrouter.ai/api/v1")  // "openrouter"
providerNameFromWebUrl("https://api.groq.com/openai/v1") // "groq"
providerNameFromWebUrl("http://localhost:4000/v1")      // "localhost"
providerNameFromWebUrl("http://127.0.0.1:11434/v1")     // "slot1" (index fallback)
```

Algorithm:

1. Parse URL; on failure → `slot{n}`.
2. Hostname, lowercase, strip trailing dot.
3. Strip a single leading `www.` then a single leading `api.`.
4. Split on `.`. If the result is an IPv4/IPv6 host → `slot{n}`.
5. If one label → that label (`localhost`).
6. Otherwise brand = second-to-last label (`api.openai.com` → `openai`).
7. Sanitize: `[a-z0-9]+` joined by `-`, max 32 chars. Empty → `slot{n}`.
8. If the name collides with an earlier slot, append `-2`, `-3`, …

---

## Provider slots

For `n` in `1`..`16`, a slot exists when **both** URL and key resolve to non-empty strings.

| Role | Accepted names (first match wins, case-insensitive) |
| --- | --- |
| Base URL | `STAPLER_WEB_URL_{n}`, `STAPLER_WEB_URL{n}` |
| API key | `STAPLER_API_KEY_{n}`, `STAPLER_API_KEY{n}` |
| Extra JSON | `STAPLER_EXTRA_{n}`, `STAPLER_EXTRA{n}` (optional) |

Unnumbered pair `STAPLER_WEB_URL` + `STAPLER_API_KEY` is treated as slot `1` **only if** numbered slot `1` is absent.

| Name | Purpose |
| --- | --- |
| `STAPLER_PROVIDER` | Optional Detect preference (slot id) |
| `STAPLER_MODEL` | Optional global model override |

Active slot for a run: `model::prefix` → `config.provider` → `STAPLER_PROVIDER` → lowest configured index.

No automatic failover. One run uses one slot. Keys never cross between slots.

---

## Runtime

Tools, Tool Gateway, issue disposition, MCP prompt, skills, and timeouts are part of 1.0:

- Sandboxed local tools: `list_dir`, `read_file`, `write_file`, `exec_command` (`exec_command` is a full shell; only the working directory is sandboxed)
- Paperclip Tool Gateway + MCP when host auth is present
- Issue tools via run JWT: checkout, update, comment
- Instructions bundle and ephemeral skills

`extra` means per-slot JSON (`STAPLER_EXTRA_n`) merged into `/chat/completions`, plus the agent `extraBody` field (agent wins on key conflict). Reserved keys (`model`, `messages`, `tools`) cannot be set from extra. Invalid `STAPLER_EXTRA_n` JSON fails Environment test.
