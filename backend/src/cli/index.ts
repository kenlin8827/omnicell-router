#!/usr/bin/env node
import { startDaemon, stopDaemon, restartDaemon, getStatusOutput, launchWeb, launchDesktop } from './daemon.js';
import { setupClient, teardownClient, getAllClientStatuses } from './clients/index.js';
import { defaultGatewayPort } from './clients/base.js';
import { registerGlobalShims } from './shim.js';
import { CliAction, SupportedClient } from './types.js';
import { APP_VERSION } from '../version.js';

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
${C.cyan}${C.bold}  ⚡ OpenCode Router (OCR)${C.reset} ${C.dim}v${APP_VERSION}${C.reset}
  ${C.dim}High-Performance FinOps & Cascading Gateway for AI Coding Agents${C.reset}
`);
}

function printHelp(): void {
  printBanner();
  console.log(`${C.bold}USAGE:${C.reset}
  ocr <command> [options]
  opencode-router <command> [options]

${C.bold}LIFECYCLE COMMANDS:${C.reset}
  ${C.green}ocr start${C.reset}               Start OCR background gateway daemon (port: config.yaml port, fallback 4000)
  ${C.green}ocr stop${C.reset}                Stop running OCR background gateway
  ${C.green}ocr restart${C.reset}             Restart OCR gateway daemon
  ${C.green}ocr status${C.reset}              Inspect daemon status, memory, health & client hooks

${C.bold}USER INTERFACE:${C.reset}
  ${C.cyan}ocr web${C.reset} (or ${C.cyan}ocr ui${C.reset})     Open OpenCode Router Web Console in default browser
  ${C.cyan}ocr desktop${C.reset}             Open native desktop window (falls back to web if not installed)

${C.bold}CLIENT INTEGRATIONS (SETUP & TEARDOWN):${C.reset}
  ${C.magenta}ocr setup opencode${C.reset}      Hook OpenCode to route via local OCR gateway
  ${C.magenta}ocr setup opencode-proxy${C.reset} Hook OpenCode (proxy mode) via the OCR forward proxy
  ${C.magenta}ocr setup claude${C.reset}        Hook Claude Code / Desktop to route via local OCR gateway
  ${C.magenta}ocr setup codex${C.reset}         Hook Codex / OpenAI-compatible CLI to local OCR gateway

  ${C.yellow}ocr teardown opencode${C.reset}   Unhook OpenCode and restore original configuration
  ${C.yellow}ocr teardown opencode-proxy${C.reset} Unhook OpenCode proxy mode and restore service env
  ${C.yellow}ocr teardown claude${C.reset}     Unhook Claude and restore official direct connection
  ${C.yellow}ocr teardown codex${C.reset}      Unhook Codex and restore standard settings

${C.bold}SYSTEM COMMANDS:${C.reset}
  ocr install-shims       Register global \`ocr\` and \`opencode-router\` commands to PATH
  ocr --version, -v       Show current OCR version
  ocr --help, -h          Display this help manual
`);
}

async function handleStatus(): Promise<void> {
  printBanner();
  const st = await getStatusOutput();

  console.log(`${C.bold}Service State:${C.reset}`);
  if (st.running) {
    console.log(`  ● Gateway Status : ${C.green}${C.bold}ONLINE${C.reset} (PID: ${st.pid})`);
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

  console.log(`\n${C.bold}Client Integration Status:${C.reset}`);
  for (const c of st.clients) {
    const icon = c.hooked ? `${C.green}✔ [HOOKED]${C.reset}` : `${C.dim}○ [DIRECT]${C.reset}`;
    console.log(`  ${icon} ${C.bold}${c.displayName.padEnd(22)}${C.reset} ${C.dim}->${C.reset} ${c.details}`);
    console.log(`    ${C.dim}Config: ${c.configPath}${C.reset}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = (args[0] || 'status').toLowerCase() as CliAction;

  if (args.includes('--help') || args.includes('-h') || action === 'help') {
    printHelp();
    return;
  }

  if (args.includes('--version') || args.includes('-v') || action === 'version') {
    console.log(`opencode-router (ocr) v${APP_VERSION}`);
    return;
  }

  // Parse optional port flag
  let port: number | undefined;
  const portIdx = args.findIndex(a => a === '--port' || a === '-p');
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
  }

  switch (action) {
    case 'start': {
      printBanner();
      console.log('[OCR] Starting OpenCode Router gateway...');
      const res = await startDaemon({ port });
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
      console.log('[OCR] Restarting OpenCode Router gateway...');
      const res = await restartDaemon({ port });
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
        console.error(`${C.red}✗ Missing client target.${C.reset} Usage: \`ocr setup <opencode | opencode-proxy | claude | codex>\``);
        process.exit(1);
      }
      const res = await setupClient(client, { port });
      if (res.success) {
        console.log(`${C.green}✔ ${res.message}${C.reset}`);
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
        console.error(`${C.red}✗ Missing client target.${C.reset} Usage: \`ocr teardown <opencode | opencode-proxy | claude | codex>\``);
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

    case 'install-shims': {
      printBanner();
      const res = registerGlobalShims();
      if (res.success) {
        console.log(`${C.green}✔ ${res.message}${C.reset}`);
        console.log(`  Commands \`ocr\` and \`opencode-router\` are now globally registered.`);
      } else {
        console.error(`${C.red}✗ ${res.message}${C.reset}`);
        process.exit(1);
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

main().catch((err) => {
  console.error(`[OCR Fatal Error] ${err.message}`);
  process.exit(1);
});
