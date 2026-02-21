import TelegramBot, { type Message } from "node-telegram-bot-api";

import type { CronJob, OpenPocketConfig } from "../types";
import { saveConfig } from "../config";
import { AgentRuntime } from "../agent/agent-runtime";
import { EmulatorManager } from "../device/emulator-manager";
import { HumanAuthBridge } from "../human-auth/bridge";
import { LocalHumanAuthStack } from "../human-auth/local-stack";
import { ChatAssistant } from "./chat-assistant";
import { CronService, type CronRunResult } from "./cron-service";
import { HeartbeatRunner } from "./heartbeat-runner";

export const TELEGRAM_MENU_COMMANDS: TelegramBot.BotCommand[] = [
  { command: "help", description: "Show command help" },
  { command: "status", description: "Show gateway and emulator status" },
  { command: "model", description: "Show or switch model profile" },
  { command: "startvm", description: "Start Android emulator" },
  { command: "stopvm", description: "Stop Android emulator" },
  { command: "hidevm", description: "Hide emulator window" },
  { command: "showvm", description: "Show emulator window" },
  { command: "screen", description: "Capture manual screenshot" },
  { command: "skills", description: "List loaded skills" },
  { command: "clear", description: "Clear chat memory only" },
  { command: "reset", description: "Clear chat memory and stop task" },
  { command: "stop", description: "Stop current running task" },
  { command: "restart", description: "Restart gateway process loop" },
  { command: "cronrun", description: "Trigger cron job by id" },
  { command: "auth", description: "Human auth helper commands" },
  { command: "run", description: "Force task mode with text" },
];

export interface TelegramGatewayOptions {
  onLogLine?: (line: string) => void;
  typingIntervalMs?: number;
}

export class TelegramGateway {
  private readonly config: OpenPocketConfig;
  private readonly emulator: EmulatorManager;
  private readonly agent: AgentRuntime;
  private readonly bot: TelegramBot;
  private readonly cron: CronService;
  private readonly heartbeat: HeartbeatRunner;
  private readonly humanAuth: HumanAuthBridge;
  private readonly localHumanAuthStack: LocalHumanAuthStack;
  private localHumanAuthActive = false;
  private chat: ChatAssistant;
  private readonly onLogLine: ((line: string) => void) | null;
  private readonly typingIntervalMs: number;
  private readonly typingSessions = new Map<number, { refs: number; timer: NodeJS.Timeout }>();
  private running = false;
  private stoppedPromise: Promise<void> | null = null;
  private stopResolver: (() => void) | null = null;

  constructor(config: OpenPocketConfig, options?: TelegramGatewayOptions) {
    this.config = config;
    this.emulator = new EmulatorManager(config);
    this.agent = new AgentRuntime(config);
    this.chat = new ChatAssistant(config);
    this.onLogLine = options?.onLogLine ?? null;
    this.typingIntervalMs = Math.max(50, Math.round(options?.typingIntervalMs ?? 4000));

    const token =
      config.telegram.botToken.trim() ||
      (config.telegram.botTokenEnv ? process.env[config.telegram.botTokenEnv]?.trim() : "") ||
      "";

    if (!token) {
      throw new Error(
        `Telegram bot token is empty. Set config.telegram.botToken or env ${config.telegram.botTokenEnv}.`,
      );
    }

    this.bot = new TelegramBot(token, {
      polling: {
        interval: 1000,
        params: {
          timeout: config.telegram.pollTimeoutSec,
        },
      },
    });

    this.humanAuth = new HumanAuthBridge(config);
    this.localHumanAuthStack = new LocalHumanAuthStack(config, (line) => this.log(line));

    this.heartbeat = new HeartbeatRunner(config, {
      readSnapshot: () => {
        const status = this.emulator.status();
        return {
          busy: this.agent.isBusy(),
          currentTask: this.agent.getCurrentTask(),
          taskRuntimeMs: this.agent.getCurrentTaskRuntimeMs(),
          devices: status.devices.length,
          bootedDevices: status.bootedDevices.length,
        };
      },
    });

    this.cron = new CronService(config, {
      runTask: async (job) => this.runScheduledJob(job),
      log: (line) => {
        // eslint-disable-next-line no-console
        console.log(line);
      },
    });
  }

  private log(message: string): void {
    const line = `[OpenPocket][gateway] ${new Date().toISOString()} ${message}`;
    // eslint-disable-next-line no-console
    console.log(line);
    this.onLogLine?.(line);
  }

  isRunning(): boolean {
    return this.running;
  }

  private compact(text: string, maxChars: number): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxChars) {
      return oneLine;
    }
    return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private sanitizeForChat(text: string, maxChars: number): string {
    const withoutInternalLines = text
      .split("\n")
      .filter((line) => !/^\s*(Session|Auto skill|Auto script)\s*:/i.test(line))
      .join("\n");

    const redacted = withoutInternalLines
      .replace(/local_screenshot=\S+/gi, "local_screenshot=[saved locally]")
      .replace(/runDir=\S+/gi, "runDir=[local-dir]")
      .replace(/\/(?:Users|home|var|tmp)\/[^\s)\]]+/g, "[local-path]")
      .replace(/[A-Za-z]:\\[^\s)\]]+/g, "[local-path]");

    return this.compact(redacted, maxChars);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.stopResolver = resolve;
    });

    this.bot.on("message", this.handleMessage);
    this.bot.on("polling_error", this.handlePollingError);
    await this.configureBotCommandMenu();

    if (this.config.humanAuth.enabled && this.config.humanAuth.useLocalRelay) {
      try {
        const started = await this.localHumanAuthStack.start();
        this.config.humanAuth.relayBaseUrl = started.relayBaseUrl;
        this.config.humanAuth.publicBaseUrl = started.publicBaseUrl;
        this.localHumanAuthActive = true;
        this.log(
          `human-auth local stack ready relay=${started.relayBaseUrl} public=${started.publicBaseUrl}`,
        );
      } catch (error) {
        this.localHumanAuthActive = false;
        this.log(`human-auth local stack failed: ${(error as Error).message}`);
      }
    }

    this.heartbeat.start();
    this.cron.start();
    this.log("telegram polling started");
    this.log("OpenPocket Telegram gateway running...");
  }

  async stop(reason = "manual"): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.bot.removeListener("message", this.handleMessage);
    this.bot.removeListener("polling_error", this.handlePollingError);
    this.heartbeat.stop();
    this.cron.stop();
    this.clearTypingSessions();
    if (this.localHumanAuthActive) {
      await this.localHumanAuthStack.stop();
      this.localHumanAuthActive = false;
    }
    try {
      await this.bot.stopPolling();
    } catch {
      // Ignore stop polling errors on shutdown.
    }
    this.log(`gateway stopped reason=${reason}`);
    this.stopResolver?.();
    this.stopResolver = null;
  }

  async runForever(): Promise<void> {
    await this.start();
    await this.waitForStop();
  }

  async waitForStop(): Promise<void> {
    if (!this.stoppedPromise) {
      return;
    }
    await this.stoppedPromise;
  }

  private readonly handlePollingError = (error: Error): void => {
    this.log(`polling error: ${error.message}`);
  };

  private readonly handleMessage = async (message: Message): Promise<void> => {
    const chatId = message.chat.id;
    try {
      this.log(`incoming chat=${chatId} text=${JSON.stringify(message.text ?? "")}`);
      const text = message.text?.trim() ?? "";
      const shouldType = Boolean(text) && this.allowed(chatId);
      if (shouldType) {
        await this.withTypingStatus(chatId, async () => {
          await this.consumeMessage(message);
        });
      } else {
        await this.consumeMessage(message);
      }
    } catch (error) {
      this.log(`handler error chat=${chatId} error=${(error as Error).message}`);
      await this.bot.sendMessage(chatId, `OpenPocket error: ${(error as Error).message}`);
    }
  };

  private clearTypingSessions(): void {
    for (const session of this.typingSessions.values()) {
      clearInterval(session.timer);
    }
    this.typingSessions.clear();
  }

  private async sendTypingAction(chatId: number): Promise<void> {
    try {
      await this.bot.sendChatAction(chatId, "typing");
    } catch {
      // Ignore chat action failures to keep task execution stable.
    }
  }

  private beginTypingStatus(chatId: number): () => void {
    const existing = this.typingSessions.get(chatId);
    if (existing) {
      existing.refs += 1;
    } else {
      const timer = setInterval(() => {
        void this.sendTypingAction(chatId);
      }, this.typingIntervalMs);
      timer.unref?.();
      this.typingSessions.set(chatId, { refs: 1, timer });
      void this.sendTypingAction(chatId);
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const session = this.typingSessions.get(chatId);
      if (!session) {
        return;
      }
      session.refs -= 1;
      if (session.refs <= 0) {
        clearInterval(session.timer);
        this.typingSessions.delete(chatId);
      }
    };
  }

  private async withTypingStatus<T>(
    chatId: number | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (chatId === null) {
      return operation();
    }
    const release = this.beginTypingStatus(chatId);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async configureBotCommandMenu(): Promise<void> {
    try {
      await this.bot.setMyCommands(TELEGRAM_MENU_COMMANDS);
      await this.bot.setChatMenuButton({
        menu_button: {
          type: "commands",
        },
      });
      this.log(`telegram command menu configured commands=${TELEGRAM_MENU_COMMANDS.length}`);
    } catch (error) {
      this.log(`telegram command menu setup failed: ${(error as Error).message}`);
    }
  }

  private allowed(chatId: number): boolean {
    const allow = this.config.telegram.allowedChatIds;
    if (!allow || allow.length === 0) {
      return true;
    }
    return allow.includes(chatId);
  }

  private async consumeMessage(message: Message): Promise<void> {
    const chatId = message.chat.id;
    if (!this.allowed(chatId)) {
      return;
    }

    const text = message.text?.trim();
    if (!text) {
      return;
    }

    if (text.startsWith("/help")) {
      await this.bot.sendMessage(
        chatId,
        [
          "OpenPocket commands:",
          "/status",
          "/model [name]",
          "/startvm",
          "/stopvm",
          "/hidevm",
          "/showvm",
          "/screen",
          "/skills",
          "/clear",
          "/reset",
          "/stop",
          "/restart",
          "/cronrun <job-id>",
          "/auth",
          "/auth pending",
          "/auth approve <request-id> [note]",
          "/auth reject <request-id> [note]",
          "/run <task>",
          "Send plain text directly. I will auto-route to chat or task mode. Use /run to force task mode.",
        ].join("\n"),
      );
      return;
    }

    if (text.startsWith("/status")) {
      const status = this.emulator.status();
      await this.bot.sendMessage(
        chatId,
        [
          `Project: ${this.config.projectName}`,
          `Model: ${this.config.defaultModel}`,
          `Agent busy: ${this.agent.isBusy()}`,
          `Current task: ${this.agent.getCurrentTask() ?? "(none)"}`,
          `AVD: ${status.avdName}`,
          `Devices: ${status.devices.length > 0 ? status.devices.join(", ") : "(none)"}`,
          `Booted: ${status.bootedDevices.length > 0 ? status.bootedDevices.join(", ") : "(none)"}`,
          `Human auth: ${this.config.humanAuth.enabled ? "enabled" : "disabled"}`,
          `Human auth relay: ${this.config.humanAuth.relayBaseUrl || "(not configured)"}`,
          `Human auth public: ${this.config.humanAuth.publicBaseUrl || "(not configured)"}`,
        ].join("\n"),
      );
      return;
    }

    if (text.startsWith("/model")) {
      const requested = text.replace("/model", "").trim();
      if (!requested) {
        await this.bot.sendMessage(
          chatId,
          `Current model: ${this.config.defaultModel}\nAvailable: ${Object.keys(this.config.models).join(", ")}`,
        );
        return;
      }

      if (!this.config.models[requested]) {
        await this.bot.sendMessage(chatId, `Unknown model: ${requested}`);
        return;
      }

      this.config.defaultModel = requested;
      saveConfig(this.config);
      this.chat = new ChatAssistant(this.config);
      await this.bot.sendMessage(chatId, `Default model updated: ${requested}`);
      return;
    }

    if (text.startsWith("/startvm")) {
      const messageText = await this.emulator.start();
      await this.bot.sendMessage(chatId, messageText);
      return;
    }

    if (text.startsWith("/stopvm")) {
      await this.bot.sendMessage(chatId, this.emulator.stop());
      return;
    }

    if (text.startsWith("/hidevm")) {
      await this.bot.sendMessage(chatId, this.emulator.hideWindow());
      return;
    }

    if (text.startsWith("/showvm")) {
      await this.bot.sendMessage(chatId, this.emulator.showWindow());
      return;
    }

    if (text.startsWith("/screen")) {
      const screenshotPath = this.agent.captureManualScreenshot();
      this.log(`manual screenshot chat=${chatId} path=${screenshotPath}`);
      await this.bot.sendMessage(chatId, "Screenshot saved in local storage.");
      return;
    }

    if (text.startsWith("/skills")) {
      const skills = this.agent.listSkills();
      if (skills.length === 0) {
        await this.bot.sendMessage(chatId, "No skills loaded.");
        return;
      }
      const body = skills
        .slice(0, 25)
        .map((skill) => `- [${skill.source}] ${skill.name}: ${skill.description}`)
        .join("\n");
      await this.bot.sendMessage(chatId, `Loaded skills (${skills.length}):\n${body}`);
      return;
    }

    if (text === "/clear") {
      this.chat.clear(chatId);
      await this.bot.sendMessage(chatId, "Conversation memory cleared.");
      return;
    }

    if (text === "/reset") {
      this.chat.clear(chatId);
      const accepted = this.agent.stopCurrentTask();
      await this.bot.sendMessage(
        chatId,
        accepted
          ? "Conversation memory cleared. Stop requested for the running task."
          : "Conversation memory cleared. No running task to stop.",
      );
      return;
    }

    if (text === "/stop") {
      const accepted = this.agent.stopCurrentTask();
      await this.bot.sendMessage(chatId, accepted ? "Stop requested." : "No running task.");
      return;
    }

    if (text === "/restart") {
      if (process.listenerCount("SIGUSR1") === 0) {
        await this.bot.sendMessage(
          chatId,
          "Restart is unavailable in the current runtime mode (no gateway run-loop signal handler).",
        );
        return;
      }
      await this.bot.sendMessage(chatId, "Gateway restart requested. Reconnecting...");
      setTimeout(() => {
        try {
          process.kill(process.pid, "SIGUSR1");
        } catch (error) {
          this.log(`gateway restart signal failed: ${(error as Error).message}`);
        }
      }, 50);
      return;
    }

    if (text.startsWith("/cronrun")) {
      const jobId = text.replace("/cronrun", "").trim();
      if (!jobId) {
        await this.bot.sendMessage(chatId, "Usage: /cronrun <job-id>");
        return;
      }
      const found = await this.cron.runNow(jobId);
      await this.bot.sendMessage(chatId, found ? `Cron job triggered: ${jobId}` : `Cron job not found: ${jobId}`);
      return;
    }

    if (text.startsWith("/run")) {
      const task = text.replace("/run", "").trim();
      if (!task) {
        await this.bot.sendMessage(chatId, "Usage: /run <task>");
        return;
      }
      await this.runTaskAsync(chatId, task);
      return;
    }

    if (text.startsWith("/auth")) {
      await this.handleAuthCommand(chatId, text);
      return;
    }

    const decision = await this.chat.decide(chatId, text);
    this.log(
      `decision chat=${chatId} mode=${decision.mode} confidence=${decision.confidence.toFixed(2)} reason=${decision.reason}`,
    );
    if (decision.mode === "task") {
      const task = decision.task || text;
      await this.runTaskAsync(chatId, task);
      return;
    }

    const reply = decision.reply || (await this.chat.reply(chatId, text));
    await this.bot.sendMessage(chatId, this.sanitizeForChat(reply, 1800));
  }

  private async runTaskAsync(chatId: number, task: string): Promise<void> {
    if (this.agent.isBusy()) {
      this.log(`task rejected busy chat=${chatId} task=${JSON.stringify(task)}`);
      await this.bot.sendMessage(chatId, "A previous task is still running. Please wait.");
      return;
    }
    await this.bot.sendMessage(chatId, `Task accepted: ${task}\nI will send step-by-step progress updates.`);
    void this.runTaskAndReport({ chatId, task, source: "chat", modelName: null });
  }

  private async runScheduledJob(job: CronJob): Promise<CronRunResult> {
    if (this.agent.isBusy()) {
      return {
        accepted: false,
        ok: false,
        message: "Agent is busy.",
      };
    }

    if (job.chatId !== null) {
      await this.bot.sendMessage(job.chatId, `Scheduled task started (${job.name}): ${job.task}`);
    }

    return this.runTaskAndReport({
      chatId: job.chatId,
      task: job.task,
      source: "cron",
      modelName: job.model,
    });
  }

  private async runTaskAndReport(params: {
    chatId: number | null;
    task: string;
    source: "chat" | "cron";
    modelName: string | null;
  }): Promise<CronRunResult> {
    const { chatId, task, source, modelName } = params;
    this.log(
      `task accepted source=${source} chat=${chatId ?? "(none)"} task=${JSON.stringify(task)} model=${modelName ?? this.config.defaultModel}`,
    );

    return this.withTypingStatus(source === "chat" ? chatId : null, async () => {
      try {
        const result = await this.agent.runTask(
          task,
          modelName ?? undefined,
          chatId === null
            ? undefined
            : async (progress) => {
                this.log(
                  `progress source=${source} chat=${chatId} step=${progress.step}/${progress.maxSteps} action=${progress.actionType} app=${progress.currentApp}`,
                );
                const thought = this.sanitizeForChat(progress.thought, 120);
                const actionResult = this.sanitizeForChat(progress.message, 180);
                await this.bot.sendMessage(
                  chatId,
                  [
                    `Progress ${progress.step}/${progress.maxSteps}`,
                    `Current screen app: ${progress.currentApp}`,
                    `Action: ${progress.actionType}`,
                    `Reasoning: ${thought || "Continue observing and planning the next step."}`,
                    `Result: ${actionResult || "Action executed."}`,
                  ].join("\n"),
                );
              },
          chatId === null
            ? undefined
            : async (request) => {
                const timeoutSec = Math.max(30, Math.round(request.timeoutSec));
                return this.humanAuth.requestAndWait(
                  { chatId, task, request: { ...request, timeoutSec } },
                  async (opened) => {
                    const lines = [
                      `Human authorization required (${request.capability}).`,
                      `Request ID: ${opened.requestId}`,
                      `Current app: ${request.currentApp}`,
                      `Instruction: ${request.instruction}`,
                      `Reason: ${request.reason || "no reason provided"}`,
                      `Expires at: ${opened.expiresAt}`,
                      "",
                      "Fallback manual commands:",
                      opened.manualApproveCommand,
                      opened.manualRejectCommand,
                    ];

                    if (opened.openUrl) {
                      await this.bot.sendMessage(chatId, lines.join("\n"), {
                        reply_markup: {
                          inline_keyboard: [
                            [
                              {
                                text: "Open Human Auth",
                                url: opened.openUrl,
                              },
                            ],
                          ],
                        },
                      });
                      return;
                    }

                    await this.bot.sendMessage(
                      chatId,
                      `${lines.join("\n")}\n\nWeb link is unavailable. Use manual approve/reject commands.`,
                    );
                  },
                );
              },
        );

        this.log(`task done source=${source} chat=${chatId ?? "(none)"} ok=${result.ok} session=${result.sessionPath}`);

        if (chatId !== null) {
          if (result.ok) {
            await this.bot.sendMessage(
              chatId,
              `Task completed.\nResult: ${this.sanitizeForChat(result.message, 800) || "Completed."}`,
            );
          } else {
            await this.bot.sendMessage(
              chatId,
              `Task not completed.\nReason: ${this.sanitizeForChat(result.message, 800) || "Unknown error."}`,
            );
          }
        }

        return {
          accepted: true,
          ok: result.ok,
          message: result.message,
        };
      } catch (error) {
        const message = `Execution interrupted: ${(error as Error).message || "Unknown error."}`;
        this.log(`task crash source=${source} chat=${chatId ?? "(none)"} error=${(error as Error).message}`);
        if (chatId !== null) {
          await this.bot.sendMessage(chatId, this.sanitizeForChat(message, 600));
        }
        return {
          accepted: true,
          ok: false,
          message,
        };
      }
    });
  }

  private async handleAuthCommand(chatId: number, text: string): Promise<void> {
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length === 1 || parts[1] === "help") {
      await this.bot.sendMessage(
        chatId,
        [
          "Human auth commands:",
          "/auth pending",
          "/auth approve <request-id> [note]",
          "/auth reject <request-id> [note]",
        ].join("\n"),
      );
      return;
    }

    const sub = parts[1];
    if (sub === "pending") {
      const pending = this.humanAuth.listPending().filter((item) => item.chatId === chatId);
      if (pending.length === 0) {
        await this.bot.sendMessage(chatId, "No pending human-auth requests.");
        return;
      }
      const body = pending
        .slice(0, 20)
        .map(
          (item) =>
            `- ${item.requestId} capability=${item.capability} app=${item.currentApp} expires=${item.expiresAt}`,
        )
        .join("\n");
      await this.bot.sendMessage(chatId, `Pending human-auth requests (${pending.length}):\n${body}`);
      return;
    }

    if (sub === "approve" || sub === "reject") {
      const requestId = parts[2]?.trim();
      if (!requestId) {
        await this.bot.sendMessage(chatId, `Usage: /auth ${sub} <request-id> [note]`);
        return;
      }
      const note = parts.slice(3).join(" ").trim();
      const ok = this.humanAuth.resolvePending(requestId, sub === "approve", note, `chat:${chatId}`);
      await this.bot.sendMessage(
        chatId,
        ok ? `Request ${requestId} ${sub}d.` : `Pending request not found: ${requestId}`,
      );
      return;
    }

    await this.bot.sendMessage(chatId, "Unknown /auth subcommand. Use /auth help.");
  }
}
