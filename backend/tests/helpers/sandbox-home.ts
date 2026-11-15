/**
 * Test isolation: point OCR_HOME at a throwaway sandbox BEFORE any config
 * module import executes. ESM import order runs side effects in source order,
 * so `import './sandbox-home.js'` placed ABOVE a config import guarantees
 * getConfigPath() resolves inside the sandbox — never the operator's real
 * ~/.omnicell-router (a bare `getConfigPath()` write without this leaked test
 * seeds into the live environment).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-home-'));
fs.mkdirSync(path.join(home, 'envs', 'default'), { recursive: true });
process.env.OCR_HOME = home;
process.env.OCR_ENV = 'default';

// The sandbox is the test's OWN artifact, so it must not outlive the process.
// Under the isolated runner TEMP already points inside the per-file sandbox
// (deleted on green), so this is belt-and-braces — but a directly-run file
// (`bun test backend/tests/<x>.test.ts`, which AGENTS.md forbids precisely
// because it writes into real state) would otherwise leave one orphan OCR home
// per run in the OS temp root. Best effort by design: sqlite/trace handles may
// still be open when `exit` fires, and a partial prune is better than none.
process.on('exit', () => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* handles still open — the OS temp cleaner is the floor */
  }
});
