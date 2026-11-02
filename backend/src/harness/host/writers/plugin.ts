import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { hashFile } from '../../hash.js';
import { adapterFor, isPluginHost } from '../adapters/index.js';
import type { PluginHost, PluginMarketplaceInstall } from '../adapters/types.js';
import { claimPath, readManifest, writeManifest } from '../manifest.js';
import { installViaKimiWeb, installMarketplaceRepoViaKimiWeb, MARKET_REPO_RE, type KimiWebDeps } from './kimi-web.js';
import type { InstallSkipped } from './skill.js';
import { createBackup, safeWriteJson } from '../../../cli/clients/base.js';
import type { HarnessHostId, HarnessScope, Pin, TrustTier } from '../../types.js';
import { latestSnapshot } from '../../common/market.js';

/**
 * Plugin kind writer (ADR-0015 §D8) — package install or `plugin[]` array edit.
 *
 * The install surface is the runtime's OWN CLI, declared on the adapter (`pi install npm:<spec>`;
 * `claude plugin install <id> --scope user`) — the writer composes the argument vector the adapter
 * spells and echoes it verbatim; it never invents a grammar of its own.
 *
 * One request targets exactly ONE harness: an plugin is code written against that runtime's
 * plugin API, so the harness is part of the artifact identity (`plugin:<harness>:<canonicalKey>`)
 * and is never a multi-select landing choice (ADR-0015 §D2).
 *
 * Gate 3, verbatim discipline: a package install EXECUTES THIRD-PARTY CODE (npm lifecycle scripts).
 * The plan echoes the EXACT command; the orchestrator refuses to apply without the caller's
 * confirmation; the runner never appends `-y`/`--yes`, runs with a hard timeout, and captures
 * stdout/stderr for the ledger.
 *
 * `plugin[]` edits are plain config merges with the same backup + atomic-rename discipline as the
 * MCP writer (`createBackup` + `safeWriteJson`), refusing anything a JSON round-trip would mangle.
 */

export interface PluginApplyRequest {
  sourceId: string;
  canonicalKey: string;
  /**
   * The source's one-line description; persisted so an installed package row can show what the
   * market showed (an `external` copy has no file of ours to read prose from).
   */
  description?: string | null;
  /** Package spec (npm name@range / URL) — inserted verbatim, never interpolated into a shell. */
  spec: string;
  trust: TrustTier;
  /** Listing surfaces recorded with the manifest (writer source first); absent = `[sourceId]`. */
  listedOn?: string[];
  /**
   * Provenance the source adapter resolved for this exact spec (`{npm:{integrity}}`), written to the
   * manifest verbatim. Absent = the caller has no provenance to claim (the manual escape hatch), and
   * the writer records `{adopted:true}` — it must never pretend a pin exists.
   */
  pin?: Pin;
  /**
   * The ONE runtime this plugin is written for. An plugin is code against a specific plugin
   * API, so the harness is part of the artifact's identity — never a multi-select landing choice.
   */
  harness: HarnessHostId;
  scope: HarnessScope;
  projectRoot?: string;
  /** Injectable process runner (house test style); defaults to a spawn-based impl. */
  execImpl?: ExecImpl;
  /** Injectable HTTP fetch (webapi targets; house test style). */
  fetchImpl?: typeof fetch;
  /** Test seam for webapi targets (fake spawn/fetch/home); production leaves it undefined. */
  webApiDeps?: KimiWebDeps;
  /** Hard timeout for one subprocess run. */
  timeoutMs?: number;
  /**
   * A GIT-BACKED row whose runtime installs it natively (ADR-0015 §D9 amendment): the writer runs
   * the host's own marketplace chain — register the repository, then install `<plugin>@<name>` —
   * instead of resolving a payload. `plugin`/`name` come from the source's own manifest.
   */
  marketplace?: { repo: string; plugin: string; name: string };
}

export type ExecImpl = (
  command: string,
  args: string[],
  timeoutMs: number,
  /** Working directory for the child — the install's `projectRoot` when a scope needs one. */
  cwd?: string
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** One argv the plan will run, echoed verbatim (`echo` is what gate 3 shows). */
export interface PluginRun {
  command: string;
  args: string[];
  echo: string;
}

export interface PluginTargetPlan {
  host: HarnessHostId;
  /**
   * `subprocess` (a command chain: npm package grammar or the native marketplace chain),
   * `config` (a `plugin[]` merge), `manual` (an interactive runtime whose command the operator
   * must run themselves — displayed, never spawned), or `webapi` (the runtime's own loopback
   * REST install API — the writer boots the vendor server transiently and posts the source).
   */
  op: 'subprocess' | 'config' | 'manual' | 'webapi';
  file?: string;
  container?: string;
  /** Structured command for a single-run subprocess target — apply runs THIS. */
  command?: string;
  args?: string[];
  /** The EXACT command that apply will run — gate 3 says it verbatim, never paraphrased. */
  echo?: string;
  /** Native chains run in ORDER; the first non-zero exit stops the chain. */
  runs?: PluginRun[];
  /** `webapi` only: the plugin source string POSTed to the runtime's install route. */
  source?: string;
  /** `webapi` only: a marketplace-row identity — apply stages a local clone and posts its path
   *  (the vendor's GitHub resolver cannot install a marketplace-form repository; its local-path
   *  branch can). */
  cloneRepo?: string;
  refused?: string;
  added: boolean;
}

export type PluginPlan = { ok: true; targets: PluginTargetPlan[] } | { ok: false; code: 'bad_request'; message: string };

export type PluginApplyResult =
  | {
      ok: true;
      artifactId: string;
      name: string;
      /** `external` marks a package-manager-owned copy: `path` is an identity token, not a location. */
      copies: { host: string; path?: string; external?: boolean }[];
      /** Captured subprocess output, forwarded to the apply ledger. */
      runs: { host: string; command: string; code: number; stdout: string; stderr: string }[];
      skipped: InstallSkipped[];
    }
  | {
      ok: false;
      code: 'no_target' | 'exists' | 'foreign' | 'bad_request' | 'upstream';
      message: string;
      skipped?: InstallSkipped[];
      /** Subprocess runs from a failed apply — forwarded to the ledger for the gate-3 audit. */
      runs?: { host: string; command: string; code: number; stdout: string; stderr: string }[];
    };

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * npm specs are installed verbatim; refuse anything shell-shaped or path-escaping. A leading `-` is
 * refused too (an argument, never a package name), and so is any `..` segment — npm would resolve
 * that as a LOCAL directory instead of a registry package.
 */
export function safeSpec(spec: string): string | null {
  if (!/^[@\w][@\w./-]*$/.test(spec)) return null;
  if (spec.includes('..')) return null;
  return spec;
}

/**
 * The source string a webapi target posts to the runtime's install route. Only GIT-BACKED keys
 * are answerable: strip the source-id prefix (`github:`, `mp-<slug>:`), drop a layer/version pin
 * (`#dir`, `@v1` — the vendor resolves the plugin root from its own manifest), and require the
 * `owner/repo` grammar the runtime's GitHub resolver reads. Anything else is refused, not guessed.
 */
function webApiSource(canonicalKey: string): { ok: true; url: string } | { ok: false; message: string } {
  const ref = canonicalKey.replace(/^[^:\s]+:/, '').replace(/^github:/, '');
  const repo = ref.replace(/[#@].*$/, '');
  if (!MARKET_REPO_RE.test(repo)) {
    return { ok: false, message: `webapi install needs a github repository key, got '${canonicalKey}'` };
  }
  return { ok: true, url: `https://github.com/${repo}` };
}
/** A plugin/marketplace id token (`postman`, `claude-plugins-official`, `@scope/pkg`). */
const MARKET_NAME_RE = /^[@A-Za-z0-9][@A-Za-z0-9._-]*$/;

/** One argv item: no whitespace and no shell metacharacters — the chain is never given to a shell. */
function safeArg(value: string): boolean {
  return !/[\s"'`;&|<>$\\]/.test(value);
}

/** Substitute `{token}` placeholders; an unknown token fails the whole template (never blanks it). */
function fillTemplate(template: string, ctx: Record<string, string>): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = ctx[key];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : out;
}

/**
 * Expand one host's marketplace chain into runnable argv vectors. Every token is validated BEFORE
 * it becomes an argument: a repository is `owner/repo`, an id carries no whitespace, and the final
 * argv item may not smuggle a shell metacharacter (the writer never shells out).
 */
function marketplaceRuns(
  spec: PluginMarketplaceInstall,
  req: PluginApplyRequest,
): { ok: true; runs: PluginRun[] } | { ok: false; message: string } {
  const identity = req.marketplace!;
  if (!MARKET_REPO_RE.test(identity.repo)) return { ok: false, message: `invalid repository '${identity.repo}'` };
  if (!MARKET_NAME_RE.test(identity.plugin)) return { ok: false, message: `invalid plugin name '${identity.plugin}'` };
  if (!MARKET_NAME_RE.test(identity.name)) return { ok: false, message: `invalid marketplace name '${identity.name}'` };
  const ctx: Record<string, string> = {
    repo: identity.repo,
    url: `https://github.com/${identity.repo}`,
    urlGit: `https://github.com/${identity.repo}.git`,
    plugin: identity.plugin,
    marketplace: identity.name,
    // The runtimes that take a scope spell it `user`; project scope keeps the vendor's own word.
    scope: req.scope === 'project' ? 'project' : 'user',
  };
  const runs: PluginRun[] = [];
  for (const argv of spec.commands) {
    const filled = argv.map((token) => fillTemplate(token, ctx));
    if (filled.length < 2 || filled.some((item) => item === null)) {
      return { ok: false, message: `incomplete marketplace command template '${argv.join(' ')}'` };
    }
    const items = filled as string[];
    if (!items.every(safeArg)) return { ok: false, message: `unsafe marketplace command token in '${items.join(' ')}'` };
    const [command, ...args] = items as [string, ...string[]];
    runs.push({ command, args, echo: items.join(' ') });
  }
  if (runs.length === 0) return { ok: false, message: 'marketplace chain is empty' };
  return { ok: true, runs };
}

/**
 * Windows: a runtime CLI is usually an npm `.cmd` shim, which libuv cannot exec without a shell
 * (`spawn('pi', …, {shell:false})` → ENOENT even though `where pi` resolves it). The line goes
 * through cmd.exe and args carrying cmd metacharacters are pre-quoted for it — the same rule as
 * `cli/clients/opencode-proxy.ts:runOpenCode`, and safe here because `safeSpec` already rejects
 * anything shell-shaped. Other platforms spawn directly with an argv array.
 */
export function defaultExec(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const isWin = process.platform === 'win32';
  const finalArgs = isWin ? args.map((a) => (/\s"%^&|<>()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args;
  // A scope-aware install (`claude --scope project`, `pi install --local`, `omp --scope project`)
  // resolves its landing from the child's cwd — anchor it to the verified project root, not to this
  // process's cwd (which is the gateway's, never the operator's project).
  const child = spawn(command, finalArgs, {
    shell: isWin,
    windowsHide: true,
    // POSIX: a new process group, so the timeout can kill the whole tree (a package manager
    // spawns children that keep the pipes open). Windows has no group kill — `taskkill /T` below.
    ...(isWin ? {} : { detached: true }),
    ...(cwd ? { cwd } : {}),
  });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killTree = (): void => {
      if (!child.pid) return;
      if (isWin) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      killTree();
      // A shim that outlives its parent can hold the pipes open past the kill; the timeout is the
      // contract, so settle it here rather than hanging the install on a `close` that may not come.
      setTimeout(
        () => finish({ code: -1, stdout, stderr: `${stderr}\n${command}: timed out after ${timeoutMs}ms` }),
        5000
      ).unref?.();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (e: NodeJS.ErrnoException) => {
      // ENOENT here means the harness CLI itself is not on PATH — say that, not just `spawn failed`.
      const message = e.code === 'ENOENT' ? `${command}: executable not found on PATH (${e.message})` : e.message;
      finish({ code: -1, stdout, stderr: `${stderr}${message}` });
    });
    child.on('close', (code) => {
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

function readConfigObject(file: string): { ok: true; config: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'config root is not a JSON object' };
    }
    return { ok: true, config: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'config is not valid plain JSON; refusing a lossy rewrite' };
  }
}

export function planPlugin(req: PluginApplyRequest): PluginPlan {
  // A GIT-BACKED row needs no package spec at all: its runtime installs from the marketplace. The
  // native chain is planned FIRST, before any spec grammar is applied.
  const targets: PluginTargetPlan[] = [];
  const host = req.harness;
  const adapter = adapterFor(host);
  // Scope capability gate (ADR-0015 §D2): a host whose adapter declares no project plugin landing
  // (codex, kimi, cursor, antigravity, grok) must refuse a project install up front — landing
  // global while the manifest records `project` would split the manifest, the inventory and
  // uninstall across different truths. This covers every landing form below, the marketplace
  // chain included: `writeTarget` already refuses the local forms, but the native chain never
  // consults it (a cursor row would plan `/plugin install` for a project scope the runtime has
  // no grammar for).
  // A host with NO plugin landing at all (universal, dsh) falls through to the landing checks
  //  below — its refusal ("no verified plugin landing") is more informative than a scope claim.
  const pluginScopes = adapter?.supportedScopes('plugin') ?? [];
  if (pluginScopes.length > 0 && !pluginScopes.includes(req.scope)) {
    targets.push({
      host,
      op: 'config',
      refused: `host '${host}' declares no ${req.scope}-scope plugin landing`,
      added: false,
    });
    return { ok: true, targets };
  }
  if (req.marketplace) {
    const chain = (adapter as Partial<PluginHost>)?.marketplaceSpec?.() ?? null;
    // No CLI chain: fall through to the webapi landing below when the runtime has one (kimi
    // web) — the repository URL is derived from the canonical key there. Refuse only when the
    // host has neither landing.
    if (!chain && !(adapter as Partial<PluginHost>)?.webApiSpec?.()) {
      targets.push({ host, op: 'config', refused: `host '${host}' declares no native marketplace install form`, added: false });
      return { ok: true, targets };
    }
    if (chain) {
      const built = marketplaceRuns(chain, req);
      if (!built.ok) return { ok: false, code: 'bad_request', message: built.message };
      targets.push({
        host,
        op: chain.interactive ? 'manual' : 'subprocess',
        runs: built.runs,
        echo: built.runs[built.runs.length - 1]!.echo,
        ...(chain.interactive
          ? { refused: `'${host}' installs plugins only from inside a session — run the shown command there` }
          : {}),
        added: true,
      });
      return { ok: true, targets };
    }
    // No chain but a webapi landing: fall through — the webapi branch below derives the
    // repository URL from the canonical key and posts it to the runtime's own install route.
  }

  // A runtime with a LOCAL REST install API (kimi web's kap-server) answers a git-backed row by
  // posting the repository — the vendor's own PluginManager runs the download/manifest/copy,
  // never this writer. Precedes the generic spec flow: there is no package spec or config file.
  const webApi = (adapter as Partial<PluginHost>)?.webApiSpec?.() ?? null;
  if (webApi) {
    const src = webApiSource(req.canonicalKey);
    if (!src.ok) return { ok: false, code: 'bad_request', message: src.message };
    // The vendor's PluginManager installs only what the repository's OWN form declares. The probe
    // recorded which harnesses the tree supports; a repo whose only form is another vendor's (a
    // Claude-format marketplace) is refused HERE, not after booting the vendor into a 40001.
    const mp = /^mp-([a-z0-9][a-z0-9-]{0,38}):/.exec(req.canonicalKey);
    if (mp) {
      const snap = latestSnapshot(mp[1]!, null);
      if (snap && snap.hosts.length > 0 && !snap.hosts.includes(host as HarnessHostId)) {
        targets.push({
          host,
          op: 'config',
          refused: `repository declares no '${host}' plugin form (detected: ${snap.hosts.join(', ')})`,
          added: false,
        });
        return { ok: true, targets };
      }
    }
    // A marketplace row stages a local clone and posts its absolute path: the vendor's GitHub
    // resolver cannot install a marketplace-form repository (it rebuilds `<repo>@<plugin>@<market>`
    // as a git ref and 404s — verified against the shipped v2.4.1 binary), while its local-path
    // branch installs cleanly. The clone is the writer's staging dir, removed after apply.
    const cloneRepo = req.marketplace && MARKET_REPO_RE.test(req.marketplace.repo) ? req.marketplace.repo : undefined;
    const post = `POST ${webApi.apiPrefix}/plugins {"source":"${cloneRepo ? `<staging clone of ${cloneRepo}>` : src.url}"}`;
    targets.push({
      host,
      op: 'webapi',
      source: src.url,
      ...(cloneRepo ? { cloneRepo } : {}),
      echo: cloneRepo
        ? `git clone --depth 1 https://github.com/${cloneRepo}.git (staging) → ${webApi.serverCommand} (transient loopback server) → ${post}`
        : `${webApi.serverCommand} (transient loopback server) → ${post}`,
      added: true,
    });
    return { ok: true, targets };
  }
  if (!isPluginHost(adapter)) {
    targets.push({ host, op: 'config', refused: `host '${host}' has no verified plugin landing`, added: false });
    return { ok: true, targets };
  }
  const ext = adapter;
  const spec = safeSpec(req.spec);
  if (!spec) return { ok: false, code: 'bad_request', message: `invalid package spec '${req.spec}'` };
  const landing = ext.writeTarget({ projectRoot: req.projectRoot ?? process.cwd() }, req.scope);
  if (!landing.ok) {
    targets.push({ host, op: 'config', refused: landing.reason, added: false });
    return { ok: true, targets };
  }
  if (landing.op === 'subprocess') {
    // The adapter owns the argument grammar (pi: `install npm:<spec>`; claude: `plugin install
    // <id> --scope user`) — a host that declares none refuses the spec instead of guessing.
    if (!landing.args) {
      targets.push({ host, op: 'config', refused: `host '${host}' declares no package-install grammar`, added: false });
      return { ok: true, targets };
    }
    const args = landing.args(spec, req.scope);
    targets.push({
      host,
      op: 'subprocess',
      command: landing.command,
      args,
      echo: [landing.command, ...args].join(' '),
      runs: [{ command: landing.command, args, echo: [landing.command, ...args].join(' ') }],
      added: true,
    });
    return { ok: true, targets };
  }
  let added = true;
  let refused: string | undefined;
  // Write into the container the file ALREADY uses (`plugins` on a v2 opencode config), falling back
  // to the adapter's declared default: an install that lands in a key the runtime ignores would be
  // indistinguishable from a successful one (§D8.8).
  let container = landing.container;
  if (fs.existsSync(landing.path)) {
    const parsed = readConfigObject(landing.path);
    if (!parsed.ok) refused = parsed.reason;
    else {
      container = ext.containers().find((key) => Array.isArray(parsed.config[key])) ?? container;
      const arr = parsed.config[container];
      if (Array.isArray(arr) && arr.includes(spec)) added = false;
    }
  }
  targets.push({ host, op: 'config', file: landing.path, container, refused, added });
  return { ok: true, targets };
}

export async function applyPlugin(req: PluginApplyRequest): Promise<PluginApplyResult> {
  const plan = planPlugin(req);
  if (!plan.ok) return { ok: false, code: plan.code, message: plan.message };
  // The harness is part of the identity: the same package installed into opencode and `pi` is two
  // artifacts, because each is code against a different plugin API (ADR-0015 §D2).
  const artifactId = `plugin:${req.harness}:${req.canonicalKey}`;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = req.execImpl ?? defaultExec;

  const copies: { host: HarnessHostId; path?: string; external?: boolean; projectRoot?: string }[] = [];
  const runs: { host: string; command: string; code: number; stdout: string; stderr: string }[] = [];
  const skipped: InstallSkipped[] = [];
  let firstConfigHash: string | undefined;

  for (const target of plan.targets) {
    if (target.refused) {
      skipped.push({ host: target.host, code: 'bad_request', message: target.refused });
      continue;
    }

    if (target.op === 'webapi') {
      // The vendor's loopback server does the install (same PluginManager the TUI drives). A
      // marketplace row first stages a local clone — the vendor's GitHub resolver cannot install
      // a marketplace-form repository; its local-path branch can. The copy lands in the runtime's
      // own store — `external`, exactly like a subprocess install.
      const deps = {
        ...(req.webApiDeps ?? {}),
        ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}),
        ...(req.timeoutMs ? { installTimeoutMs: req.timeoutMs } : {}),
      };
      const outcome = target.cloneRepo
        ? await installMarketplaceRepoViaKimiWeb(target.cloneRepo, deps)
        : await installViaKimiWeb(target.source!, deps);
      runs.push({
        host: target.host,
        command: target.echo!,
        code: outcome.ok ? 0 : -1,
        stdout: outcome.ok ? JSON.stringify(outcome.plugin) : '',
        stderr: outcome.ok ? '' : outcome.message,
      });
      if (!outcome.ok) {
        skipped.push({ host: target.host, code: 'upstream', message: outcome.message });
        continue;
      }
      // External token copies carry no path to attribute by — `projectRoot` is the only marker.
      copies.push({
        host: target.host,
        path: `${req.canonicalKey}#${target.host}`,
        external: true,
        ...(req.scope === 'project' && req.projectRoot ? { projectRoot: req.projectRoot } : {}),
      });
      continue;
    }
    if (target.op === 'subprocess') {
      // Gate 3: every command was echoed in the plan and confirmed; never append -y/--yes here.
      // A native marketplace chain runs in order and stops at the first non-zero exit — a failed
      // `marketplace add` must not be followed by an install that would silently use a stale one.
      const chain = target.runs ?? [{ command: target.command!, args: target.args ?? [], echo: target.echo! }];
      let failed = false;
      for (const step of chain) {
        const result = await run(step.command, step.args, timeoutMs, req.projectRoot);
        runs.push({ host: target.host, command: step.echo, code: result.code, stdout: result.stdout, stderr: result.stderr });
        if (result.code !== 0) {
          skipped.push({ host: target.host, code: 'upstream', message: `${step.echo} exited ${result.code}: ${result.stderr.slice(0, 200)}` });
          failed = true;
          break;
        }
      }
      if (failed) continue;
      // A subprocess install materializes into the runtime's own store — no file path of ours exists,
      // so the copy is marked `external` and its `path` is an opaque identity token, not a location.
      // The run log above is the audit trail.
      copies.push({
        host: target.host,
        path: `${req.canonicalKey}#${target.host}`,
        external: true,
        ...(req.scope === 'project' && req.projectRoot ? { projectRoot: req.projectRoot } : {}),
      });
      continue;
    }
    // plugin[] array edit — same ownership + backup + atomic-rename discipline as the MCP writer.
    const claim = claimPath(target.file!, artifactId);
    if (!claim.ok) {
      skipped.push({ host: target.host, code: 'foreign', message: `${target.file} is claimed by environment '${claim.env}'` });
      continue;
    }
    const parsed: { ok: true; config: Record<string, unknown> } | { ok: false; reason: string } = fs.existsSync(target.file!)
      ? readConfigObject(target.file!)
      : { ok: true, config: {} };
    if (!parsed.ok) {
      skipped.push({ host: target.host, code: 'bad_request', message: parsed.reason });
      continue;
    }
    const container = parsed.config[target.container!];
    const arr = Array.isArray(container) ? (container as unknown[]) : (parsed.config[target.container!] = []);
    if (!arr.includes(req.spec)) arr.push(req.spec);
    try {
      createBackup(target.file!);
      safeWriteJson(target.file!, parsed.config);
    } catch (e) {
      skipped.push({ host: target.host, code: 'upstream', message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    firstConfigHash ??= hashFile(target.file!);
    copies.push({
      host: target.host,
      path: target.file,
      ...(req.scope === 'project' && req.projectRoot ? { projectRoot: req.projectRoot } : {}),
    });
  }

  // A failed subprocess run with no successful target must NOT mint a manifest entry — the guard is
  // copies-only (a failed run still fills `runs`); the runs travel on the failure variant instead.
  if (copies.length === 0) {
    return { ok: false, code: skipped[0]?.code ?? 'no_target', message: skipped.map((s) => `${s.host}: ${s.message}`).join('; ') || 'no plugin target', skipped, runs };
  }

  const manifest = readManifest();
  const now = new Date().toISOString();
  const previous = manifest.artifacts.find((a) => a.id === artifactId);
  const kept = (previous?.copies ?? []).filter((c) => !copies.some((item) => item.path && item.path === c.path));
  const contentHash = firstConfigHash ?? `subprocess:${runs.map((r) => `${r.host}@${r.code}`).join(',')}`;
  manifest.artifacts = [
    ...manifest.artifacts.filter((a) => a.id !== artifactId),
    {
      id: artifactId,
      canonicalKey: req.canonicalKey,
      kind: 'plugin',
      harness: req.harness,
      name: req.spec,
      // A native marketplace install has TWO identities: the market row's key (above, what the
      // console marks installed) and the runtime's own (`<plugin>@<marketplace>`). Recording the
      // second lets discovery exclude the record it reads back — otherwise one install shows twice.
      ...(req.marketplace
        ? { nativeKey: `${req.marketplace.plugin}@${req.marketplace.name}` }
        : {}),
      ...(req.description ? { description: req.description } : {}),
      sourceId: req.sourceId,
      // `ref` is the canonicalKey WITHOUT its `<sourceId>:` prefix. It is derived from the key, not
      // from `sourceId`: a discovery source may answer ANOTHER source's identity (npm
      // resolves to `npm:<pkg>` — the artifact IS that package), and slicing by the requesting
      // source's own length would then cut the ref in the wrong place.
      ref: req.canonicalKey.includes(':')
        ? req.canonicalKey.slice(req.canonicalKey.indexOf(':') + 1)
        : req.canonicalKey,
      // Provenance comes from the adapter; only a payload with no pin at all (manual spec) is
      // `adopted`, and that word means exactly "no upstream claim to verify".
      pin: req.pin ?? { adopted: true },
      contentHash,
      listedOn: req.listedOn ?? [req.sourceId],
      trust: req.trust,
      copies: [
        ...kept,
        ...copies.map((item) => ({
          scope: req.scope,
          host: item.host,
          rootId: 'default',
          path: item.path ?? `${req.canonicalKey}#${item.host}`,
          ...(item.external ? { external: true } : {}),
          ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
          contentHash,
          placement: 'materialized' as const,
          installedAt: now,
        })),
      ],
    },
  ];
  writeManifest(manifest);

  return { ok: true, artifactId, name: req.spec, copies, runs, skipped };
}
