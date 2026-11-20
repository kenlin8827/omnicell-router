import { describe, it, expect } from 'bun:test';
import { runCommand } from '../../src/utils/run-command.js';

/**
 * `runCommand` is the seam every platform probe goes through (CA trust,
 * `tasklist`/`pgrep`, `keytool`, `reg`), and a probe that never settles takes
 * its whole caller with it: the Client Hub takeover answered nothing for
 * minutes — no error, no timeout — because `tasklist` wedged, `spawn`'s own
 * `timeout` only killed cmd.exe, the surviving grandchild held the stdio
 * pipes, and a promise resolving on `close` never resolved.
 *
 * The contract worth pinning is therefore the DEADLINE, not the command: the
 * process tree is killed and the result arrives even when `close` cannot.
 */
describe('runCommand deadline', () => {
  const win = process.platform === 'win32';

  it('settles instead of waiting for a close the surviving tree never lets happen', async () => {
    // A shell whose child outlives it: on Windows the outer cmd.exe dies at the
    // deadline while `ping` keeps the pipes open; on POSIX `sh -c` runs `sleep`
    // in the background so SIGKILL on the shell leaves the child holding them.
    const started = Date.now();
    const result = win
      ? await runCommand('ping', ['-n', '30', '127.0.0.1'], 700)
      : await runCommand('sh', ['-c', 'sleep 30 & wait'], 700);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('timed out after 700ms');
    // Generous bound: the point is "seconds", never "forever".
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it('still reports a fast command, with its output', async () => {
    const result = win
      ? await runCommand('cmd', ['/c', 'echo', 'hello-ocr'], 5000)
      : await runCommand('sh', ['-c', 'echo hello-ocr'], 5000);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('hello-ocr');
  }, 20_000);
});
