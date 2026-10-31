/**
 * GitHub request headers — one place for the token, shared by every reader that talks to the API
 * (the on-demand star resolver and the operator-marketplace manifest probes). A second copy would
 * drift the day one of them learns a new header.
 */
export function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'omnicellrouter-harness',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
