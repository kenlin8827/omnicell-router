import './helpers/sandbox-home.js';
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { getConfigPath, saveConfig } from '../src/config/index.js';

/**
 * `PORT` is a bootstrap lever, never a file value (DEFAULT_DEV_PORT exists so
 * `bun run dev` can sit beside an installed gateway). A console save runs
 * unconditionally at boot (catalog sync), so an env-fed port must not be
 * written into config.yaml — the next restart without the env var would
 * silently relocate the gateway.
 */

const cfgPath = getConfigPath();
const ENV_PORT = 4700;
const previousPort = process.env.PORT;

beforeEach(() => {
  process.env.PORT = String(ENV_PORT);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, 'schemaVersion: 1\nclient:\n  host: 127.0.0.1\n  apiKeys: []\n', 'utf8');
});

afterEach(() => {
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
});

describe('saveConfig — PORT is never persisted as a file value', () => {
  it('a file that names no port stays port-less after a save', () => {

    assert.equal(saveConfig({ host: '127.0.0.1' }).success, true);

    const disk = parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, any>;
    assert.equal('port' in (disk.client ?? {}), false, 'the env port must not be frozen into config.yaml');
  });

  it('a port the file itself names survives an env-fed save', () => {
    fs.writeFileSync(cfgPath, 'schemaVersion: 1\nclient:\n  port: 4321\n  host: 127.0.0.1\n  apiKeys: []\n', 'utf8');

    assert.equal(saveConfig({ host: '127.0.0.1' }).success, true);

    const disk = parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, any>;
    assert.equal(disk.client?.port, 4321, 'the file value wins over PORT and is re-persisted verbatim');
  });
});
