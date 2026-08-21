# Ship: Stapler 1.0.0

**Decision:** **GO for public GitHub release** after first commit + push.  
**Paperclip production:** GO for **canary** (one agent) after install; expand only after Environment test + one successful heartbeat with tools.

Verified locally (2026-08-21):

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | 94/94 pass |
| `npm run build` | Pass |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run verify:e2e` | PARTIALLY VERIFIED (live daemon SKIP — expected off-host) |
| Secrets in tree | None (env **names** and placeholder `sk-...` in README only) |
| TODO / `console.log` in `src/` | None |
| LICENSE | MIT |
| CI | `.github/workflows/ci.yml` (`npm ci`, Node 20/22) |

**Not yet done (human ops):**

- [ ] First git commit on `main` (repo has no commits yet)
- [ ] Create public GitHub repo; push; tag `v1.0.0`
- [ ] Enable [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository) on the repo
- [ ] Install into Paperclip; assign one canary agent; run Environment test
- [ ] `npm run verify:runtime` on the Paperclip host (`PAPERCLIP_ROOT` set)

---

## What ships

External Paperclip adapter **`stapler`** that:

- Connects to any OpenAI-compatible host via `STAPLER_WEB_URL_n` + `STAPLER_API_KEY_n`
- Unions model catalogues across slots for global Detect / Models
- Exposes sandboxed local workspace tools (`exec_command` = full shell; cwd sandboxed)
- Attaches Paperclip Tool Gateway + MCP when host auth is present
- Issue disposition tools via run JWT
- Dynamic Connection schema from live env slots
- Fails Environment test on invalid `STAPLER_EXTRA_n`

---

## Pre-launch checklist (adapter-shaped)

### Code quality

- [x] Unit tests pass
- [x] Typecheck + build pass
- [x] E2E harness pass (harness scope; live daemon separate)
- [x] Review findings from 1.0.0 cleanup addressed
- [x] No launch-blocking TODOs / debug logs in `src/`

### Security

- [x] No real secrets in VCS (`.env` / verification JSON gitignored)
- [x] Dependency audit clean for production deps
- [x] Keys via Paperclip Secret access; slot keys do not cross-fallback
- [x] Workspace path sandbox for local tools
- [x] SECURITY.md points at GitHub private vulnerability reporting
- [ ] Enable private vulnerability reporting on the published GitHub repo

*N/A for this package:* web CSP/HSTS, CORS wildcards, auth rate limits (host concerns).

### Performance / a11y / infra

*N/A as a UI/SaaS app.* Adapter concerns covered by HTTP timeouts, `exec_command` timeout/`maxBuffer`, and parallel slot discovery.

### Documentation

- [x] README (providers, slots, install, `exec_command` shell note)
- [x] CHANGELOG 1.0.0
- [x] CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, VERIFICATION
- [x] Spec + e2e checklist

---

## Rollout (Paperclip) — staged, not big-bang

There is no product feature flag; **stage by agent count**.

| Stage | Action | Hold / advance |
| --- | --- | --- |
| 0 | `npm ci && npm run build`; set `STAPLER_*`; restart Paperclip | Env present |
| 1 | Install adapter; assign **one** canary agent type `stapler` | Environment test **pass** |
| 2 | Canary heartbeat: workspace tool + (if auth) one gateway/MCP call | Exit 0; logs show `provider=` / `baseUrl=`; no auth key leakage |
| 3 | 24h watch of canary run errors vs prior adapter | Error rate ≤ baseline |
| 4 | Remaining agents | Same checks |

Manual checklist: [e2e-checklist.md](./e2e-checklist.md).

### Advance / hold / roll back (Paperclip)

| Signal | Advance | Hold | Roll back |
| --- | --- | --- | --- |
| Environment test | Pass | Warn-only gateway auth | Fail / missing slot |
| Agent run exit | 0 | Intermittent provider 5xx | Persistent exit 1 / wrong slot |
| Tool use | Function calls succeed | Local-only when gateway expected | Path escape / runaway `exec_command` |
| Logs | `provider=` / `baseUrl=` correct | Noisy timeouts | Keys or `STAPLER_EXTRA` dumped |

---

## Public GitHub release

1. Confirm `repository` URL in [package.json](../package.json) matches the org you create
2. First commit:

   ```bash
   git add .
   git commit -m "Initial public release: Stapler 1.0.0"
   ```

3. Create empty public repo → `git remote add origin …` → `git push -u origin main`
4. Tag and release:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

   GitHub Release body: copy [CHANGELOG.md](../CHANGELOG.md) `1.0.0` section
5. Enable private vulnerability reporting
6. Optional: `npm publish` (package name `stapler` — confirm npm name availability first)

---

## Monitoring (first hour after Paperclip install)

1. Environment test on canary agent → pass
2. One heartbeat run → exit 0; progress lines in run log
3. Confirm `provider=` and `baseUrl=` match the intended slot
4. Confirm tools: at least `list_dir` or `read_file` via function call
5. If Tool Gateway expected: session created (not “local tools only” warning)
6. Confirm API keys do not appear in logs

Success = canary green for 24h with no new adapter-attributed failures.

---

## Rollback plan

### Trigger

- Environment test fails after deploy
- Agent exit rate spikes vs prior adapter
- Wrong provider/slot used for completions
- Security concern (key leakage, sandbox escape)

### Steps

1. **Immediate:** Reassign canary (or all) agents off type `stapler` to the last known-good adapter type/package, **or** uninstall the Stapler install in Adapter Manager
2. Restart Paperclip if the host caches the adapter module
3. Verify: Environment test / heartbeat on previous adapter
4. Capture failing Stapler run logs (`provider=`, `baseUrl=`, tool warnings) for triage — **not** secrets

### Time to rollback

- Reassign agent type / uninstall adapter: minutes (no DB migration)
- No schema migrations to reverse

### Data

- No Stapler-owned database. Agent configs and secrets remain on the Paperclip host; revert only the adapter artifact/assignment.

---

## Launch day order

1. Commit + push + tag `v1.0.0`
2. Enable vulnerability reporting
3. Install on Paperclip staging (or production host with one canary)
4. Env + restart + Environment test
5. Canary run + 1h watch
6. Expand agents after 24h if green
