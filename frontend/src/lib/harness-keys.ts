/**
 * Identity parsed out of an installed harness artifact's `canonicalKey`.
 *
 * The key's spelling depends on who wrote it, and three writers use three shapes:
 *   · market writers      `github:<owner>/<repo>#<dir>` and the `gh:` alias (also skills)
 *   · a runtime's store   `git:github.com/<owner>/<repo>` (pi's `packages[]`)
 *   · operator git market `mp-<slug>:<owner>/<repo>#<source>` (a plugin row)
 *
 * ONE parser decides all of them so the detail dialog and the star cell read the same identity.
 * GitHub-only on purpose: both consumers call api.github.com, so a key naming another host (a
 * GitLab repo in a `git:` spec) answers null instead of a repo that would only 404. A shape this
 * parser cannot resolve — `npm:<pkg>` (no repository; the registry document is read instead),
 * `clawhub:<owner>/<slug>`, `claude:<name>@<marketplace>`, `manual:<name>` — answers null too.
 */

/** The GitHub repository a canonical key names, as `owner/repo`, or null. */
export function repoOfKey(canonicalKey: string | null | undefined): string | null {
  if (!canonicalKey) return null;

  const direct = /^(?:gh|github):([\w.-]+\/[\w.-]+)/.exec(canonicalKey);
  if (direct) return direct[1]!;

  const marketplace = /^mp-[\w.-]+:([\w.-]+\/[\w.-]+)(?:#|$)/.exec(canonicalKey);
  if (marketplace) return marketplace[1]!;

  const git = /^git:(.+)$/.exec(canonicalKey)?.[1]?.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!git) return null;
  // Scheme and `git@` user are optional; the host must be github.com, and a deep path below the
  // repository (`/tree/main`, `#dir`) is not part of the identity.
  const hosted = /^(?:[a-z]+:\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:[#?].*)?$/i.exec(git);
  if (hosted) return `${hosted[1]}/${hosted[2]}`;
  // A bare `git:owner/repo` pair: accepted only when the first half is not a hostname, so
  // `git:gitlab.com/team` stays unresolved instead of becoming a GitHub repo named `gitlab.com`.
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(git);
  if (bare && !bare[1]!.includes('.')) return `${bare[1]}/${bare[2]}`;
  return null;
}
