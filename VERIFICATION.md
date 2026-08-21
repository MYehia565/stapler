# Stapler independent verification

Host-level harness. Does **not** ask a Paperclip agent to test itself.

## Prerequisites

```bash
cd stapler   # repository root
npm install
npm run build
```

Optional on the Paperclip host:

```bash
export PAPERCLIP_ROOT=/opt/paperclip
```

## Commands

```bash
npm run verify:e2e
npm run verify:runtime
```

Exit codes:

- `0` — no failed checks (`VERIFIED` or `PARTIALLY VERIFIED`)
- `1` — one or more checks `FAIL`

Artifacts (gitignored locally):

- `verification-e2e.json`
- `verification-runtime.json`

## What each command proves

| Command | Proves |
| --- | --- |
| `npm run verify:e2e` | Compiled adapter tools, real FS/exec, sandbox, mocked multi-turn loop, profile aliases, structured `AdapterExecutionResult` with `STAPLER_*` slots |
| `npm run verify:runtime` | Package identity for **this** tree, duplicate scan under `PAPERCLIP_ROOT`, best-effort daemon process listing |

`verify:e2e` answers: is this adapter implementation capable?  
`verify:runtime` partially answers: is the live Paperclip daemon loading it?

## Expected output (shape)

```text
STAPLER RUNTIME VERIFICATION

Build: PASS
Tool registration: PASS
Multi-turn execution: PASS
Disposition: PASS
Live daemon: SKIP

Overall:
PARTIALLY VERIFIED
```
