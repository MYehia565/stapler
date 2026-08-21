# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x   | Yes       |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Use [GitHub Private Vulnerability Reporting](https://github.com/MYehia565/stapler/security/advisories/new) on this repository. Include:

- Description of the issue
- Steps to reproduce
- Impact assessment
- Stapler and Paperclip versions

If that form is unavailable (fork, mirror, or the repo is not yet public), open a **private** security advisory on your GitHub fork or email the address listed on the GitHub org profile. We will acknowledge receipt within a few business days and work on a fix before public disclosure when appropriate.

## Scope notes

Stapler runs inside a Paperclip host process. It:

- Sandboxes local filesystem tools to the assigned workspace root
- Runs `exec_command` as a full shell inside that workspace (cwd is constrained; the command string is not allowlisted)
- Never logs API keys or `STAPLER_EXTRA_n` JSON that may contain secrets
- Does not cross-use API keys between provider slots

Operators should bind `STAPLER_API_KEY_n` through Paperclip Secret access, not plaintext agent config.
