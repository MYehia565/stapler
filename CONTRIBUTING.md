# Contributing to Stapler

Thank you for helping improve Stapler. This project is a [Paperclip](https://github.com/paperclipai/paperclip) external adapter for OpenAI-compatible LLM hosts.

## Development setup

```bash
git clone https://github.com/MYehia565/stapler.git
cd stapler
npm install
npm test
npm run build
```

Optional host verification:

```bash
npm run verify:e2e
npm run verify:runtime
```

## Pull requests

1. Fork the repository and create a feature branch from `main`.
2. Keep changes focused. Stapler configures providers only through **`STAPLER_*` slots**.
3. Add or update tests in `tests/` for behavior changes.
4. Run `npm ci`, `npm test`, and `npm run typecheck` before opening a PR.
5. Update [CHANGELOG.md](./CHANGELOG.md) under an `Unreleased` or version heading when user-facing behavior changes.
6. Bump `package.json` / `package-lock.json` version (and README version line) when shipping a release — see **Versioning** below.

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Versioning

Stapler follows [SemVer](https://semver.org/):

| Change | Bump | Example |
| --- | --- | --- |
| Bug fix / internal hardening, compatible | **patch** | `1.0.0` → `1.0.1` |
| New tools/config/features, compatible | **minor** | `1.0.1` → `1.1.0` |
| Breaking adapter contract or config | **major** | `1.1.0` → `2.0.0` |

Release checklist:

1. Move notes from `Unreleased` into a dated `## x.y.z` section in `CHANGELOG.md`.
2. Set `version` in `package.json` and the root entry in `package-lock.json`.
3. Update the README version line.
4. Commit, tag `vx.y.z`, push the tag, and publish a GitHub Release from the changelog section.
5. Reinstall/reload the adapter in Paperclip so hosts pick up the new build.

## Code conventions

- TypeScript ESM with `.js` extensions in relative imports
- Match existing patterns in `src/server/`
- No secrets in code, fixtures, or committed env files
- User-facing strings use **Stapler** and **`STAPLER_*`** naming

## Reporting issues

Use [GitHub Issues](https://github.com/MYehia565/stapler/issues) and include:

- Stapler version
- Paperclip version (if known)
- Configured `STAPLER_WEB_URL_n` hostnames (not API keys)
- Run log excerpt with `provider=` and `baseUrl=` lines

Security issues: see [SECURITY.md](./SECURITY.md).
