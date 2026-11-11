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
 * Asynchronous one-shot command runner with a timeout; never throws.
 *
 * Windows: CLI commands may be npm `.cmd` shims, so the spawn goes through
 * cmd.exe and args are pre-quoted by {@link quoteWindowsArgs}. Other platforms
 * spawn directly with an argv array.
 *
 * Lives in `utils/` (not a client adapter) because the CA-trust probe in
 * `forward-proxy/ca-trust.ts` shells out to platform trust tools too; a second
 * runner there would be a drift twin.
 */
export async function runCommand(cmd: string, args: string[], timeoutMs = 5000): Promise<CommandResult> {
  const isWin = process.platform === 'win32';
  const finalArgs = isWin ? quoteWindowsArgs(args) : args;
  let resolve: (r: CommandResult) => void = () => {};
  const promise = new Promise<CommandResult>(r => {
    resolve = r;
  });
  let stdout = '';
  let stderr = '';
  try {
    const proc = spawn(cmd, finalArgs, { timeout: timeoutMs, windowsHide: true, shell: isWin });
    proc.stdout?.on('data', (c: Buffer) => (stdout += String(c)));
    proc.stderr?.on('data', (c: Buffer) => (stderr += String(c)));
    proc.on('error', err => resolve({ ok: false, stdout, stderr: String(err) }));
    proc.on('close', code => resolve({ ok: code === 0, stdout, stderr }));
  } catch (err) {
    resolve({ ok: false, stdout, stderr: String(err) });
  }
  return promise;
}
