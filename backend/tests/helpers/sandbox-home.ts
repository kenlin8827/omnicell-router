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
