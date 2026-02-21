#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { AgentRuntime } from "./agent/agent-runtime";
import { loadConfig, saveConfig } from "./config";
import { EmulatorManager } from "./device/emulator-manager";
import { TelegramGateway } from "./gateway/telegram-gateway";
import { runGatewayLoop } from "./gateway/run-loop";
import { DashboardServer, type DashboardGatewayStatus } from "./dashboard/server";
import { HumanAuthRelayServer } from "./human-auth/relay-server";
import { SkillLoader } from "./skills/skill-loader";
import { ScriptExecutor } from "./tools/script-executor";
import { runSetupWizard } from "./onboarding/setup-wizard";
import { installCliShortcut } from "./install/cli-shortcut";
import { ensureAndroidPrerequisites } from "./environment/android-prerequisites";
import { PermissionLabManager } from "./test/permission-lab";

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`OpenPocket CLI (Node.js + TypeScript)\n
Usage:
  openpocket [--config <path>] install-cli
  openpocket [--config <path>] onboard
  openpocket [--config <path>] config-show
  openpocket [--config <path>] emulator status
  openpocket [--config <path>] emulator start
  openpocket [--config <path>] emulator stop
  openpocket [--config <path>] emulator hide
  openpocket [--config <path>] emulator show
  openpocket [--config <path>] emulator list-avds
  openpocket [--config <path>] emulator screenshot [--out <path>]
  openpocket [--config <path>] emulator tap --x <int> --y <int> [--device <id>]
  openpocket [--config <path>] emulator type --text <text> [--device <id>]
  openpocket [--config <path>] agent [--model <name>] <task>
  openpocket [--config <path>] skills list
  openpocket [--config <path>] script run [--file <path> | --text <script>] [--timeout <sec>]
  openpocket [--config <path>] telegram setup|whoami
  openpocket [--config <path>] gateway [start|telegram]
  openpocket [--config <path>] dashboard start [--host <host>] [--port <port>]
  openpocket [--config <path>] test permission-app [deploy|install|launch|reset|uninstall|task] [--device <id>] [--clean] [--send] [--chat <id>]
  openpocket [--config <path>] human-auth-relay start [--host <host>] [--port <port>] [--public-base-url <url>] [--api-key <key>] [--state-file <path>]

Legacy aliases (deprecated):
  openpocket [--config <path>] init
  openpocket [--config <path>] setup

Examples:
  openpocket onboard
  openpocket emulator start
  openpocket emulator tap --x 120 --y 300
  openpocket agent --model gpt-5.2-codex "Open Chrome and search weather"
  openpocket skills list
  openpocket script run --text "echo hello"
  openpocket telegram setup
  openpocket telegram whoami
  openpocket gateway start
  openpocket dashboard start
  openpocket test permission-app deploy
  openpocket test permission-app task
  openpocket test permission-app task --send --chat <id>
  openpocket human-auth-relay start --port 8787
`);
}

function openUrlInBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawnSync("/usr/bin/open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "linux") {
    spawnSync("xdg-open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", shell: false });
  }
}

function findGatewayProcessPids(): number[] {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if ((ps.status ?? 1) !== 0 || !ps.stdout) {
    return [];
  }

  const currentPid = process.pid;
  const matches: number[] = [];
  for (const rawLine of ps.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid === currentPid) {
      continue;
    }
    const command = match[2].toLowerCase();
    if (!command.includes("gateway start")) {
      continue;
    }
    if (
      command.includes("openpocket")
      || command.includes("/dist/cli.js")
      || command.includes("/src/cli.ts")
    ) {
      matches.push(pid);
    }
  }

  return [...new Set(matches)].sort((a, b) => a - b);
}

function standaloneDashboardGatewayStatus(): DashboardGatewayStatus {
  const pids = findGatewayProcessPids();
  return {
    running: pids.length > 0,
    managed: false,
    note: pids.length > 0 ? `detected gateway pid(s): ${pids.join(", ")}` : "no gateway process detected",
  };
}

function takeOption(args: string[], name: string): { value: string | null; rest: string[] } {
  const out: string[] = [];
  let value: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      if (i + 1 >= args.length) {
        throw new Error(`Option ${name} requires a value.`);
      }
      value = args[i + 1];
      i += 1;
      continue;
    }
    out.push(args[i]);
  }

  return { value, rest: out };
}

async function runEmulatorCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const cfg = loadConfig(configPath);
  const emulator = new EmulatorManager(cfg);
  const sub = args[0];

  if (!sub) {
    throw new Error("Missing emulator subcommand.");
  }

  if (sub === "status") {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(emulator.status(), null, 2));
    return 0;
  }
  if (sub === "start") {
    // eslint-disable-next-line no-console
    console.log(await emulator.start());
    return 0;
  }
  if (sub === "stop") {
    // eslint-disable-next-line no-console
    console.log(emulator.stop());
    return 0;
  }
  if (sub === "hide") {
    // eslint-disable-next-line no-console
    console.log(emulator.hideWindow());
    return 0;
  }
  if (sub === "show") {
    // eslint-disable-next-line no-console
    console.log(emulator.showWindow());
    return 0;
  }
  if (sub === "list-avds") {
    for (const avd of emulator.listAvds()) {
      // eslint-disable-next-line no-console
      console.log(avd);
    }
    return 0;
  }
  if (sub === "screenshot") {
    const { value: outPath, rest: afterOut } = takeOption(args.slice(1), "--out");
    const { value: deviceId, rest } = takeOption(afterOut, "--device");
    if (rest.length > 0) {
      throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
    }
    // eslint-disable-next-line no-console
    console.log(emulator.captureScreenshot(outPath ?? undefined, deviceId ?? undefined));
    return 0;
  }
  if (sub === "tap") {
    const { value: xRaw, rest: afterX } = takeOption(args.slice(1), "--x");
    const { value: yRaw, rest: afterY } = takeOption(afterX, "--y");
    const { value: deviceId, rest } = takeOption(afterY, "--device");
    if (rest.length > 0) {
      throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
    }
    if (xRaw === null || yRaw === null) {
      throw new Error("Usage: openpocket emulator tap --x <int> --y <int> [--device <id>]");
    }
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Tap coordinates must be numbers.");
    }
    // eslint-disable-next-line no-console
    console.log(emulator.tap(Math.round(x), Math.round(y), deviceId ?? undefined));
    return 0;
  }
  if (sub === "type") {
    const { value: text, rest: afterText } = takeOption(args.slice(1), "--text");
    const { value: deviceId, rest } = takeOption(afterText, "--device");
    if (rest.length > 0) {
      throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
    }
    if (text === null) {
      throw new Error("Usage: openpocket emulator type --text <text> [--device <id>]");
    }
    // eslint-disable-next-line no-console
    console.log(emulator.typeText(text, deviceId ?? undefined));
    return 0;
  }

  throw new Error(`Unknown emulator subcommand: ${sub}`);
}

async function runAgentCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const { value: model, rest } = takeOption(args, "--model");
  const task = rest.join(" ").trim();
  if (!task) {
    throw new Error("Missing task. Usage: openpocket agent [--model <name>] <task>");
  }

  const cfg = loadConfig(configPath);
  const agent = new AgentRuntime(cfg);
  const result = await agent.runTask(task, model ?? undefined);
  // eslint-disable-next-line no-console
  console.log(result.message);
  // eslint-disable-next-line no-console
  console.log(`Session: ${result.sessionPath}`);
  return result.ok ? 0 : 1;
}

async function runGatewayCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = (args[0] ?? "start").trim();
  if (sub !== "start" && sub !== "telegram") {
    throw new Error(`Unknown gateway subcommand: ${sub}. Use: gateway start`);
  }

  const printStartupHeader = (cfg: ReturnType<typeof loadConfig>): void => {
    const envName = cfg.telegram.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
    const hasConfigToken = cfg.telegram.botToken.trim().length > 0;
    const hasEnvToken = Boolean(process.env[envName]?.trim());
    const tokenSource = hasConfigToken
      ? "config.json"
      : hasEnvToken
        ? `env:${envName}`
        : `missing (${envName})`;

    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("[OpenPocket] Gateway startup");
    // eslint-disable-next-line no-console
    console.log(`  config: ${cfg.configPath}`);
    // eslint-disable-next-line no-console
    console.log(`  project: ${cfg.projectName}`);
    // eslint-disable-next-line no-console
    console.log(`  model: ${cfg.defaultModel}`);
    // eslint-disable-next-line no-console
    console.log(`  telegram token: ${tokenSource}`);
    // eslint-disable-next-line no-console
    console.log(`  human auth: ${cfg.humanAuth.enabled ? "enabled" : "disabled"}`);
    // eslint-disable-next-line no-console
    console.log("");
  };

  const printStartupStep = (step: number, total: number, title: string, detail: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][gateway-start] [${step}/${total}] ${title}: ${detail}`);
  };

  await runGatewayLoop({
    start: async () => {
      const cfg = loadConfig(configPath);
      const shortcut = installCliShortcut();
      const envName = cfg.telegram.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
      const hasToken = Boolean(cfg.telegram.botToken.trim() || process.env[envName]?.trim());
      const totalSteps = 6;
      let gateway: TelegramGateway | null = null;
      let dashboard: DashboardServer | null = null;

      printStartupHeader(cfg);
      printStartupStep(1, totalSteps, "Load config", "ok");
      if (shortcut.shellRcUpdated.length > 0 || !shortcut.binDirAlreadyInPath) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][gateway-start] CLI launcher ensured: ${shortcut.commandPath}`);
        if (shortcut.preferredPathCommandPath) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][gateway-start] Current-shell launcher: ${shortcut.preferredPathCommandPath}`);
        }
        if (shortcut.shellRcUpdated.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][gateway-start] Updated shell rc: ${shortcut.shellRcUpdated.join(", ")}`);
        }
        // eslint-disable-next-line no-console
        console.log(
          "[OpenPocket][gateway-start] Reload shell profile (or open a new terminal) before using `openpocket` without `./`.",
        );
      }
      if (!hasToken) {
        printStartupStep(2, totalSteps, "Validate Telegram token", "failed");
        throw new Error(
          `Telegram bot token is empty. Set config.telegram.botToken or env ${envName}.`,
        );
      }
      printStartupStep(2, totalSteps, "Validate Telegram token", "ok");

      const emulator = new EmulatorManager(cfg);
      const emulatorStatus = emulator.status();
      if (emulatorStatus.bootedDevices.length > 0) {
        let detail = `ok (${emulatorStatus.bootedDevices.join(", ")})`;
        if (process.platform === "darwin") {
          detail = `${detail}; ${emulator.hideWindow()}`;
        }
        printStartupStep(
          3,
          totalSteps,
          "Ensure emulator is running",
          detail,
        );
      } else {
        printStartupStep(3, totalSteps, "Ensure emulator is running", "starting");
        const startMessage = await emulator.start(true);
        printStartupStep(3, totalSteps, "Ensure emulator is running", startMessage);
      }
      const readyStatus = emulator.status();
      if (readyStatus.bootedDevices.length === 0) {
        throw new Error(
          "Emulator is online but not boot-complete yet. Retry after boot or increase emulator.bootTimeoutSec.",
        );
      }

      if (cfg.dashboard.enabled) {
        printStartupStep(4, totalSteps, "Ensure local dashboard", "starting");
        const createDashboard = (port: number): DashboardServer =>
          new DashboardServer({
            config: cfg,
            mode: "integrated",
            host: cfg.dashboard.host,
            port,
            getGatewayStatus: () => ({
              running: gateway?.isRunning() ?? false,
              managed: true,
              note:
                gateway?.isRunning()
                  ? "managed by current gateway process"
                  : "gateway initializing",
            }),
          });

        try {
          dashboard = createDashboard(cfg.dashboard.port);
          await dashboard.start();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EADDRINUSE") {
            dashboard = createDashboard(0);
            await dashboard.start();
          } else {
            throw error;
          }
        }

        printStartupStep(4, totalSteps, "Ensure local dashboard", `ok (${dashboard.address})`);
        if (cfg.dashboard.autoOpenBrowser) {
          openUrlInBrowser(dashboard.address);
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][gateway-start] Dashboard opened in browser: ${dashboard.address}`);
        }
      } else {
        printStartupStep(4, totalSteps, "Ensure local dashboard", "skipped (disabled in config)");
      }

      printStartupStep(5, totalSteps, "Initialize gateway runtime", "starting");
      gateway = new TelegramGateway(cfg, {
        onLogLine: (line) => {
          dashboard?.ingestExternalLogLine(line);
        },
      });
      printStartupStep(5, totalSteps, "Initialize gateway runtime", "ok");
      printStartupStep(6, totalSteps, "Start services", "starting");
      await gateway.start();
      printStartupStep(6, totalSteps, "Start services", "ok");
      // eslint-disable-next-line no-console
      console.log("[OpenPocket][gateway-start] Gateway is running. Press Ctrl+C to stop.");
      if (dashboard) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][gateway-start] Dashboard URL: ${dashboard.address}`);
      }
      return {
        stop: async (reason?: string) => {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][gateway-start] Stopping gateway (${reason ?? "run-loop-stop"})`);
          await gateway?.stop(reason ?? "run-loop-stop");
          if (dashboard) {
            await dashboard.stop();
          }
        },
      };
    },
  });
  return 0;
}

async function runBootstrapCommand(configPath: string | undefined): Promise<ReturnType<typeof loadConfig>> {
  const cfg = loadConfig(configPath);
  await ensureAndroidPrerequisites(cfg, {
    autoInstall: true,
    logger: (line) => {
      // eslint-disable-next-line no-console
      console.log(`[OpenPocket][env] ${line}`);
    },
  });
  saveConfig(cfg);
  return cfg;
}

function shortcutMarkerPath(cfg: ReturnType<typeof loadConfig>): string {
  return path.join(cfg.stateDir, "cli-shortcut.json");
}

function installCliShortcutOnFirstOnboard(cfg: ReturnType<typeof loadConfig>): void {
  const markerPath = shortcutMarkerPath(cfg);
  if (fs.existsSync(markerPath)) {
    return;
  }

  const shortcut = installCliShortcut();
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        installedAt: new Date().toISOString(),
        commandPath: shortcut.commandPath,
        binDir: shortcut.binDir,
        shellRcUpdated: shortcut.shellRcUpdated,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  // eslint-disable-next-line no-console
  console.log(`[OpenPocket][onboard] CLI launcher installed: ${shortcut.commandPath}`);
  if (shortcut.preferredPathCommandPath) {
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][onboard] Current-shell launcher: ${shortcut.preferredPathCommandPath}`);
  }
  if (shortcut.shellRcUpdated.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][onboard] Updated shell rc: ${shortcut.shellRcUpdated.join(", ")}`);
  }
  if (!shortcut.binDirAlreadyInPath || shortcut.shellRcUpdated.length > 0) {
    // eslint-disable-next-line no-console
    console.log("[OpenPocket][onboard] Reload shell profile (or open a new terminal) to use `openpocket` directly.");
  }
}

async function runOnboardCommand(configPath: string | undefined): Promise<number> {
  const cfg = await runBootstrapCommand(configPath);
  installCliShortcutOnFirstOnboard(cfg);
  await runSetupWizard(cfg);
  return 0;
}

async function runInstallCliCommand(): Promise<number> {
  const shortcut = installCliShortcut();
  // eslint-disable-next-line no-console
  console.log(`CLI launcher installed: ${shortcut.commandPath}`);
  if (shortcut.preferredPathCommandPath) {
    // eslint-disable-next-line no-console
    console.log(`Current-shell launcher: ${shortcut.preferredPathCommandPath}`);
  }
  if (shortcut.shellRcUpdated.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`Updated shell rc: ${shortcut.shellRcUpdated.join(", ")}`);
  }
  if (!shortcut.binDirAlreadyInPath || shortcut.shellRcUpdated.length > 0) {
    // eslint-disable-next-line no-console
    console.log("Reload shell profile (or open a new terminal) to use `openpocket` directly.");
  }
  return 0;
}

async function runSkillsCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "list") {
    throw new Error(`Unknown skills subcommand: ${sub ?? "(missing)"}`);
  }

  const cfg = loadConfig(configPath);
  const loader = new SkillLoader(cfg);
  const skills = loader.loadAll();
  if (skills.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No skills loaded.");
    return 0;
  }

  for (const skill of skills) {
    // eslint-disable-next-line no-console
    console.log(`[${skill.source}] ${skill.name} (${skill.id})`);
    // eslint-disable-next-line no-console
    console.log(`  ${skill.description}`);
    // eslint-disable-next-line no-console
    console.log(`  ${skill.path}`);
  }
  return 0;
}

async function runScriptCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "run") {
    throw new Error(`Unknown script subcommand: ${sub ?? "(missing)"}`);
  }

  const cfg = loadConfig(configPath);
  const { value: filePath, rest: afterFile } = takeOption(args.slice(1), "--file");
  const { value: textScript, rest: afterText } = takeOption(afterFile, "--text");
  const { value: timeout, rest } = takeOption(afterText, "--timeout");
  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }

  let script = "";
  if (filePath) {
    script = fs.readFileSync(filePath, "utf-8");
  } else if (textScript) {
    script = textScript;
  } else {
    throw new Error("Missing script input. Use --file <path> or --text <script>.");
  }

  const executor = new ScriptExecutor(cfg);
  const result = await executor.execute(
    script,
    timeout && Number.isFinite(Number(timeout)) ? Number(timeout) : undefined,
  );

  // eslint-disable-next-line no-console
  console.log(`ok=${result.ok} exitCode=${result.exitCode} timedOut=${result.timedOut}`);
  // eslint-disable-next-line no-console
  console.log(`runDir=${result.runDir}`);
  if (result.stdout.trim()) {
    // eslint-disable-next-line no-console
    console.log(`stdout:\n${result.stdout}`);
  }
  if (result.stderr.trim()) {
    // eslint-disable-next-line no-console
    console.log(`stderr:\n${result.stderr}`);
  }
  return result.ok ? 0 : 1;
}

function parseAllowedChatIds(raw: string): number[] {
  const parts = raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  const values = parts.map((item) => Number(item));
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Allowed chat IDs must be numbers.");
  }
  return values.map((value) => Math.trunc(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTelegramTokenSource(cfg: ReturnType<typeof loadConfig>): {
  envName: string;
  token: string;
  source: string;
} {
  const envName = cfg.telegram.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
  const configToken = cfg.telegram.botToken.trim();
  const envToken = process.env[envName]?.trim() ?? "";
  if (configToken) {
    return { envName, token: configToken, source: "config.json" };
  }
  if (envToken) {
    return { envName, token: envToken, source: `env:${envName}` };
  }
  return { envName, token: "", source: `missing (${envName})` };
}

type TelegramChatCandidate = {
  id: number;
  type: string;
  title: string;
  source: string;
};

function extractChatCandidate(value: unknown, source: string): TelegramChatCandidate | null {
  if (!isRecord(value)) {
    return null;
  }
  const idRaw = value.id;
  const id = typeof idRaw === "number" ? Math.trunc(idRaw) : Number.NaN;
  if (!Number.isFinite(id)) {
    return null;
  }
  const type = String(value.type ?? "unknown");
  const title = String(
    value.title ??
      [value.first_name, value.last_name].filter((item) => typeof item === "string" && item.trim()).join(" ") ??
      value.username ??
      "",
  ).trim();
  return {
    id,
    type,
    title: title || "(untitled)",
    source,
  };
}

function collectTelegramChatCandidates(update: unknown): TelegramChatCandidate[] {
  const row = isRecord(update) ? update : null;
  if (!row) {
    return [];
  }
  const out: TelegramChatCandidate[] = [];
  const push = (chat: unknown, source: string) => {
    const parsed = extractChatCandidate(chat, source);
    if (parsed) {
      out.push(parsed);
    }
  };

  if (isRecord(row.message)) {
    push(row.message.chat, "message");
  }
  if (isRecord(row.edited_message)) {
    push(row.edited_message.chat, "edited_message");
  }
  if (isRecord(row.channel_post)) {
    push(row.channel_post.chat, "channel_post");
  }
  if (isRecord(row.edited_channel_post)) {
    push(row.edited_channel_post.chat, "edited_channel_post");
  }
  if (isRecord(row.callback_query) && isRecord(row.callback_query.message)) {
    push(row.callback_query.message.chat, "callback_query.message");
  }
  if (isRecord(row.my_chat_member)) {
    push(row.my_chat_member.chat, "my_chat_member");
  }
  if (isRecord(row.chat_member)) {
    push(row.chat_member.chat, "chat_member");
  }

  return out;
}

async function runTelegramWhoamiCommand(cfg: ReturnType<typeof loadConfig>): Promise<number> {
  const tokenInfo = resolveTelegramTokenSource(cfg);
  const allow = cfg.telegram.allowedChatIds;
  const allowPolicy = allow.length > 0 ? "allow_only_listed" : "allow_all";

  // eslint-disable-next-line no-console
  console.log("[OpenPocket] Telegram identity");
  // eslint-disable-next-line no-console
  console.log(`  token source: ${tokenInfo.source}`);
  // eslint-disable-next-line no-console
  console.log(`  allow policy: ${allowPolicy}`);
  // eslint-disable-next-line no-console
  console.log(
    `  allowlist: ${allow.length > 0 ? allow.map((id) => String(id)).join(", ") : "empty (all chats allowed)"}`,
  );

  if (!tokenInfo.token) {
    // eslint-disable-next-line no-console
    console.log(`\nTelegram token is not configured. Set config.telegram.botToken or env ${tokenInfo.envName}.`);
    return 0;
  }

  const apiBase = `https://api.telegram.org/bot${tokenInfo.token}`;
  let botName = "(unknown)";
  try {
    const getMeResp = await fetch(`${apiBase}/getMe`);
    const getMeText = await getMeResp.text();
    if (getMeResp.ok) {
      const getMeJson = JSON.parse(getMeText) as unknown;
      if (isRecord(getMeJson) && getMeJson.ok === true && isRecord(getMeJson.result)) {
        const username = String(getMeJson.result.username ?? "").trim();
        const id = Number(getMeJson.result.id ?? Number.NaN);
        botName = `${username ? `@${username}` : "(no username)"}${Number.isFinite(id) ? ` (id=${id})` : ""}`;
      }
    }
  } catch {
    // Ignore getMe failure and continue with updates probe.
  }

  // eslint-disable-next-line no-console
  console.log(`  bot: ${botName}`);

  try {
    const updatesResp = await fetch(`${apiBase}/getUpdates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeout: 0,
        limit: 30,
        allowed_updates: [
          "message",
          "edited_message",
          "channel_post",
          "edited_channel_post",
          "callback_query",
          "my_chat_member",
          "chat_member",
        ],
      }),
    });
    const updatesText = await updatesResp.text();
    if (!updatesResp.ok) {
      throw new Error(`HTTP ${updatesResp.status}: ${updatesText.slice(0, 300)}`);
    }

    const updatesJson = JSON.parse(updatesText) as unknown;
    if (!isRecord(updatesJson) || updatesJson.ok !== true || !Array.isArray(updatesJson.result)) {
      throw new Error("Unexpected getUpdates response.");
    }

    const seen = new Map<number, TelegramChatCandidate>();
    for (const row of updatesJson.result) {
      for (const chat of collectTelegramChatCandidates(row)) {
        if (!seen.has(chat.id)) {
          seen.set(chat.id, chat);
        }
      }
    }

    if (seen.size === 0) {
      // eslint-disable-next-line no-console
      console.log("\nNo chat IDs discovered from recent updates.");
      // eslint-disable-next-line no-console
      console.log("Send one message to your bot in Telegram, then run `openpocket telegram whoami` again.");
      return 0;
    }

    // eslint-disable-next-line no-console
    console.log("\nDiscovered chat IDs:");
    for (const chat of seen.values()) {
      const allowed = allow.length === 0 || allow.includes(chat.id);
      // eslint-disable-next-line no-console
      console.log(
        `  - ${chat.id} | type=${chat.type} | title=${chat.title} | source=${chat.source} | allowed=${allowed}`,
      );
    }
    return 0;
  } catch (error) {
    const message = (error as Error).message || "unknown error";
    // eslint-disable-next-line no-console
    console.log(`\nUnable to query recent Telegram updates: ${message}`);
    // eslint-disable-next-line no-console
    console.log("If gateway is running, polling conflict can happen. Stop gateway and retry this command.");
    return 0;
  }
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeEnvVarName(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!ENV_VAR_NAME_RE.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function truncateForTerminal(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return ".".repeat(maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

type CliSelectOption<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

async function selectByArrowKeys<T extends string>(
  rl: Interface,
  message: string,
  options: CliSelectOption<T>[],
  initialValue?: T,
): Promise<T> {
  if (options.length === 0) {
    throw new Error("Select prompt requires at least one option.");
  }
  const initialIndex =
    initialValue !== undefined ? Math.max(0, options.findIndex((opt) => opt.value === initialValue)) : 0;
  let index = initialIndex >= 0 && initialIndex < options.length ? initialIndex : 0;

  if (!input.isTTY || !output.isTTY) {
    return options[index].value;
  }

  rl.pause();
  readline.emitKeypressEvents(input);

  const previousRaw = Boolean((input as NodeJS.ReadStream).isRaw);
  if (input.setRawMode) {
    input.setRawMode(true);
  }
  input.resume();

  let renderedLines = 0;
  const columns = Math.max(60, output.columns ?? 120);
  const render = () => {
    if (renderedLines > 0) {
      readline.moveCursor(output, 0, -renderedLines);
      readline.clearScreenDown(output);
    }
    const lines: string[] = [];
    lines.push("");
    lines.push(truncateForTerminal(message, columns - 1));
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      const prefix = i === index ? ">" : " ";
      const hint = option.hint ? ` (${option.hint})` : "";
      const rawLine = `  ${prefix} ${option.label}${hint}`;
      lines.push(truncateForTerminal(rawLine, columns - 1));
    }
    lines.push(truncateForTerminal("Use Up/Down arrows and Enter to select.", columns - 1));
    output.write(`${lines.join("\n")}\n`);
    renderedLines = lines.length;
  };

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      if (input.setRawMode) {
        try {
          input.setRawMode(previousRaw);
        } catch {
          // Ignore raw mode restore errors.
        }
      }
      rl.resume();
    };

    const onKeypress = (_char: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        reject(new Error("Setup cancelled by user."));
        return;
      }
      if (key.name === "up") {
        index = (index - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key.name === "down") {
        index = (index + 1) % options.length;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolve(options[index].value);
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

async function runTelegramSetupCommand(
  configPath: string | undefined,
  args: string[],
): Promise<number> {
  const sub = (args[0] ?? "setup").trim();
  if (sub !== "setup" && sub !== "whoami") {
    throw new Error(`Unknown telegram subcommand: ${sub}. Use: telegram setup|whoami`);
  }

  const cfg = loadConfig(configPath);
  if (sub === "whoami") {
    return runTelegramWhoamiCommand(cfg);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`telegram setup` requires an interactive terminal (TTY).");
  }

  const rl = createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log("[OpenPocket] Telegram setup");
    // eslint-disable-next-line no-console
    console.log("Create your bot in Telegram with @BotFather before continuing.");

    const fallbackEnv = "TELEGRAM_BOT_TOKEN";
    const configuredEnv = cfg.telegram.botTokenEnv || fallbackEnv;
    const currentEnv = normalizeEnvVarName(configuredEnv, fallbackEnv);
    if (currentEnv !== configuredEnv) {
      cfg.telegram.botTokenEnv = currentEnv;
      // eslint-disable-next-line no-console
      console.log(
        `[OpenPocket] Invalid botTokenEnv value detected (${configuredEnv}). Reset to ${currentEnv}.`,
      );
    }
    const envToken = process.env[currentEnv]?.trim() ?? "";
    const tokenChoice = await selectByArrowKeys(
      rl,
      "Telegram bot token source",
      [
        {
          value: "env",
          label: `Use environment variable (${currentEnv})`,
          hint: envToken ? `detected, length ${envToken.length}` : "not detected",
        },
        {
          value: "config",
          label: "Save token in local config.json",
        },
        {
          value: "keep",
          label: "Keep current token settings",
          hint: cfg.telegram.botToken.trim() ? "config token exists" : "no config token",
        },
      ],
      "env",
    );

    if (tokenChoice === "env") {
      const envNameRaw = await rl.question(
        `Environment variable name for Telegram token [${currentEnv}]: `,
      );
      const envName = envNameRaw.trim() || currentEnv;
      cfg.telegram.botTokenEnv = envName;
      cfg.telegram.botToken = "";
      const selectedEnvToken = process.env[envName]?.trim() ?? "";
      if (!selectedEnvToken) {
        // eslint-disable-next-line no-console
        console.log(
          `[OpenPocket] Warning: ${envName} is not set in this shell. Gateway start will fail until you export it.`,
        );
      }
    } else if (tokenChoice === "config") {
      const token = (await rl.question("Enter Telegram bot token: ")).trim();
      if (!token) {
        throw new Error("Telegram bot token cannot be empty.");
      }
      cfg.telegram.botToken = token;
    }

    const currentAllow =
      cfg.telegram.allowedChatIds.length > 0
        ? cfg.telegram.allowedChatIds.join(", ")
        : "empty (all chats allowed)";
    const allowChoice = await selectByArrowKeys(
      rl,
      "Telegram chat allowlist policy",
      [
        {
          value: "keep",
          label: "Keep current allowlist",
          hint: currentAllow,
        },
        {
          value: "open",
          label: "Allow all chats (clear allowlist)",
        },
        {
          value: "set",
          label: "Set allowlist manually (chat IDs)",
        },
      ],
      "keep",
    );

    if (allowChoice === "open") {
      cfg.telegram.allowedChatIds = [];
    } else if (allowChoice === "set") {
      const allowedInput = await rl.question(
        "Enter allowed chat IDs (comma or space separated): ",
      );
      cfg.telegram.allowedChatIds = parseAllowedChatIds(allowedInput);
    }

    saveConfig(cfg);
    // eslint-disable-next-line no-console
    console.log("\nTelegram setup saved.");
    // eslint-disable-next-line no-console
    console.log("Next: run `openpocket gateway start`.");
    return 0;
  } finally {
    if (input.setRawMode) {
      try {
        input.setRawMode(false);
      } catch {
        // Ignore raw mode reset errors.
      }
    }
    input.pause();
    rl.close();
  }
}

async function runDashboardCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = (args[0] ?? "start").trim();
  if (sub !== "start") {
    throw new Error(`Unknown dashboard subcommand: ${sub}. Use: dashboard start`);
  }

  const { value: hostOption, rest: afterHost } = takeOption(args.slice(1), "--host");
  const { value: portOption, rest } = takeOption(afterHost, "--port");
  if (rest.length > 0) {
    throw new Error(`Unexpected dashboard arguments: ${rest.join(" ")}`);
  }

  const cfg = loadConfig(configPath);
  const parsedPort = Number(portOption ?? String(cfg.dashboard.port));
  const port = Number.isFinite(parsedPort)
    ? Math.max(1, Math.min(65535, Math.round(parsedPort)))
    : cfg.dashboard.port;
  const host = hostOption?.trim() || cfg.dashboard.host || "127.0.0.1";

  const dashboard = new DashboardServer({
    config: cfg,
    mode: "standalone",
    host,
    port,
    getGatewayStatus: standaloneDashboardGatewayStatus,
  });

  await dashboard.start();
  // eslint-disable-next-line no-console
  console.log(`[OpenPocket][dashboard] started at ${dashboard.address}`);
  // eslint-disable-next-line no-console
  console.log("[OpenPocket][dashboard] press Ctrl+C to stop");

  if (cfg.dashboard.autoOpenBrowser) {
    openUrlInBrowser(dashboard.address);
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][dashboard] opened browser: ${dashboard.address}`);
  }

  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

  await dashboard.stop();
  // eslint-disable-next-line no-console
  console.log("[OpenPocket][dashboard] stopped");
  return 0;
}

async function runHumanAuthRelayCommand(
  configPath: string | undefined,
  args: string[],
): Promise<number> {
  const sub = (args[0] ?? "start").trim();
  if (sub !== "start") {
    throw new Error(`Unknown human-auth-relay subcommand: ${sub}. Use: human-auth-relay start`);
  }

  const { value: host, rest: afterHost } = takeOption(args.slice(1), "--host");
  const { value: portRaw, rest: afterPort } = takeOption(afterHost, "--port");
  const { value: publicBaseUrl, rest: afterPublicBaseUrl } = takeOption(
    afterPort,
    "--public-base-url",
  );
  const { value: apiKey, rest: afterApiKey } = takeOption(afterPublicBaseUrl, "--api-key");
  const { value: stateFile, rest } = takeOption(afterApiKey, "--state-file");

  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }

  const cfg = loadConfig(configPath);
  const parsedPort = Number(portRaw ?? String(cfg.humanAuth.localRelayPort));
  const defaultPort = cfg.humanAuth.localRelayPort;
  const port = Number.isFinite(parsedPort)
    ? Math.max(1, Math.min(65535, Math.round(parsedPort)))
    : defaultPort;

  const relay = new HumanAuthRelayServer({
    host: (host ?? cfg.humanAuth.localRelayHost ?? "0.0.0.0").trim(),
    port,
    publicBaseUrl: (publicBaseUrl ?? cfg.humanAuth.publicBaseUrl ?? "").trim(),
    apiKey: (apiKey ?? cfg.humanAuth.apiKey ?? "").trim(),
    apiKeyEnv: cfg.humanAuth.apiKeyEnv,
    stateFile:
      stateFile?.trim() ||
      cfg.humanAuth.localRelayStateFile,
  });

  await relay.start();
  // eslint-disable-next-line no-console
  console.log(`[OpenPocket][human-auth-relay] started at ${relay.address || `http://${host ?? "0.0.0.0"}:${port}`}`);
  // eslint-disable-next-line no-console
  console.log("[OpenPocket][human-auth-relay] press Ctrl+C to stop");

  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

  await relay.stop();
  return 0;
}

async function runTestCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const target = (args[0] ?? "").trim();
  if (target !== "permission-app") {
    throw new Error(
      "Unknown test target. Use: test permission-app [deploy|install|launch|reset|uninstall|task] [--device <id>] [--clean]",
    );
  }

  const hasClean = args.includes("--clean");
  const sendToTelegram = args.includes("--send");
  const withoutFlags = args.filter((item) => item !== "--clean" && item !== "--send");
  const { value: deviceId, rest: afterDevice } = takeOption(withoutFlags.slice(1), "--device");
  const { value: chatIdRaw, rest } = takeOption(afterDevice, "--chat");
  if (rest.length > 1) {
    throw new Error(`Unexpected test arguments: ${rest.slice(1).join(" ")}`);
  }
  const action = (rest[0] ?? "deploy").trim();

  const cfg = loadConfig(configPath);
  const permissionLab = new PermissionLabManager(cfg);

  if (action === "task") {
    const taskText = permissionLab.recommendedTelegramTask();
    if (!sendToTelegram) {
      // eslint-disable-next-line no-console
      console.log(taskText);
      // eslint-disable-next-line no-console
      console.log("Tip: add `--send` (and optionally `--chat <id>`) to send this prompt to Telegram directly.");
      return 0;
    }

    const envName = cfg.telegram.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
    const token = cfg.telegram.botToken.trim() || (process.env[envName]?.trim() ?? "");
    if (!token) {
      throw new Error(`Telegram bot token is empty. Set config.telegram.botToken or env ${envName}.`);
    }

    let chatId: number | null = null;
    if (chatIdRaw !== null) {
      const parsed = Number(chatIdRaw);
      if (!Number.isFinite(parsed)) {
        throw new Error("Chat ID must be a number.");
      }
      chatId = Math.trunc(parsed);
    } else if (cfg.telegram.allowedChatIds.length === 1) {
      chatId = cfg.telegram.allowedChatIds[0];
    } else if (cfg.telegram.allowedChatIds.length > 1) {
      throw new Error(
        `Multiple allowed chat IDs configured (${cfg.telegram.allowedChatIds.join(", ")}). Use --chat <id>.`,
      );
    } else {
      throw new Error("No default chat ID found. Use --chat <id> or configure telegram.allowedChatIds.");
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: taskText,
      }),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Telegram send failed (${response.status}): ${bodyText.slice(0, 300)}`);
    }
    let apiPayload: { ok?: boolean; description?: string } = {};
    try {
      apiPayload = JSON.parse(bodyText) as { ok?: boolean; description?: string };
    } catch {
      apiPayload = {};
    }
    if (apiPayload.ok === false) {
      throw new Error(`Telegram send failed: ${apiPayload.description ?? "unknown error"}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][test] PermissionLab prompt sent to Telegram chat ${chatId}.`);
    return 0;
  }

  if (action === "deploy" || action === "install") {
    const shouldLaunch = action === "deploy";
    // eslint-disable-next-line no-console
    console.log("[OpenPocket][test] Building and deploying Android PermissionLab...");
    const deployed = await permissionLab.deploy({
      deviceId: deviceId ?? undefined,
      launch: shouldLaunch,
      clean: hasClean,
    });
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][test] APK: ${deployed.apkPath}`);
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][test] Device: ${deployed.deviceId}`);
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][test] SDK: ${deployed.sdkRoot}`);
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][test] Build-tools: ${deployed.buildToolsVersion} | Platform: ${deployed.platformVersion}`);
    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][test] Install: ${deployed.installOutput || "ok"}`);
    if (deployed.launchOutput) {
      // eslint-disable-next-line no-console
      console.log(`[OpenPocket][test] Launch: ${deployed.launchOutput}`);
    }
    // eslint-disable-next-line no-console
    console.log("[OpenPocket][test] Suggested Telegram task:");
    // eslint-disable-next-line no-console
    console.log(permissionLab.recommendedTelegramTask());
    return 0;
  }

  if (action === "launch") {
    // eslint-disable-next-line no-console
    console.log(permissionLab.launch(deviceId ?? undefined));
    return 0;
  }

  if (action === "reset") {
    // eslint-disable-next-line no-console
    console.log(permissionLab.reset(deviceId ?? undefined));
    return 0;
  }

  if (action === "uninstall") {
    // eslint-disable-next-line no-console
    console.log(permissionLab.uninstall(deviceId ?? undefined));
    return 0;
  }

  throw new Error(
    `Unknown permission-app action: ${action}. Use deploy|install|launch|reset|uninstall|task`,
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { value: configPath, rest } = takeOption(argv, "--config");

  if (rest.length === 0 || rest[0] === "-h" || rest[0] === "--help") {
    printHelp();
    return 0;
  }

  const command = rest[0];

  if (command === "init") {
    // eslint-disable-next-line no-console
    console.log("[OpenPocket] `init` is deprecated. Use `openpocket onboard`.");
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (interactive) {
      return runOnboardCommand(configPath ?? undefined);
    }
    const cfg = await runBootstrapCommand(configPath ?? undefined);
    // eslint-disable-next-line no-console
    console.log(`OpenPocket bootstrap completed.\nConfig: ${cfg.configPath}`);
    // eslint-disable-next-line no-console
    console.log("Run `openpocket onboard` in an interactive terminal to complete consent/model/API key onboarding.");
    return 0;
  }

  if (command === "install-cli") {
    return runInstallCliCommand();
  }

  if (command === "config-show") {
    const cfg = loadConfig(configPath ?? undefined);
    // eslint-disable-next-line no-console
    console.log(fs.readFileSync(cfg.configPath, "utf-8").trim());
    return 0;
  }

  if (command === "emulator") {
    return runEmulatorCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "agent") {
    return runAgentCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "gateway") {
    return runGatewayCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "telegram") {
    return runTelegramSetupCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "dashboard") {
    return runDashboardCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "human-auth-relay") {
    return runHumanAuthRelayCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "test") {
    return runTestCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "skills") {
    return runSkillsCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "script") {
    return runScriptCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "setup") {
    // eslint-disable-next-line no-console
    console.log("[OpenPocket] `setup` is deprecated. Use `openpocket onboard`.");
    return runOnboardCommand(configPath ?? undefined);
  }

  if (command === "onboard") {
    return runOnboardCommand(configPath ?? undefined);
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`OpenPocket error: ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
