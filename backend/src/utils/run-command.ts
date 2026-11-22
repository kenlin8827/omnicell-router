import { spawn } from 'node:child_process';

/** Result of a one-shot command run: exit status plus captured output. */
export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Quote ONE argv element for a cmd.exe command line.
 *
 * Single source for both Windows spawn paths (`runCommand` for CLI shims, the
 * Cursor launcher passthrough) so they cannot drift: an arg carrying spaces or
 * cmd metacharacters gets wrapped in double quotes and an inner quote is
 * doubled. `%` inside double quotes is still cmd-expanded — paths containing
 * `%` are out of scope for both callers.
 */
export function quoteWindowsArg(arg: string): string {
  return /[\s"%^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** Array form of {@link quoteWindowsArg}. */
export function quoteWindowsArgs(args: string[]): string[] {
  return args.map(quoteWindowsArg);
}

/**
 * Asynchronous one-shot command runner with a HARD deadline; never throws.
 *
 * Windows: CLI commands may be npm `.cmd` shims, so the spawn goes through
 * cmd.exe and args are pre-quoted by {@link quoteWindowsArgs}. Other platforms
 * spawn directly with an argv array.
 *
 * The deadline is OURS, not `spawn`'s: a child's `timeout` only signals the
 * process it started (cmd.exe on Windows), while the real command — a shim, a
 * grandchild — keeps the stdio pipes open, so `close` NEVER fires. A promise
 * that settles only on `close` therefore hangs its caller forever. That is
 * exactly how a Client Hub takeover came back with no response at all: the
 * IDE-running probe (`tasklist`) wedged on one machine, the kill hit cmd.exe,
 * and the adapter's request never answered. So: kill the TREE and settle on
 * the deadline regardless of `close`. The child also gets no stdin — a shim
 * that prompts for input would otherwise wait on a pipe nobody writes.
 *
 * Lives in `utils/` (not a client adapter) because the CA-trust probe in
 * `forward-proxy/ca-trust.ts` shells out to platform trust tools too; a second
 * runner there would be a drift twin. The packaged JetBrains plugin keeps a
 * local copy of this contract (`plugins/jetbrains-gateway/exec.ts`) because a
 * plugin bundle must not import backend runtime modules.
 */
export async function runCommand(cmd: string, args: string[], timeoutMs = 5000): Promise<CommandResult> {
  const isWin = process.platform === 'win32';
  const finalArgs = isWin ? quoteWindowsArgs(args) : args;
  // `new Promise` (not `Promise.withResolvers`): the backend tsconfig targets a
  // pre-ES2024 lib, and this file is the base every probe imports.
  return await new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    // POSIX: a new process group, so the deadline can kill the whole tree (a
    // shim spawns children that keep the pipes open). Windows has no group
    // kill — `taskkill /T` below.
    const proc = spawn(cmd, finalArgs, {
      windowsHide: true,
      shell: isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(isWin ? {} : { detached: true }),
    });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => {
      stderr += `${stderr ? '\n' : ''}${cmd}: timed out after ${timeoutMs}ms`;
      if (proc.pid) {
        if (isWin) {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            proc.kill('SIGKILL');
          }
        }
      }
      // The timeout IS the contract: settle here instead of waiting for a
      // `close` the surviving grandchild may never let happen.
      finish(false);
    }, timeoutMs);
    proc.stdout?.on('data', (c: Buffer) => (stdout += String(c)));
    proc.stderr?.on('data', (c: Buffer) => (stderr += String(c)));
    proc.on('error', (err) => {
      stderr += `${stderr ? '\n' : ''}${String(err)}`;
      finish(false);
    });
    proc.on('close', (code) => finish(code === 0));
  });
}
