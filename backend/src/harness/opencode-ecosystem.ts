/**
 * Curated OpenCode ecosystem catalog — a SHIPPED SNAPSHOT, not a live fetch.
 *
 * Source: https://opencode.ai/docs/ecosystem/ whose upstream file is
 * `packages/web/src/content/docs/ecosystem.mdx` in the `anomalyco/opencode` repo (a Starlight page
 * with no JSON endpoint). Snapshot taken 2026-10-25 from the `## Plugins` table only: `## Projects`
 * lists standalone apps (a Discord bot, editor plugins) and `## Agents` lists config bundles, so
 * neither is an installable extension.
 *
 * Why a snapshot instead of fetching the mdx at runtime:
 *  - `raw.githubusercontent.com` and `cdn.jsdelivr.net` both reset the connection from this
 *    environment (measured), so a live fetch would render an empty market that looks broken;
 *  - the upstream table has no version or schema contract — a snapshot pins what an operator sees.
 * Cost: the list goes stale. Refresh by re-copying the `## Plugins` table, and bump `SNAPSHOT_AT`.
 *
 * `npm` is the published package name when one was VERIFIED to exist on the registry and to belong
 * to the same project the table links to (checked against the package's own `repository` field).
 * Rows without it are browse-only: the table name is not an npm name, so they cannot be installed
 * from here — the npm source is where that row is actually served (ADR-0015 §D6).
 */

export interface EcosystemEntry {
  /** Table name, verbatim (a display label, not necessarily a package name). */
  name: string;
  /** `owner/repo` the table links to. */
  repo: string;
  /** The exact URL the table carries (may point inside the repo). */
  url: string;
  description: string;
  /** Verified npm package name; absent = browse-only. */
  npm?: string;
}

/** The day the `## Plugins` table was copied. Bump it with every refresh. */
export const SNAPSHOT_AT = '2026-10-25';

export const OPENCODE_ECOSYSTEM: EcosystemEntry[] = [
  {
    name: 'opencode-daytona',
    repo: 'daytona/integrations',
    url: 'https://github.com/daytona/integrations/tree/main/packages/opencode-plugin',
    description: 'Automatically run OpenCode sessions in isolated Daytona sandboxes with git sync and live previews',
    npm: 'opencode-daytona',
  },
  {
    name: 'opencode-helicone-session',
    repo: 'H2Shami/opencode-helicone-session',
    url: 'https://github.com/H2Shami/opencode-helicone-session',
    description: 'Automatically inject Helicone session headers for request grouping',
    npm: 'opencode-helicone-session',
  },
  {
    name: 'opencode-type-inject',
    repo: 'nick-vi/opencode-type-inject',
    url: 'https://github.com/nick-vi/opencode-type-inject',
    description: 'Auto-inject TypeScript/Svelte types into file reads with lookup tools',
    // Published under the author's scope; the package's repository field is nick-vi/type-inject.
    npm: '@nick-vi/opencode-type-inject',
  },
  {
    name: 'opencode-openai-codex-auth',
    repo: 'numman-ali/opencode-openai-codex-auth',
    url: 'https://github.com/numman-ali/opencode-openai-codex-auth',
    description: 'Use your ChatGPT Plus/Pro subscription instead of API credits',
    npm: 'opencode-openai-codex-auth',
  },
  {
    name: 'opencode-gemini-auth',
    repo: 'jenslys/opencode-gemini-auth',
    url: 'https://github.com/jenslys/opencode-gemini-auth',
    description: 'Use your existing Gemini plan instead of API billing',
    npm: 'opencode-gemini-auth',
  },
  {
    name: 'opencode-antigravity-auth',
    repo: 'NoeFabris/opencode-antigravity-auth',
    url: 'https://github.com/NoeFabris/opencode-antigravity-auth',
    description: "Use Antigravity's free models instead of API billing",
    npm: 'opencode-antigravity-auth',
  },
  {
    name: 'opencode-dynamic-context-pruning',
    repo: 'Tarquinen/opencode-dynamic-context-pruning',
    url: 'https://github.com/Tarquinen/opencode-dynamic-context-pruning',
    description: 'Optimize token usage by pruning obsolete tool outputs',
    // Published as `opencode-dcp` under the author's scope.
    npm: '@tarquinen/opencode-dcp',
  },
  {
    name: 'opencode-vibeguard',
    repo: 'inkdust2021/opencode-vibeguard',
    url: 'https://github.com/inkdust2021/opencode-vibeguard',
    description: 'Redact secrets/PII into VibeGuard-style placeholders before LLM calls; restore locally',
    npm: 'opencode-vibeguard',
  },
  {
    name: 'opencode-websearch-cited',
    repo: 'ghoulr/opencode-websearch-cited',
    url: 'https://github.com/ghoulr/opencode-websearch-cited',
    description: 'Add native websearch support for supported providers with Google grounded style',
    npm: 'opencode-websearch-cited',
  },
  {
    name: 'opencode-pty',
    repo: 'shekohex/opencode-pty',
    url: 'https://github.com/shekohex/opencode-pty',
    description: 'Enables AI agents to run background processes in a PTY, send interactive input to them.',
    npm: 'opencode-pty',
  },
  {
    name: 'opencode-shell-strategy',
    repo: 'JRedeker/opencode-shell-strategy',
    url: 'https://github.com/JRedeker/opencode-shell-strategy',
    description:
      'Instructions for non-interactive shell commands - prevents hangs from TTY-dependent operations',
    // No package published under this or a scoped variant; see `opencode-morph-fast-apply` for the
    // same author's publishing pattern (a `@f97/` scope) that does not exist for this one.
  },
  {
    name: 'opencode-wakatime',
    repo: 'angristan/opencode-wakatime',
    url: 'https://github.com/angristan/opencode-wakatime',
    description: 'Track OpenCode usage with Wakatime',
    npm: 'opencode-wakatime',
  },
  {
    name: 'opencode-md-table-formatter',
    repo: 'franlol/opencode-md-table-formatter',
    url: 'https://github.com/franlol/opencode-md-table-formatter/tree/main',
    description: 'Clean up markdown tables produced by LLMs',
    npm: '@franlol/opencode-md-table-formatter',
  },
  {
    name: 'opencode-morph-fast-apply',
    repo: 'JRedeker/opencode-morph-fast-apply',
    url: 'https://github.com/JRedeker/opencode-morph-fast-apply',
    description: '10x faster code editing with Morph Fast Apply API and lazy edit markers',
    // The package's repository field points back at JRedeker/opencode-morph-fast-apply.
    npm: '@f97/opencode-morph-fast-apply',
  },
  {
    name: 'opencode-morph-plugin',
    repo: 'morphllm/opencode-morph-plugin',
    url: 'https://github.com/morphllm/opencode-morph-plugin',
    description: 'Fast Apply editing, WarpGrep codebase search, and context compaction via Morph',
    npm: '@morphllm/opencode-morph-plugin',
  },
  {
    name: 'oh-my-opencode',
    repo: 'code-yeongyu/oh-my-opencode',
    url: 'https://github.com/code-yeongyu/oh-my-opencode',
    description: 'Background agents, pre-built LSP/AST/MCP tools, curated agents, Claude Code compatible',
    npm: 'oh-my-opencode',
  },
  {
    name: 'opencode-notifier',
    repo: 'mohak34/opencode-notifier',
    url: 'https://github.com/mohak34/opencode-notifier',
    description: 'Desktop notifications and sound alerts for permission, completion, and error events',
    npm: '@mohak34/opencode-notifier',
  },
  {
    name: 'opencode-zellij-namer',
    repo: '24601/opencode-zellij-namer',
    url: 'https://github.com/24601/opencode-zellij-namer',
    description: 'AI-powered automatic Zellij session naming based on OpenCode context',
    npm: 'opencode-zellij-namer',
  },
  {
    name: 'opencode-supermemory',
    repo: 'supermemoryai/opencode-supermemory',
    url: 'https://github.com/supermemoryai/opencode-supermemory',
    description: 'Persistent memory across sessions using Supermemory',
    npm: 'opencode-supermemory',
  },
  {
    name: '@plannotator/opencode',
    repo: 'backnotprop/plannotator',
    url: 'https://github.com/backnotprop/plannotator/tree/main/apps/opencode-plugin',
    description: 'Interactive plan review with visual annotation and private/offline sharing',
    npm: '@plannotator/opencode',
  },
  {
    name: '@openspoon/subtask2',
    repo: 'spoons-and-mirrors/subtask2',
    url: 'https://github.com/spoons-and-mirrors/subtask2',
    description:
      'Extend opencode /commands into a powerful orchestration system with granular flow control',
    npm: '@openspoon/subtask2',
  },
  {
    name: 'opencode-scheduler',
    repo: 'different-ai/opencode-scheduler',
    url: 'https://github.com/different-ai/opencode-scheduler',
    description: 'Schedule recurring jobs using launchd (Mac) or systemd (Linux) with cron syntax',
    npm: 'opencode-scheduler',
  },
  {
    name: 'opencode-conductor',
    repo: 'derekbar90/opencode-conductor',
    url: 'https://github.com/derekbar90/opencode-conductor',
    description:
      'Protocol-Driven Workflow: Automation of the Context -> Spec -> Plan -> Implement lifecycle.',
    npm: 'opencode-conductor',
  },
  {
    name: 'micode',
    repo: 'vtemian/micode',
    url: 'https://github.com/vtemian/micode',
    description: 'Structured Brainstorm → Plan → Implement workflow with session continuity',
    npm: 'micode',
  },
  {
    name: 'octto',
    repo: 'vtemian/octto',
    url: 'https://github.com/vtemian/octto',
    description: 'Interactive browser UI for AI brainstorming with multi-question forms',
    npm: 'octto',
  },
  {
    name: 'opencode-sentry-monitor',
    repo: 'stolinski/opencode-sentry-monitor',
    url: 'https://github.com/stolinski/opencode-sentry-monitor',
    description: 'Trace and debug your AI agents with Sentry AI Monitoring',
    npm: 'opencode-sentry-monitor',
  },
  {
    name: 'opencode-firecrawl',
    repo: 'firecrawl/opencode-firecrawl',
    url: 'https://github.com/firecrawl/opencode-firecrawl',
    description: 'Web scraping, crawling, and search via the Firecrawl CLI',
    // The only registry hit is an unrelated `opencode-firecrawl-ng` fork; the official repo
    // publishes no package of this name, so this row stays browse-only.
  },
  {
    name: 'opencode-jfrog-plugin',
    repo: 'jfrog/opencode-jfrog-plugin',
    url: 'https://github.com/jfrog/opencode-jfrog-plugin',
    description: 'JFrog Plugin for seamless integration of Opencode users to JFrog platform',
    npm: '@jfrog/opencode-jfrog-plugin',
  },
  {
    name: 'opencode-goal-plugin',
    repo: 'willytop8/OpenCode-goal-plugin',
    url: 'https://github.com/willytop8/OpenCode-goal-plugin',
    description:
      'Session-scoped /goal workflow that keeps objectives in context and auto-continues until complete',
    npm: 'opencode-goal-plugin',
  },
  {
    name: 'opencode-tavily',
    repo: 'tavily-ai/opencode-tavily',
    url: 'https://github.com/tavily-ai/opencode-tavily',
    description: 'Web search, extraction, crawling, and deep research via the Tavily CLI',
    npm: 'opencode-tavily',
  },
  {
    name: 'opencode-supabase',
    repo: 'supabase-community/opencode-supabase',
    url: 'https://github.com/supabase-community/opencode-supabase',
    description:
      'Supabase plugin for OpenCode: account login, Management API tools, bundled Supabase agent skills, and guided Supabase MCP setup.',
    npm: 'opencode-supabase',
  },
];
