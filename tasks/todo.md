# Stapler 1.0.0 — Task List

Spec: [docs/stapler-spec.md](../docs/stapler-spec.md)

---

## Implementation — **done**

- [x] Slot system, union Detect, runtime wiring, identity
- [x] Test suite
- [x] Verify scripts + e2e harness for `STAPLER_*`
- [x] README (popular providers), CHANGELOG 1.0.0, ship docs

## Open source prep — **done**

- [x] MIT LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT
- [x] package.json metadata + package-lock.json
- [x] GitHub Actions CI (`npm ci`, Node 20/22)
- [x] Issue / PR templates
- [x] README with major cloud, router, and self-hosted provider tables

## Human ops — **pending** (see [docs/ship.md](../docs/ship.md))

- [ ] First commit: `Initial public release: Stapler 1.0.0`
- [ ] Create public GitHub repo; push `main`; tag `v1.0.0`
- [ ] Enable private vulnerability reporting on the repo
- [ ] Install in Paperclip; one canary agent type `stapler`
- [ ] Set `STAPLER_*`; Environment test; canary heartbeat
- [ ] Optional: `npm run verify:runtime` on Paperclip host
- [ ] Expand agents after 24h green canary
