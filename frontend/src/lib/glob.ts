/**
 * Frontend mirror of `backend/src/utils/glob.ts` — the member-pattern matcher
 * used by tier rules (ADR-0003): `*` matches any run of characters, `?` a
 * single character, case-insensitive; a pattern WITHOUT wildcards is a
 * substring match. The console must resolve a rule's model set client-side
 * (e.g. to bound a thinking-level picker by the models' declared levels)
 * before the draft is ever sent, so the semantics have to match the backend
 * exactly — keep both files in step.
 */
export function globMatch(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const v = value.toLowerCase();
  if (!/[*?]/.test(p)) return v.includes(p);
  const regex = new RegExp(
    '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return regex.test(v);
}
