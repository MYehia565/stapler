# Changelog

## Unreleased

## 1.1.0 — 2026-08-25

- Fix cross-issue Paperclip writes: always resolve and send `X-Paperclip-Run-Id` from `ctx.runId`, wake `context.runId`, or `PAPERCLIP_RUN_ID` (same for Tool Gateway session create)
- Expanded local tools: `str_replace`, `delete_file`, `move_file`, `grep_search`, `glob_files`, `http_fetch`, `web_search` (plus ranged `read_file`)
- Max tool rounds raised to **1000** (default 1000); default run timeout **7200s**
- Three-level loop protection: soft nudge → firm tool block → hard abort on identical repeated actions

## 1.0.0 — Initial public release

Stapler is a universal [Paperclip](https://github.com/paperclipai/paperclip) external adapter for OpenAI-compatible LLM APIs.

- Adapter type `stapler`, package name `stapler`
- Up to 16 provider slots via `STAPLER_WEB_URL_n` + `STAPLER_API_KEY_n` (+ optional `STAPLER_EXTRA_n`)
- Slot ids extracted from URL hostnames (`openai`, `groq`, `openrouter`, …)
- `listModels` / `detectModel` / `refreshModels` union every configured slot; prefixed ids when multiple slots exist (`openai::gpt-4o`)
- Dynamic Connection schema from live env slots
- Sandboxed workspace tools: `list_dir`, `read_file`, `write_file`, `exec_command` (`exec_command` is a full shell; cwd stays in the workspace)
- Invalid `STAPLER_EXTRA_n` JSON fails Environment test; extra cannot set `model`, `messages`, or `tools`
- Paperclip Tool Gateway + MCP when host auth is available
- Issue tools: `paperclip_checkout_issue`, `paperclip_update_issue`, `paperclip_add_comment`
- MIT license, CONTRIBUTING, SECURITY, GitHub Actions CI
