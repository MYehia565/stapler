/**
 * Embedded Stapler operating skill body.
 *
 * Paperclip installs often resolve the adapter from `dist/` only, so
 * `skills/stapler/SKILL.md` on disk may be missing at runtime. This constant
 * is the reliable source. Keep `skills/stapler/SKILL.md` in sync for company
 * skill imports from GitHub.
 */
export const EMBEDDED_STAPLER_SKILL_BODY = `# Stapler operating skill

You are running through **Stapler**, a Paperclip adapter for OpenAI-compatible models. Use Stapler tools and Paperclip handoff rules below — do not invent shell/curl workarounds for Paperclip APIs.

## Heartbeat priorities

1. If **Triggering Wake Comment** / wake payload is present → treat it as the highest-priority work for this run.
2. Else if a wake issue is scoped → checkout, read context, execute, dispose.
3. Else call \`paperclip_list_my_issues\` (inbox) and pick the highest-priority assigned work.
4. Before exiting: set issue status with \`paperclip_update_issue\` (\`done\`, \`blocked\`, or \`in_review\`).

## Tool map

| Need | Tool |
| --- | --- |
| Files / shell / search / public HTTP | \`list_dir\`, \`read_file\`, \`write_file\`, \`str_replace\`, \`grep_search\`, \`glob_files\`, \`http_fetch\`, \`web_search\`, \`exec_command\` |
| My inbox | \`paperclip_list_my_issues\` |
| Company agents (ids for assign/mention) | \`paperclip_list_agents\` |
| Read issue + comments | \`paperclip_get_issue\` |
| Take ownership | \`paperclip_checkout_issue\` (never retry 409) |
| Status / reassign / blockers | \`paperclip_update_issue\` |
| Comment only | \`paperclip_add_comment\` |
| Delegate new work | \`paperclip_create_issue\` with \`assigneeAgentId\` + \`parentId\` |
| Paperclip Tool Gateway / MCP tools | Exact names listed in Tool Availability for this run (any MCP connection — call them; do not claim unavailable) |

## Inter-agent handoffs (required)

Paperclip **does not** wake another agent from prose like:

- \`Next action: Growth Analyst …\`
- bare \`@Growth Analyst\`

### What actually wakes another agent

1. **Assign** — \`paperclip_create_issue\` with \`assigneeAgentId\` (and \`parentId\` / \`goalId\` when known), or \`paperclip_update_issue\` with \`assigneeAgentId\`.
2. **Structured mention** in a comment:

\`\`\`markdown
[@Growth Analyst](agent://<agent-uuid>) please define UTM tracking for Phase 0.
\`\`\`

Resolve \`<agent-uuid>\` via \`paperclip_list_agents\` first.

3. **Blockers** — \`paperclip_update_issue\` with \`blockedByIssueIds\` so dependents auto-wake when blockers complete.

Stapler may rewrite bare \`@Exact Roster Name\` into structured links when posting, but **always prefer writing the \`[@Name](agent://uuid)\` form yourself**.

## Mentions checklist

- [ ] Called \`paperclip_list_agents\` (or already know uuids)
- [ ] Used \`[@Name](agent://uuid)\` — not bare \`@Name\`
- [ ] Or created/reassigned an issue with \`assigneeAgentId\`
- [ ] Left the source issue in a real waiting state (\`in_review\` / \`blocked\`) when waiting on others

## Disposition

| Outcome | Status | Notes |
| --- | --- | --- |
| Finished | \`done\` | Comment what shipped |
| Waiting on review / human / confirmation | \`in_review\` | Real reviewer path required |
| Waiting on other issues | \`blocked\` + \`blockedByIssueIds\` | Prefer ids over prose |
| Handed to another agent | create/reassign with \`assigneeAgentId\` | Do not only comment “next action” |

## Anti-patterns

- Asking a human to relay work between agents when you can assign or @mention
- Using \`exec_command\` / curl against Paperclip APIs when issue tools exist
- Claiming Tool Gateway / MCP tools are unavailable when Tool Availability lists them
- Leaving issues \`in_progress\` with no live continuation path
`;
