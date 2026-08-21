# Manual E2E checklist — Paperclip + Stapler 1.0

Use this after installing or reloading the **Stapler** adapter in a Paperclip instance.

1. Install or reload the adapter (`Adapter Manager` or `POST /api/adapters/install`).
2. Request `GET /api/adapters`; for **`stapler`**, confirm
   `capabilities.supportsInstructionsBundle` and `capabilities.supportsSkills`
   are both `true`.
3. Request `GET /api/adapters/stapler/config-schema`; confirm the response
   contains dynamic **provider** options from configured `STAPLER_*` slots,
   plus `baseUrl`, `cwd`, `instructionsFilePath`, `promptTemplate`,
   `temperature`, `maxTokens`, `maxToolRounds`, `timeoutSec`, `runTimeoutSec`,
   `extraBody`, and `paperclipApiUrl`.
4. Configure server env (`STAPLER_WEB_URL_1` + `STAPLER_API_KEY_1` at minimum).
   Restart Paperclip so slots are visible in the schema.
5. Open an agent's Permissions & Configuration UI:
   - Provider select lists discovered slot ids (e.g. `openai`, `groq`).
   - Primary model defaults to `standard`.
   - Cheap model is available separately and does not change primary.
   - With multiple slots configured, refresh Primary Model / Detect and confirm
     the catalogue is a **union** of all slots (prefixed ids when needed).
   - Instructions bundle editor and skills management are available.
   - Claude-only Command, engine, Chrome, permissions, and CLI fields are absent.
6. Bind `STAPLER_API_KEY_n` through Secret access; do not put raw keys in text fields.
7. Save non-default values, reopen the agent, and confirm they persist.
8. Edit the managed instructions bundle; on the next run, confirm the text
   appears in the prompt / agent behavior. Optionally set `promptTemplate`
   and confirm it is prepended.
9. Run the **Environment test**; confirm slot inventory, `provider=` / `baseUrl=`,
   and model discovery for the active slot.
10. Assign the agent a known workspace that contains files.
11. Ask the agent to `list_dir` on `.` — it must succeed via a function tool
    call, not text.
12. Ask the agent to `read_file` on a known file — content is returned.
    If the provider reports the call as `default_api:read_file`, confirm it
    executes once rather than retrying until `maxToolRounds`.
13. On the Paperclip host, run `npm run verify:e2e` from the adapter package and
    confirm Overall is `VERIFIED` or `PARTIALLY VERIFIED` (live daemon may be
    SKIP). Then run `npm run verify:runtime`.
14. With Paperclip API auth present, gateway tools appear in run meta and at
    least one governed tool call works.
15. With Paperclip API auth absent, the run still completes using local tools;
    meta warns that the gateway is unavailable.

Automated coverage: `npm test` and `npm run typecheck`.

See also: [stapler-spec.md](./stapler-spec.md) and [ship.md](./ship.md).
