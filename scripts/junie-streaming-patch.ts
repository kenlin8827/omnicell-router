#!/usr/bin/env bun
/**
 * Junie client-side streaming patch — status / apply / revert.
 *
 *   bun scripts/junie-streaming-patch.ts status
 *   bun scripts/junie-streaming-patch.ts dry-run
 *   bun scripts/junie-streaming-patch.ts apply
 *   bun scripts/junie-streaming-patch.ts revert
 *
 * `apply` rewrites ONE byte inside each `junie-release-*.jar`. The JVM has to
 * reload that class, so QUIT the IDE/Junie first — on Windows an open jar is
 * locked and `jar uf` will refuse it. Re-running is safe (idempotent), and
 * `revert` restores the exact original class bytes from the rollback marker.
 *
 * A Junie upgrade replaces the jar entirely, which simply returns it to
 * `streaming-off`; re-run `apply` (or one-click setup) after each upgrade.
 */
import {
  applyJunieStreamingPatch,
  findJunieJars,
  junieStreamingStatus,
  revertJunieStreamingPatch,
} from '../plugins/jetbrains-gateway/junie-streaming.ts';

const action = (process.argv[2] ?? 'status').toLowerCase();

function printJars(jars: string[]): void {
  for (const jar of jars) console.log(`  ${jar}`);
}

if (action === 'status') {
  const jars = findJunieJars();
  if (!jars.length) {
    console.log('No Junie jar found. Set JUNIE_JAR or JUNIE_ACP_ROOT to point at one.');
    process.exit(0);
  }
  const status = junieStreamingStatus(jars);
  for (const entry of status) {
    const label = entry.state === 'streaming-on'
      ? 'STREAMING ON (patched)'
      : entry.state === 'streaming-off'
        ? 'STREAMING OFF (unpatched)'
        : 'UNKNOWN LAYOUT (refusing to patch)';
    console.log(`${label}  ${entry.jar}`);
  }
  process.exit(status.every((s) => s.state !== 'streaming-off') ? 0 : 1);
}

if (action === 'dry-run' || action === 'apply' || action === 'revert') {
  const jars = findJunieJars();
  if (!jars.length) {
    console.error('No Junie jar found. Set JUNIE_JAR or JUNIE_ACP_ROOT.');
    process.exit(1);
  }
  const result = action === 'revert'
    ? await revertJunieStreamingPatch({ jars })
    : await applyJunieStreamingPatch({ jars, dryRun: action === 'dry-run' });
  for (const outcome of result.jars) {
    console.log(`${outcome.state.toUpperCase().padEnd(8)} ${outcome.jar}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
  }
  if (action === 'dry-run') {
    console.log('\nDry run only — no jar was modified. Quit the IDE/Junie, then run `apply`.');
    process.exit(0);
  }
  if (!result.ok) {
    console.error('\nNot all jars are patched. Quit the IDE/Junie (the jar is locked) and re-run `apply`.');
    printJars(jars);
  } else if (action === 'apply') {
    console.log('\nRestart the IDE so Junie reloads the patched class.');
  }
  process.exit(result.ok ? 0 : 1);
}

console.error(`Unknown action: ${action}\nUsage: bun scripts/junie-streaming-patch.ts <status|dry-run|apply|revert>`);
process.exit(2);
