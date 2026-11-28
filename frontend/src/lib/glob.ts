/**
 * Frontend mirror of `backend/src/utils/glob.ts` — the member-pattern matcher
 * used by tier rules (ADR-0003): `*` matches any run of characters, `?` a
 * single character, case-insensitive; a pattern WITHOUT wildcards is a
 * substring match. The console must resolve a rule's model set client-side
 * (e.g. to bound a thinking-level picker by the models' declared levels)
 * before the draft is ever sent, so the semantics have to match the backend
 * exactly — keep both files in step.
 */
function globMatch(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const v = value.toLowerCase();
  if (!/[*?]/.test(p)) return v.includes(p);
  const regex = new RegExp(
    '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return regex.test(v);
}

/**
 * Member-rule match with the backend's exact pin (mirrors `markExactFullIds` +
 * `ruleMatches` in `backend/src/providers/member-match.ts`): a pattern with no
 * wildcard that names a REGISTERED model id claims ONLY that id, so a full id
 * never pulls in its longer sibling ids (`deepseek/v4-flash` must not match
 * `deepseek/v4-flash-vision-exp`). Every other pattern keeps `globMatch`. The
 * extra argument is a predicate because the registered-id universe belongs to
 * the caller (catalog rows / combo picker options), not to this module.
 */
export function memberRuleMatch(
  pattern: string,
  value: string,
  isRegistered: (id: string) => boolean
): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (!/[*?]/.test(p) && isRegistered(p)) return p.toLowerCase() === value.toLowerCase();
  return globMatch(p, value);
}
