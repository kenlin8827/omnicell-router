import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { hashFile } from '../../hash.js';
import { adapterFor, isPluginHost } from '../adapters/index.js';
import { claimPath, readManifest, writeManifest } from '../manifest.js';
import type { InstallSkipped } from './skill.js';
import { createBackup, safeWriteJson } from '../../../cli/clients/base.js';
import type { HarnessHostId, HarnessScope, Pin, TrustTier } from '../../types.js';

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
  /** Hard timeout for one subprocess run. */
  timeoutMs?: number;
}

export type ExecImpl = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface PluginTargetPlan {
  host: HarnessHostId;
  /** `subprocess` (package install) or `config` (`plugin[]` merge). */
  op: 'subprocess' | 'config';
  file?: string;
  container?: string;
  /** Structured command for subprocess targets — apply runs THIS, `echo` is display-only. */
  command?: string;
  args?: string[];
  /** The EXACT command that apply will run — gate 3 says it verbatim, never paraphrased. */
  echo?: string;
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
 * Windows: a runtime CLI is usually an npm `.cmd` shim, which libuv cannot exec without a shell
 * (`spawn('pi', …, {shell:false})` → ENOENT even though `where pi` resolves it). The line goes
 * through cmd.exe and args carrying cmd metacharacters are pre-quoted for it — the same rule as
 * `cli/clients/opencode-proxy.ts:runOpenCode`, and safe here because `safeSpec` already rejects
 * anything shell-shaped. Other platforms spawn directly with an argv array.
 */
function defaultExec(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const isWin = process.platform === 'win32';
  const finalArgs = isWin ? args.map((a) => (/\s"%^&|<>()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args;
  return new Promise((resolve) => {
    const child = spawn(command, finalArgs, { shell: isWin, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT here means the harness CLI itself is not on PATH — say that, not just `spawn failed`.
      const message = e.code === 'ENOENT' ? `${command}: executable not found on PATH (${e.message})` : e.message;
      resolve({ code: -1, stdout, stderr: `${stderr}${message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
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
  const spec = safeSpec(req.spec);
  if (!spec) return { ok: false, code: 'bad_request', message: `invalid package spec '${req.spec}'` };
  const targets: PluginTargetPlan[] = [];
  const host = req.harness;
  const adapter = adapterFor(host);
  if (!isPluginHost(adapter)) {
    targets.push({ host, op: 'config', refused: `host '${host}' has no verified plugin landing`, added: false });
    return { ok: true, targets };
  }
  const ext = adapter;
  const landing = ext.writeTarget({ projectRoot: req.projectRoot ?? process.cwd() }, req.scope);
  if (!landing.ok) {
    targets.push({ host, op: 'config', refused: landing.reason, added: false });
    return { ok: true, targets };
  }
  if (landing.op === 'subprocess') {
    // The adapter owns the argument grammar (pi: `install npm:<spec>`; claude: `plugin install
    // <id> --scope user`) — the writer only passes the spec and composes the gate-3 echo.
    const args = landing.args ? landing.args(spec, req.scope) : ['install', `npm:${spec}`];
    targets.push({
      host,
      op: 'subprocess',
      command: landing.command,
      args,
      echo: [landing.command, ...args].join(' '),
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

  const copies: { host: HarnessHostId; path?: string; external?: boolean }[] = [];
  const runs: { host: string; command: string; code: number; stdout: string; stderr: string }[] = [];
  const skipped: InstallSkipped[] = [];
  let firstConfigHash: string | undefined;

  for (const target of plan.targets) {
    if (target.refused) {
      skipped.push({ host: target.host, code: 'bad_request', message: target.refused });
      continue;
    }
    if (target.op === 'subprocess') {
      // Gate 3: the command was echoed in the plan and confirmed; never append -y/--yes here.
      const result = await run(target.command!, target.args!, timeoutMs);
      runs.push({ host: target.host, command: target.echo!, code: result.code, stdout: result.stdout, stderr: result.stderr });
      if (result.code !== 0) {
        skipped.push({ host: target.host, code: 'upstream', message: `${target.echo} exited ${result.code}: ${result.stderr.slice(0, 200)}` });
        continue;
      }
      // A subprocess install materializes into the runtime's own store — no file path of ours exists,
      // so the copy is marked `external` and its `path` is an opaque identity token, not a location.
      // The run log above is the audit trail.
      copies.push({ host: target.host, path: `${req.canonicalKey}#${target.host}`, external: true });
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
    copies.push({ host: target.host, path: target.file });
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
