import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// The plugin sources live in a gitignored dev tree (a separate repository), so a
// fresh checkout has no `plugins/jetbrains-gateway`. A static import cannot be
// conditional — the file would fail at module load — so the package is loaded
// only when its directory exists; `src!` is never evaluated without it.
const pluginDir = path.resolve(import.meta.dirname, '../../../plugins/jetbrains-gateway');
const src = fs.existsSync(pluginDir) ? await import('../../../plugins/jetbrains-gateway/adapter.js') : null;
const d = src ? describe : null;

/**
 * A running IDE is a CONSENT stop, not a silent refusal.
 *
 * The write is not wrong — it is UNDONE: the IDE keeps its settings in memory
 * and rewrites `proxy.settings.xml` when it exits. So the adapter refuses with
 * `ide_running` until the caller says it meant it, and the console turns that
 * into a dialog (the probe itself fails open, so it can never lock anyone out).
 * These tests pin the refusal contract the console keys off.
 */
d?.('runningGateResult', () => {
  const { runningGateResult, JETBRAINS_PRODUCTS } = src!;
  const idea = JETBRAINS_PRODUCTS.find((p: { id: string }) => p.id === 'intellij-idea')!;
  const goland = JETBRAINS_PRODUCTS.find((p: { id: string }) => p.id === 'goland')!;

  it('blocks setup while a detected IDE runs, naming every running product', () => {
    const gate = runningGateResult([idea], 'setup', false);
    assert.ok(gate);
    assert.equal(gate.success, false);
    assert.equal(gate.reasonCode, 'ide_running');
    assert.equal(gate.params?.products, idea.displayName);
    // The reason must be the durable one: the IDE writes its memory back.
    assert.match(gate.message, /proxy\.settings\.xml/);
    assert.match(gate.message, /quit it and retry/);
  });

  it('names each product when several are running', () => {
    const gate = runningGateResult([idea, goland], 'setup', false);
    assert.equal(gate?.params?.products, `${idea.displayName}, ${goland.displayName}`);
  });

  it('lets an acknowledging caller through', () => {
    assert.equal(runningGateResult([idea], 'setup', true), null);
    assert.equal(runningGateResult([idea], 'teardown', true), null);
  });

  it('never blocks when nothing was detected', () => {
    assert.equal(runningGateResult([], 'setup', false), null);
    assert.equal(runningGateResult([], 'teardown', false), null);
  });

  it('warns teardown about the "looks unhooked but still proxied" outcome', () => {
    const gate = runningGateResult([idea], 'teardown', false);
    assert.equal(gate?.reasonCode, 'ide_running');
    assert.equal(gate?.params?.action, 'teardown');
    assert.match(gate!.message, /not hooked/);
    assert.match(gate!.message, /proxy/);
  });
});
