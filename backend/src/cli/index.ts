#!/usr/bin/env node
import { startDaemon, stopDaemon, restartDaemon, getStatusOutput, launchWeb, launchDesktop, getRunningPid, getDaemonInfo } from './daemon.js';
import { setupClient, teardownClient } from './clients/index.js';
import { defaultGatewayPort, type ClientActionWarning } from './clients/base.js';
import { runCursorLauncher } from './clients/cursor-proxy.js';
import { runQoderLauncher } from './clients/qoder-proxy.js';
import { registerGlobalShims, unregisterGlobalShims } from './shim.js';
import { CliAction, SupportedClient } from './types.js';
import { APP_VERSION } from '../version.js';
import {
  DEFAULT_ENV_NAME,
  createEnv,
  envExists,
  listEnvs,
  peekEnvName,
  readPointer,
  resetSandboxEnv,
  writePointer,
} from '../config/env.js';

// ANSI color helpers
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function printBanner(): void {
  console.log(`
${C.cyan}${C.bold}  ⚡ OmniCellRouter (OCR)${C.reset} ${C.dim}v${APP_VERSION}${C.reset}
  ${C.dim}High-Performance FinOps & Cascading Gateway for AI Coding Agents${C.reset}
`);
}

/** Post-setup advisories as CLI lines — the console renders the same codes as
 *  a warning toast; a CLI hook must not look healthy when HTTPS will fail. */
function formatClientWarnings(warnings: ClientActionWarning[] | undefined): string[] {
  return (warnings ?? []).map((w) => {
    switch (w.code) {
      case 'ca_not_trusted':
        return `The OS trust store does not contain the CA — HTTPS clients will fail TLS until you import ${w.params?.path ?? 'the MITM CA'}.`;
      case 'ca_trust_unknown':
        return 'CA trust could not be verified on this platform — check the Proxy Access setup wizard if HTTPS fails.';
      case 'proxy_not_running':
        return `The forward proxy is not running on port ${w.params?.port ?? '?'} — start the gateway before launching.`;
    }
  });
}

function printHelp(): void {
  printBanner();
  console.log(`${C.bold}USAGE:${C.reset}
  ocr <command> [options]
  omnicell-router <command> [options]

${C.bold}LIFECYCLE COMMANDS:${C.reset}
  ${C.green}ocr start${C.reset}               Start OCR background gateway daemon (port: config.yaml port, fallback 4000)
  ${C.green}ocr stop${C.reset}                Stop running OCR background gateway
  ${C.green}ocr restart${C.reset}             Restart OCR gateway daemon
  ${C.green}ocr status${C.reset}              Inspect daemon status, memory, health & client hooks

${C.bold}USER INTERFACE:${C.reset}
  ${C.cyan}ocr web${C.reset} (or ${C.cyan}ocr ui${C.reset})     Open OmniCellRouter Web Console in default browser
  ${C.cyan}ocr desktop${C.reset}             Open native desktop window (falls back to web if not installed)

${C.bold}CLIENT INTEGRATIONS (SETUP & TEARDOWN):${C.reset}
  ${C.magenta}ocr setup opencode${C.reset}      Hook OpenCode to route via local OCR gateway
  ${C.magenta}ocr setup opencode-proxy${C.reset} Hook OpenCode (proxy mode) via the OCR forward proxy
  ${C.magenta}ocr setup claude${C.reset}        Hook Claude Code / Desktop to route via local OCR gateway
  ${C.magenta}ocr setup codex${C.reset}         Hook Codex / OpenAI-compatible CLI to local OCR gateway
  ${C.magenta}ocr setup pi${C.reset}            Hook Pi coding agent (models.json provider) to local OCR gateway
  ${C.magenta}ocr setup dsh${C.reset}           Hook DeepSeek Harness (web profile patch) to local OCR gateway
  ${C.magenta}ocr setup cursor-proxy${C.reset}  Hook Cursor through the OCR forward proxy (writes the launchers)
  ${C.magenta}ocr setup qoder-proxy${C.reset}   Hook Qoder (desktop + qodercli) through the OCR forward proxy

  ${C.magenta}ocr cursor${C.reset} [args]        Launch Cursor through the OCR launcher (run setup first)
  ${C.magenta}ocr cursor-agent${C.reset} [args]  Launch the cursor-agent CLI through the OCR launcher
  ${C.magenta}ocr qoder${C.reset} [args]         Launch Qoder through the OCR launcher
  ${C.magenta}ocr qoder-cli${C.reset} [args]     Launch the qodercli CLI through the OCR launcher

  ${C.yellow}ocr teardown opencode${C.reset}   Unhook OpenCode and restore original configuration
  ${C.yellow}ocr teardown opencode-proxy${C.reset} Unhook OpenCode proxy mode and restore service env
  ${C.yellow}ocr teardown claude${C.reset}     Unhook Claude and restore official direct connection
  ${C.yellow}ocr teardown codex${C.reset}      Unhook Codex and restore standard settings
  ${C.yellow}ocr teardown pi${C.reset}         Unhook Pi and remove the OCR provider entry
  ${C.yellow}ocr teardown dsh${C.reset}        Unhook DeepSeek Harness and remove the OCR provider route
  ${C.yellow}ocr teardown cursor-proxy${C.reset} Unhook Cursor and remove the OCR launchers
  ${C.yellow}ocr teardown qoder-proxy${C.reset}  Unhook Qoder and remove both OCR launchers



${C.bold}ENVIRONMENTS (book-sets under ~/.omnicell-router/envs/):${C.reset}
  ${C.cyan}ocr env list${C.reset}                List environments (current = next boot picks)
  ${C.cyan}ocr env use <name>${C.reset}       Pin the active environment (or ${C.cyan}default${C.reset}); takes effect on restart
  ${C.cyan}ocr env create <name>${C.reset}     New environment [--sandbox]
  ${C.cyan}ocr env reset <name>${C.reset}      Reset a sandbox env (wipe data/traces/capture, keep config)

${C.bold}SYSTEM COMMANDS:${C.reset}
  ocr install-shims       Register global \`ocr\` and \`omnicell-router\` commands to PATH
  ocr uninstall-shims     Remove the shims THIS install wrote (marker-checked)
  ocr --version, -v       Show current OCR version
  ocr --help, -h          Display this help manual
`);
}
/** Bare launch verbs name the target tool, never a hook target: point the
 *  operator at the right id instead of the generic unknown-client message. */
const LAUNCH_VERB_HOOK_TARGETS: Record<string, SupportedClient> = {
  cursor: 'cursor-proxy',
  'cursor-agent': 'cursor-proxy',
  qoder: 'qoder-proxy',
  'qoder-cli': 'qoder-proxy',
};

function launchVerbHint(target: string, verb: 'setup' | 'teardown'): string | null {
  const hookTarget = LAUNCH_VERB_HOOK_TARGETS[target.toLowerCase()];
  return hookTarget ? `'${target}' is a launch verb, not a hook target. Run \`ocr ${verb} ${hookTarget}\`.` : null;
}

async function handleStatus(): Promise<void> {
  printBanner();
  const st = await getStatusOutput();

  console.log(`${C.bold}Service State:${C.reset}`);
  if (st.running) {
    console.log(`  ● Gateway Status : ${C.green}${C.bold}ONLINE${C.reset} (PID: ${st.pid})`);
    if (st.env) console.log(`  ● Active Env     : ${C.magenta}${st.env}${C.reset}`);
    console.log(`  ● Listening Port : ${C.cyan}http://127.0.0.1:${st.port}/v1${C.reset}`);
    console.log(`  ● Web Dashboard  : ${C.cyan}http://127.0.0.1:${st.port}/${C.reset}`);
    if (st.uptime) console.log(`  ● Active Uptime  : ${st.uptime}`);
    if (st.health) {
      const cb = st.health.circuitBreakers;
      console.log(`  ● Models Loaded  : ${st.health.modelsRegistered || 'auto'}`);
      console.log(`  ● Circuit Breaker: ${cb?.healthy ?? 0} healthy / ${cb?.tripped ?? 0} tripped`);
    }
  } else {
    console.log(`  ○ Gateway Status : ${C.red}${C.bold}STOPPED${C.reset} (Run ${C.cyan}'ocr start'${C.reset} to activate)`);
    console.log(`  ○ Target Port    : ${defaultGatewayPort()} (config.yaml)`);
  }

  // Last controlled handover verdict. A failed restart leaves NO serving
  // gateway to report through HTTP, so this file is where the operator finds
  // out why nothing came back.
  const last = st.lastRestart;
  if (last && last.status !== 'ok') {
    const when = last.finishedAt ? ` at ${last.finishedAt}` : '';
    if (last.status === 'failed') {
      console.log(
        `\n  ${C.red}⚠ Last restart FAILED${C.reset}${when}${last.error ? ` — ${last.error}` : ''}` +
          `\n    ${C.dim}${last.logFile}${C.reset}` +
          `\n    ${C.dim}Retry with ${C.reset}${C.cyan}'ocr start'${C.reset}`
      );
    } else {
      console.log(
        `\n  ${C.yellow}⚠ Last start UNVERIFIED${C.reset}${when} — the process was alive but never answered /health` +
          `\n    ${C.dim}It may still be initializing; check ${last.logFile}${C.reset}`
      );
    }
  }

  console.log(`\n${C.bold}Client Integration Status:${C.reset}`);
  for (const c of st.clients) {
    const icon = c.hooked ? `${C.green}✔ [HOOKED]${C.reset}` : `${C.dim}○ [DIRECT]${C.reset}`;
    console.log(`  ${icon} ${C.bold}${c.displayName.padEnd(22)}${C.reset} ${C.dim}->${C.reset} ${c.details}`);
    console.log(`    ${C.dim}Config: ${c.configPath}${C.reset}`);
  }
  console.log('');
}

/**
 * `ocr env <sub>` — list / use / create / reset. CLI v1 never restarts the
 * gateway itself: pointer changes are informational against a live daemon,
 * the console switch (POST /api/admin/environments/:name/switch) is the only
 * path that performs the controlled restart handover.
 */
async function handleEnvCommand(args: string[]): Promise<void> {
  const sub = (args[1] || 'list').toLowerCase();
  const target = args[2];
  const nextBoot = peekEnvName();

  switch (sub) {
    case 'list': {
      printBanner();
      const pid = getRunningPid();
      console.log(`${C.bold}Environments${C.reset} ${C.dim}(pointer: ${readPointer() ?? '(none → default)'} · next boot: ${C.reset}${C.magenta}${nextBoot}${C.reset}${C.dim})${C.reset}\n`);
      for (const e of listEnvs()) {
        const marker = e.name === nextBoot ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
        const badges = [
          e.name === DEFAULT_ENV_NAME ? `${C.yellow}bootstrap${C.reset}` : '',
          e.type === 'sandbox' ? `${C.magenta}sandbox${C.reset}` : '',
          pid && e.name === nextBoot ? ' (running)' : '',
        ]
          .filter(Boolean)
          .join(' ');
        console.log(`  ${marker} ${C.bold}${e.name.padEnd(24)}${C.reset} ${badges} ${C.dim}${e.createdAt ? `since ${e.createdAt.slice(0, 10)}` : ''}${C.reset}`);
        console.log(`    ${C.dim}${e.configPath}${C.reset}`);
      }
      console.log('');
      break;
    }

    case 'use': {
      if (!target) {
        console.error(`${C.red}✗ Usage:${C.reset} \`ocr env use <name | default>\``);
        process.exit(1);
      }
      if (target !== DEFAULT_ENV_NAME && !envExists(target)) {
        console.error(`${C.red}✗ Environment "${target}" does not exist.${C.reset} Create it with \`ocr env create ${target}\`.`);
        process.exit(1);
      }
      writePointer(target);
      const pid = getRunningPid();
      console.log(`${C.green}✔${C.reset} Next gateway boot resolves environment ${C.magenta}${target}${C.reset}.`);
      if (pid) {
        console.log(
          `${C.yellow}⚠ Gateway is RUNNING (PID ${pid}) on its boot-time environment — pointer changes take effect on restart:` +
            `\n  • Console → Environments page switch (restarts into it, recommended), or` +
            `\n  • \`ocr restart\`${C.reset}`
        );
      }
      break;
    }

    case 'create': {
      if (!target) {
        console.error(`${C.red}✗ Usage:${C.reset} \`ocr env create <name> [--sandbox]\``);
        process.exit(1);
      }
      try {
        const info = await createEnv({ name: target, type: args.includes('--sandbox') ? 'sandbox' : 'regular' });
        console.log(`${C.green}✔${C.reset} Created environment ${C.magenta}${target}${C.reset} (${info.type}) → ${C.dim}${info.dir}${C.reset}`);
        console.log(`  Config: ${info.configPath}`);
        console.log(`  Activate with ${C.cyan}\`ocr env use ${target}\`${C.reset} then restart the gateway.`);
      } catch (err: any) {
        console.error(`${C.red}✗ ${err?.message ?? err}${C.reset}`);
        process.exit(1);
      }
      break;
    }

    case 'reset': {
      if (!target) {
        console.error(`${C.red}✗ Usage:${C.reset} \`ocr env reset <sandbox-name>\``);
        process.exit(1);
      }
      try {
        // Refuse to wipe the env a live daemon is running on (the API gates
        // this via resolveEnvName; the CLI only sees the pid/info files).
        const info = getRunningPid() ? getDaemonInfo() : null;
        if (info?.env && info.env === target) {
          throw new Error(`Environment "${target}" is the RUNNING env — switch to another env before resetting it`);
        }
        resetSandboxEnv(target);
        console.log(`${C.green}✔${C.reset} Sandbox ${C.magenta}${target}${C.reset} wiped (data/traces/capture); config.yaml and env.json kept.`);
      } catch (err: any) {
        console.error(`${C.red}✗ ${err?.message ?? err}${C.reset}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`${C.red}✗ Unknown env subcommand: '${sub}'${C.reset}  (list | use | create | reset)`);
      process.exit(2);

  }
}

/**
 * Flags a caller may send through a passthrough verb to ask the TARGET for
 * information; used to explain a silent detach instead of exiting 0 with no
 * output (see `reportLaunch`).
 */
const TARGET_INFO_FLAGS = new Set(['-h', '--help', 'help', '-v', '-V', '--version', 'version']);

/** Shared reporting for every launcher-backed passthrough verb. */
async function reportLaunch(
  verb: string,
  res: { ok: boolean; code: number; detached: boolean; message?: string },
  argv: string[],
): Promise<void> {
  if (!res.ok) {
    if (res.message) console.error(`${C.red}✗ ${res.message}${C.reset}`);
    process.exitCode = res.code || 1;
    return;
  }
  // The win32/darwin desktop launcher detaches the app on purpose, so the
  // target's own stdio and exit code never come back. Say so instead of
  // exiting 0 in silence when the caller asked the target for help/version.
  if (res.detached && argv.some(a => TARGET_INFO_FLAGS.has(a))) {
    console.error(
      `${C.dim}\`ocr ${verb}\` starts the target detached on ${process.platform}, so its --help/--version output and exit code belong to the app it launches.${C.reset}`
    );
  }
  // exitCode, not process.exit: a piped stdout/stderr must be flushed first.
  process.exitCode = res.code;
}

/**
 * `ocr cursor` / `ocr cursor-agent` / `ocr qoder` / `ocr qoder-cli` are
 * PASSTHROUGH verbs: every remaining argument belongs to the target tool
 * (`--help` and `--version` included), so they are dispatched before OCR's own
 * flag parsing.
 */
async function handleClientLaunch(action: 'cursor' | 'cursor-agent' | 'qoder' | 'qoder-cli', argv: string[]): Promise<void> {
  if (action === 'qoder' || action === 'qoder-cli') {
    await reportLaunch(action, await runQoderLauncher(action === 'qoder' ? 'desktop' : 'cli', argv), argv);
    return;
  }
  await reportLaunch(action, await runCursorLauncher(action === 'cursor' ? 'ide' : 'agent', argv), argv);
}

async function main(): Promise<void> {
  // `--cli` is the dual-entry marker the packaged `ocr-backend` binary PREPENDS
  // before handing control here (the desktop bundle has no bun/node to
  // trampoline). Only that leading occurrence is the marker: a passthrough verb
  // owns every argument after it, `--cli` included.
  const raw = process.argv.slice(2);
  const args = raw[0] === '--cli' ? raw.slice(1) : raw;
  const action = (args[0] || 'status').toLowerCase() as CliAction;
  // Passthrough verbs own their remaining flags (`--help`/`--version` mean the
  // TARGET tool's help/version), so they never enter OCR's own flag parsing.
  if (action === 'cursor' || action === 'cursor-agent' || action === 'qoder' || action === 'qoder-cli') {
    await handleClientLaunch(action, args.slice(1));
    return;
  }

  if (args.includes('--help') || args.includes('-h') || action === 'help') {
    printHelp();
    return;
  }

  if (args.includes('--version') || args.includes('-v') || action === 'version') {
    console.log(`omnicell-router (ocr) v${APP_VERSION}`);
    return;
  }

  // Parse optional port flag
  let port: number | undefined;
  const portIdx = args.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
  }

  // Parse optional --env flag (start/restart): runs the gateway on a named
  // environment by injecting OCR_ENV into the daemon child.
  let envName: string | undefined;
  const envIdx = args.findIndex(a => a === '--env');
  if (envIdx !== -1 && args[envIdx + 1]) {
    envName = args[envIdx + 1];
    if (envName !== DEFAULT_ENV_NAME && !envExists(envName)) {
      console.error(`${C.red}✗ Environment "${envName}" does not exist.${C.reset} Create it with \`ocr env create ${envName}\`.`);
      process.exit(1);
    }
  }

  switch (action) {
    case 'start': {
      printBanner();
      console.log('[OCR] Starting OmniCellRouter gateway...');
      const res = await startDaemon({ port, envName });
      if (res.success) {
        console.log(`${C.green}✔ ${res.message}${C.reset}`);
        console.log(`👉 Access Web Dashboard : ${C.cyan}http://127.0.0.1:${res.port}/${C.reset}`);
        console.log(`👉 OpenAI API Base URL   : ${C.cyan}http://127.0.0.1:${res.port}/v1${C.reset}`);
      } else {
        console.error(`${C.red}✗ ${res.message}${C.reset}`);
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      printBanner();
      const res = await stopDaemon();
      if (res.success) {
        console.log(`${C.green}✔ ${res.message}${C.reset}`);
      } else {
        console.error(`${C.red}✗ ${res.message}${C.reset}`);
        process.exit(1);
      }
      break;
    }

    case 'restart': {
      printBanner();
      console.log('[OCR] Restarting OmniCellRouter gateway...');
      const res = await restartDaemon({ port, envName });
      if (res.success) {
        console.log(`${C.green}✔ ${res.message}${C.reset}`);
      } else {
        console.error(`${C.red}✗ ${res.message}${C.reset}`);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      await handleStatus();
      break;
    }

    case 'web':
    case 'ui': {
      printBanner();
      await launchWeb({ port });
      break;
    }

    case 'desktop': {
      printBanner();
      await launchDesktop({ port });
      break;
    }

    case 'setup': {
      printBanner();
      const client = args[1] as SupportedClient;
      if (!client) {
        console.error(`${C.red}✗ Missing client target.${C.reset} Usage: \`ocr setup <opencode | opencode-proxy | claude | codex | pi | dsh | omp | grok | kimi | openclaw | cursor-proxy | qoder-proxy>\``);
        process.exit(1);
      }

      const launchHint = launchVerbHint(client, 'setup');
      if (launchHint) {
        console.error(`${C.red}✗ ${launchHint}${C.reset}`);
        process.exit(1);
      }
      const res = await setupClient(client, { port });
      if (res.success) {
        console.log(`${C.green}✔ ${res.message}${C.reset}`);
        for (const line of formatClientWarnings(res.warnings)) {
          console.log(`${C.yellow}⚠ ${line}${C.reset}`);
        }
      } else {
        console.error(`${C.red}✗ ${res.message}${C.reset}`);
        process.exit(1);
      }
      break;
    }

    case 'teardown': {
      printBanner();
      const client = args[1] as SupportedClient;
      if (!client) {
        console.error(`${C.red}✗ Missing client target.${C.reset} Usage: \`ocr teardown <opencode | opencode-proxy | claude | codex | pi | dsh | omp | grok | kimi | openclaw | cursor-proxy | qoder-proxy>\``);
        process.exit(1);
      }
      const launchHint = launchVerbHint(client, 'teardown');
      if (launchHint) {
        console.error(`${C.red}✗ ${launchHint}${C.reset}`);
        process.exit(1);
      }
      const res = await teardownClient(client);
      if (res.success) {
        console.log(`${C.green}✔ ${res.message}${C.reset}`);
      } else {
        console.error(`${C.red}✗ ${res.message}${C.reset}`);
        process.exit(1);
      }
      break;
    }

    case 'env': {
      await handleEnvCommand(args);
      break;
    }

    case 'install-shims': {
      printBanner();
      const res = registerGlobalShims();
      if (res.success) {
        console.log(`${C.green}✔ ${res.message}${C.reset}`);
        console.log(`  Commands \`ocr\` and \`omnicell-router\` are now globally registered.`);
      } else {
        console.error(`${C.red}✗ ${res.message}${C.reset}`);
        process.exit(1);
      }
      break;
    }

    case 'uninstall-shims': {
      printBanner();
      const res = unregisterGlobalShims();
      if (res.removed.length === 0) {
        console.log(`${C.dim}No matching shims in ${res.binDir}.${C.reset}`);
      } else {
        for (const file of res.removed) console.log(`${C.green}✔ removed${C.reset} ${file}`);
        // The PATH entry install-shims appended is deliberately NOT reverted
        // (rc files and the Windows user PATH are operator-owned); say so
        // instead of leaving a dangling directory silently behind.
        console.log(`${C.dim}PATH entries added by install-shims stay in place — remove ${res.binDir} from PATH if you no longer need it.${C.reset}`);
      }
      break;
    }

    default: {
      console.error(`${C.red}✗ Unknown command: '${action}'${C.reset}`);
      console.error(`  Run \`ocr --help\` to see supported commands.`);
      process.exit(2);
    }
  }
}

/**
 * The module starts the CLI itself (direct `bun backend/src/cli/index.ts` use)
 * and exports the settled promise so the dual-entry `index.ts` can await it
 * before deciding to boot the gateway.
 */
export const cliReady: Promise<void> = main().catch((err) => {
  console.error(`[OCR Fatal Error] ${err.message}`);
  process.exit(1);
});
