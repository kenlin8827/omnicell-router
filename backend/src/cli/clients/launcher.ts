import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { quoteWindowsArgs } from '../../utils/run-command.js';

/**
 * Passthrough launch verbs a client hook publishes.
 *
 * A `launcher`/`proxy-config` hook usually ships a managed script that starts
 * the client through the forward proxy. The console shows the command
 * (`ocr cursor`) and the CLI RUNS it — but neither may know which client
 * publishes which verb: that knowledge belongs to the hook, which is why the
 * adapter declares it (`ClientAdapter.launchVerbs`) and core only renders and
 * dispatches. A packaged adapter therefore adds `ocr <verb>` commands without
 * a core release, and the help text is generated, never maintained by hand.
 */
export interface ClientLaunchVerb {
  /** The word after `ocr` (`cursor`, `cursor-agent`). */
  verb: string;
  /** Absolute path of the managed launcher script this verb runs. */
  script: string;
  /**
   * The script returns before the target exits (Windows `start ""`, macOS
   * `nohup … &`): the exit code is the LAUNCHER's, not the app's, and the
   * app's own stdio never reaches us. The Linux `.sh` stays attached.
   */
  detached: boolean;
  /** One-line help, shown in `ocr help` next to the verb. */
  summary?: string;
  /**
   * What the operator must do when the script is missing (`run \`ocr setup
   * cursor-proxy\``). Declared by the hook — the runner's generic "run setup"
   * text cannot know which setup, or that a prerequisite CLI is required.
   */
  missingHint?: string;
}

/** Outcome of a passthrough launcher run. */
export interface LauncherRunResult {
  ok: boolean;
  code: number;
  /** Launcher returns before the target exits (see `ClientLaunchVerb.detached`). */
  detached: boolean;
  message?: string;
}

/**
 * Run one managed launcher, forwarding stdio and the launcher's exit code.
 *
 * The launcher SCRIPT stays the single source of the env contract (proxy flag,
 * lowercase `http(s)_proxy`, `NODE_EXTRA_CA_CERTS`), so a CLI launch and a
 * double-click can never drift apart — this function only re-executes the file
 * the hook wrote, wherever the hook happens to live.
 */
export async function runLauncherScript(
  script: string,
  argv: string[],
  detached: boolean,
  missingHint?: string
): Promise<LauncherRunResult> {
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      code: 1,
      detached,
      message: missingHint
        ? `Launcher not found at ${script} — ${missingHint}.`
        : `Launcher not found at ${script} — run the hook's setup first (Client Hub, or \`ocr setup <client>\`).`,
    };
  }
  const win = process.platform === 'win32';
  // `.cmd` needs cmd.exe; `quoteWindowsArgs` is the SAME quoting `runCommand`
  // applies to Windows shims, so an argument survives the extra shell hop.
  const args = win ? quoteWindowsArgs(argv) : argv;
  const cmd = win && /\s/.test(script) ? `"${script}"` : script;
  // Executor form on purpose: the project lib target predates
  // `Promise.withResolvers`, and the child events are the only completion path.
  return await new Promise<LauncherRunResult>((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: win, windowsHide: true });
    child.on('error', (err) => resolve({ ok: false, code: 1, detached, message: String(err) }));
    child.on('close', (code, signal) => {
      // A signal-killed child reports `code === null`; POSIX convention is
      // 128 + signum, so a caller can tell an interrupt from a real failure.
      const signum = signal ? (os.constants.signals as Record<string, number>)[signal] : undefined;
      resolve({ ok: code === 0, code: code ?? (signum ? 128 + signum : 1), detached });
    });
  });
}
