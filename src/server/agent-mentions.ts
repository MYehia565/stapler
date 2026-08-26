/**
 * Paperclip only wakes agents from structured mentions:
 *   [@Agent Name](agent://<uuid>)
 * Plain `@Agent Name` is decorative text and does not wake anyone.
 * Stapler rewrites bare @roster-name mentions before posting comments.
 */

export interface PaperclipAgentRef {
  id: string;
  name: string;
}

export interface MentionRewriteResult {
  body: string;
  resolved: Array<{ name: string; id: string }>;
  unresolved: string[];
  ambiguous: Array<{ name: string; candidates: string[] }>;
  alreadyStructured: number;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Extract agent id+name pairs from common Paperclip list payloads. */
export function agentsFromListPayload(data: unknown): PaperclipAgentRef[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { agents?: unknown })?.agents)
      ? ((data as { agents: unknown[] }).agents)
      : Array.isArray((data as { items?: unknown })?.items)
        ? ((data as { items: unknown[] }).items)
        : [];

  const out: PaperclipAgentRef[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id =
      clean(record.id) ||
      clean(record.agentId) ||
      clean(record.uuid);
    const name =
      clean(record.name) ||
      clean(record.displayName) ||
      clean(record.title) ||
      clean(record.urlKey);

    if (!id || !name) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name });
  }

  return out;
}

const STRUCTURED_MENTION_RE =
  /\[@[^\]]*\]\(agent:\/\/[^)]+\)/gi;

function structuredSpanAt(
  body: string,
  index: number,
): { start: number; end: number } | null {
  STRUCTURED_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STRUCTURED_MENTION_RE.exec(body))) {
    const start = match.index;
    const end = start + match[0].length;
    if (index >= start && index < end) {
      return { start, end };
    }
  }
  return null;
}

function agentsNamed(
  agents: PaperclipAgentRef[],
  rawName: string,
): PaperclipAgentRef[] {
  const needle = normalizeName(rawName);
  if (!needle) return [];
  return agents.filter((agent) => normalizeName(agent.name) === needle);
}

/**
 * Replace bare `@Agent Name` with `[@Agent Name](agent://uuid)` using the
 * company roster. Longest names win first so `@AI / Product Engineer` beats `@AI`.
 * Already-structured mentions are left alone.
 */
export function rewriteBareAgentMentions(
  body: string,
  agents: PaperclipAgentRef[],
): MentionRewriteResult {
  const resolved: Array<{ name: string; id: string }> = [];
  const unresolved: string[] = [];
  const ambiguous: Array<{ name: string; candidates: string[] }> = [];
  const alreadyStructured = (body.match(STRUCTURED_MENTION_RE) ?? []).length;

  if (!body || !agents.length) {
    return {
      body,
      resolved,
      unresolved,
      ambiguous,
      alreadyStructured,
    };
  }

  const byLength = [...agents].sort(
    (a, b) => b.name.length - a.name.length,
  );

  let output = "";
  let i = 0;

  while (i < body.length) {
    const structured = structuredSpanAt(body, i);
    if (structured && structured.start === i) {
      output += body.slice(structured.start, structured.end);
      i = structured.end;
      continue;
    }

    if (body[i] !== "@" || structured) {
      output += body[i];
      i += 1;
      continue;
    }

    let matched: PaperclipAgentRef | null = null;
    let matchedLen = 0;
    let ambiguousHit: PaperclipAgentRef[] | null = null;

    for (const agent of byLength) {
      const slice = body.slice(i + 1, i + 1 + agent.name.length);
      if (normalizeName(slice) !== normalizeName(agent.name)) {
        continue;
      }

      const after = body[i + 1 + agent.name.length] ?? "";
      if (after && /[A-Za-z0-9_/]/.test(after)) {
        continue;
      }

      const hits = agentsNamed(agents, agent.name);
      if (hits.length === 1) {
        matched = hits[0]!;
        matchedLen = agent.name.length;
        break;
      }

      if (hits.length > 1) {
        ambiguousHit = hits;
        matchedLen = agent.name.length;
        break;
      }
    }

    if (matched) {
      output += `[@${matched.name}](agent://${matched.id})`;
      i += 1 + matchedLen;
      if (!resolved.some((row) => row.id === matched!.id)) {
        resolved.push({ name: matched.name, id: matched.id });
      }
      continue;
    }

    if (ambiguousHit) {
      const label = body.slice(i + 1, i + 1 + matchedLen);
      ambiguous.push({
        name: label,
        candidates: ambiguousHit.map((hit) => `${hit.name} (${hit.id})`),
      });
      output += `@${label}`;
      i += 1 + matchedLen;
      continue;
    }

    // Unknown bare @token: capture Title-Case / slash name fragments only.
    const tokenMatch = body
      .slice(i + 1)
      .match(
        /^([A-Z][A-Za-z0-9_/]*(?:[ /]+[A-Z][A-Za-z0-9_/]*){0,6})/,
      );
    if (tokenMatch?.[1]) {
      const token = tokenMatch[1].trim();
      if (token && !unresolved.includes(token)) {
        unresolved.push(token);
      }
      output += `@${tokenMatch[1]}`;
      i += 1 + tokenMatch[1].length;
      continue;
    }

    // Lowercase single-token fallback (e.g. @growth).
    const lowerMatch = body.slice(i + 1).match(/^([a-z][a-z0-9_/-]{1,40})/);
    if (lowerMatch?.[1]) {
      const token = lowerMatch[1];
      if (!unresolved.includes(token)) {
        unresolved.push(token);
      }
      output += `@${token}`;
      i += 1 + token.length;
      continue;
    }

    output += "@";
    i += 1;
  }

  return {
    body: output,
    resolved,
    unresolved,
    ambiguous,
    alreadyStructured,
  };
}

export function hasBareAtMention(body: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "@") continue;
    if (structuredSpanAt(body, i)) continue;
    const prev = i === 0 ? "\n" : body[i - 1]!;
    const next = body[i + 1] ?? "";
    if ((/[\s([{"']/.test(prev) || i === 0) && /[A-Za-z]/.test(next)) {
      return true;
    }
  }
  return false;
}

export function formatMentionRewriteWarning(
  result: MentionRewriteResult,
): string | undefined {
  const parts: string[] = [];

  if (result.resolved.length) {
    parts.push(
      `Rewrote ${result.resolved.length} bare @mention(s) to structured agent:// links: ${result.resolved
        .map((row) => `${row.name}→${row.id}`)
        .join(", ")}.`,
    );
  }

  if (result.ambiguous.length) {
    parts.push(
      `Ambiguous @mention(s) left unchanged (not woken): ${result.ambiguous
        .map((row) => `${row.name} [${row.candidates.join(" | ")}]`)
        .join("; ")}.`,
    );
  }

  if (result.unresolved.length) {
    parts.push(
      `Unknown @mention(s) left unchanged (not woken): ${result.unresolved.join(", ")}. Call paperclip_list_agents and use [@Name](agent://uuid).`,
    );
  }

  if (
    !result.resolved.length &&
    !result.ambiguous.length &&
    !result.unresolved.length &&
    hasBareAtMention(result.body) &&
    result.alreadyStructured === 0
  ) {
    parts.push(
      "Comment still contains bare @text. Paperclip only wakes agents from [@Name](agent://uuid).",
    );
  }

  return parts.length ? parts.join(" ") : undefined;
}
