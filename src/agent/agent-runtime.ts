import type {
  AgentProgressUpdate,
  AgentRunResult,
  HumanAuthDecision,
  HumanAuthRequest,
  OpenPocketConfig,
  SkillInfo,
} from "../types";
import { getModelProfile, resolveApiKey } from "../config";
import { WorkspaceStore } from "../memory/workspace";
import { ScreenshotStore } from "../memory/screenshot-store";
import { sleep } from "../utils/time";
import { nowIso } from "../utils/paths";
import { AdbRuntime } from "../device/adb-runtime";
import { EmulatorManager } from "../device/emulator-manager";
import { AutoArtifactBuilder, type StepTrace } from "../skills/auto-artifact-builder";
import { SkillLoader } from "../skills/skill-loader";
import { ScriptExecutor } from "../tools/script-executor";
import { ModelClient } from "./model-client";
import { buildSystemPrompt } from "./prompts";

const AUTO_PERMISSION_DIALOG_PACKAGES = [
  "permissioncontroller",
  "packageinstaller",
];

export class AgentRuntime {
  private readonly config: OpenPocketConfig;
  private readonly workspace: WorkspaceStore;
  private readonly emulator: EmulatorManager;
  private readonly adb: AdbRuntime;
  private readonly skillLoader: SkillLoader;
  private readonly autoArtifactBuilder: AutoArtifactBuilder;
  private readonly scriptExecutor: ScriptExecutor;
  private readonly screenshotStore: ScreenshotStore;
  private busy = false;
  private stopRequested = false;
  private currentTask: string | null = null;
  private currentTaskStartedAtMs: number | null = null;

  constructor(config: OpenPocketConfig) {
    this.config = config;
    this.workspace = new WorkspaceStore(config);
    this.emulator = new EmulatorManager(config);
    this.adb = new AdbRuntime(config, this.emulator);
    this.skillLoader = new SkillLoader(config);
    this.autoArtifactBuilder = new AutoArtifactBuilder(config);
    this.scriptExecutor = new ScriptExecutor(config);
    this.screenshotStore = new ScreenshotStore(
      config.screenshots.directory,
      config.screenshots.maxCount,
    );
  }

  isBusy(): boolean {
    return this.busy;
  }

  getCurrentTask(): string | null {
    return this.currentTask;
  }

  getCurrentTaskRuntimeMs(): number | null {
    if (!this.currentTaskStartedAtMs) {
      return null;
    }
    return Math.max(0, Date.now() - this.currentTaskStartedAtMs);
  }

  listSkills(): SkillInfo[] {
    return this.skillLoader.loadAll();
  }

  captureManualScreenshot(): string {
    const snapshot = this.adb.captureScreenSnapshot(this.config.agent.deviceId);
    return this.screenshotStore.save(
      Buffer.from(snapshot.screenshotBase64, "base64"),
      {
        sessionId: "manual",
        step: 0,
        currentApp: snapshot.currentApp,
      },
    );
  }

  stopCurrentTask(): boolean {
    if (!this.busy) {
      return false;
    }
    this.stopRequested = true;
    return true;
  }

  private async safeReturnToHome(): Promise<void> {
    if (!this.config.agent.returnHomeOnTaskEnd) {
      return;
    }

    try {
      const result = await this.adb.executeAction(
        { type: "keyevent", keycode: "KEYCODE_HOME", reason: "task_end_default_reset" },
        this.config.agent.deviceId,
      );
      if (this.config.agent.verbose) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][task-end] ${result}`);
      }
    } catch (error) {
      if (this.config.agent.verbose) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][task-end] failed to return home: ${(error as Error).message}`);
      }
    }
  }

  async runTask(
    task: string,
    modelName?: string,
    onProgress?: (update: AgentProgressUpdate) => Promise<void> | void,
    onHumanAuth?: (request: HumanAuthRequest) => Promise<HumanAuthDecision> | HumanAuthDecision,
  ): Promise<AgentRunResult> {
    if (this.busy) {
      return {
        ok: false,
        message: "Agent is busy. Please retry later.",
        sessionPath: "",
      };
    }

    this.busy = true;
    this.stopRequested = false;
    this.currentTask = task;
    this.currentTaskStartedAtMs = Date.now();
    let shouldReturnHome = false;

    const profileKey = modelName ?? this.config.defaultModel;
    const profile = getModelProfile(this.config, profileKey);
    const session = this.workspace.createSession(task, profileKey, profile.model);
    let lastAutoPermissionAuthAtMs = 0;

    try {
      const apiKey = resolveApiKey(profile);
      if (!apiKey) {
        const message = `Missing API key for model '${profile.model}'. Set env ${profile.apiKeyEnv} or config.models.${profileKey}.apiKey`;
        this.workspace.finalizeSession(session, false, message);
        this.workspace.appendDailyMemory(profileKey, task, false, message);
        return {
          ok: false,
          message,
          sessionPath: session.path,
        };
      }

      const model = new ModelClient(profile, apiKey);
      const history: string[] = [];
      const traces: StepTrace[] = [];
      const skillsSummary = this.skillLoader.summaryText();
      const systemPrompt = buildSystemPrompt(skillsSummary);

      for (let step = 1; step <= this.config.agent.maxSteps; step += 1) {
        if (this.stopRequested) {
          const message = "Task stopped by user.";
          this.workspace.finalizeSession(session, false, message);
          this.workspace.appendDailyMemory(profileKey, task, false, message);
          return {
            ok: false,
            message,
            sessionPath: session.path,
          };
        }

        const snapshot = this.adb.captureScreenSnapshot(this.config.agent.deviceId);
        shouldReturnHome = true;
        let screenshotPath: string | null = null;
        if (this.config.screenshots.saveStepScreenshots) {
          try {
            screenshotPath = this.screenshotStore.save(
              Buffer.from(snapshot.screenshotBase64, "base64"),
              {
                sessionId: session.id,
                step,
                currentApp: snapshot.currentApp,
              },
            );
          } catch {
            screenshotPath = null;
          }
        }

        const autoPermissionDialogDetected =
          this.config.humanAuth.enabled &&
          typeof onHumanAuth === "function" &&
          AUTO_PERMISSION_DIALOG_PACKAGES.some((token) =>
            snapshot.currentApp.toLowerCase().includes(token),
          ) &&
          Date.now() - lastAutoPermissionAuthAtMs >= 15_000;

        if (autoPermissionDialogDetected && onHumanAuth) {
          lastAutoPermissionAuthAtMs = Date.now();
          const autoThought =
            "Detected Android runtime permission dialog. Escalating to human authorization.";
          const autoAction = {
            type: "request_human_auth",
            capability: "permission",
            instruction:
              "A system permission dialog is blocking automation. Review and approve or reject this permission from your real device.",
            timeoutSec: Math.max(30, Math.round(this.config.humanAuth.requestTimeoutSec)),
            reason: "auto_detected_android_permission_dialog",
          } as const;

          let decision: HumanAuthDecision;
          try {
            decision = await onHumanAuth({
              sessionId: session.id,
              sessionPath: session.path,
              task,
              step,
              capability: autoAction.capability,
              instruction: autoAction.instruction,
              reason: autoAction.reason ?? autoThought,
              timeoutSec: autoAction.timeoutSec,
              currentApp: snapshot.currentApp,
              screenshotPath,
            });
          } catch (error) {
            decision = {
              requestId: "local-error",
              approved: false,
              status: "rejected",
              message: `Human auth bridge error: ${(error as Error).message}`,
              decidedAt: nowIso(),
              artifactPath: null,
            };
          }

          const decisionLine = `Human auth ${decision.status} request_id=${decision.requestId} message=${decision.message}`;
          const stepResultBase = decision.artifactPath
            ? `${decisionLine}\nhuman_artifact=${decision.artifactPath}`
            : decisionLine;
          const stepResult = screenshotPath
            ? `${stepResultBase}\nlocal_screenshot=${screenshotPath}`
            : stepResultBase;

          this.workspace.appendStep(
            session,
            step,
            autoThought,
            JSON.stringify(autoAction, null, 2),
            stepResult,
          );
          traces.push({
            step,
            action: autoAction,
            result: stepResult,
            thought: autoThought,
            currentApp: snapshot.currentApp,
          });
          history.push(
            `step ${step}: app=${snapshot.currentApp} action=request_human_auth(auto_permission_dialog) decision=${decision.status} message=${decision.message}`,
          );

          if (onProgress && step % this.config.agent.progressReportInterval === 0) {
            try {
              await onProgress({
                step,
                maxSteps: this.config.agent.maxSteps,
                currentApp: snapshot.currentApp,
                actionType: autoAction.type,
                message: decisionLine,
                thought: autoThought,
                screenshotPath,
              });
            } catch {
              // Keep task execution unaffected when progress callback fails.
            }
          }

          if (!decision.approved) {
            const message = `Human authorization ${decision.status}: ${decision.message}`;
            this.workspace.finalizeSession(session, false, message);
            this.workspace.appendDailyMemory(profileKey, task, false, message);
            return {
              ok: false,
              message,
              sessionPath: session.path,
            };
          }

          await sleep(Math.min(this.config.agent.loopDelayMs, 1200));
          continue;
        }

        const output = await model.nextStep({
          systemPrompt,
          task,
          step,
          snapshot,
          history,
        });

        if (output.action.type === "finish") {
          const finishMessage = output.action.message || "Task completed.";
          this.workspace.appendStep(
            session,
            step,
            output.thought,
            JSON.stringify(output.action, null, 2),
            `FINISH: ${finishMessage}`,
          );
          traces.push({
            step,
            action: output.action,
            result: `FINISH: ${finishMessage}`,
            thought: output.thought,
            currentApp: snapshot.currentApp,
          });
          this.workspace.finalizeSession(session, true, finishMessage);
          this.workspace.appendDailyMemory(profileKey, task, true, finishMessage);
          const artifacts = this.autoArtifactBuilder.build({
            task,
            sessionPath: session.path,
            ok: true,
            finalMessage: finishMessage,
            traces,
          });
          if (artifacts.skillPath) {
            // eslint-disable-next-line no-console
            console.log(`[OpenPocket][artifact] auto skill generated: ${artifacts.skillPath}`);
          }
          if (artifacts.scriptPath) {
            // eslint-disable-next-line no-console
            console.log(`[OpenPocket][artifact] auto script generated: ${artifacts.scriptPath}`);
          }
          return {
            ok: true,
            message: finishMessage,
            sessionPath: session.path,
          };
        }

        if (output.action.type === "request_human_auth") {
          const timeoutSec = Math.max(
            30,
            Math.round(output.action.timeoutSec ?? this.config.humanAuth.requestTimeoutSec),
          );

          if (!onHumanAuth) {
            const message = `Human authorization required (${output.action.capability}), but no human auth handler is configured.`;
            const stepResult = screenshotPath
              ? `${message}\nlocal_screenshot=${screenshotPath}`
              : message;
            this.workspace.appendStep(
              session,
              step,
              output.thought,
              JSON.stringify(output.action, null, 2),
              stepResult,
            );
            traces.push({
              step,
              action: output.action,
              result: stepResult,
              thought: output.thought,
              currentApp: snapshot.currentApp,
            });
            this.workspace.finalizeSession(session, false, message);
            this.workspace.appendDailyMemory(profileKey, task, false, message);
            return {
              ok: false,
              message,
              sessionPath: session.path,
            };
          }

          let decision: HumanAuthDecision;
          try {
            decision = await onHumanAuth({
              sessionId: session.id,
              sessionPath: session.path,
              task,
              step,
              capability: output.action.capability,
              instruction: output.action.instruction,
              reason: output.action.reason ?? output.thought,
              timeoutSec,
              currentApp: snapshot.currentApp,
              screenshotPath,
            });
          } catch (error) {
            decision = {
              requestId: "local-error",
              approved: false,
              status: "rejected",
              message: `Human auth bridge error: ${(error as Error).message}`,
              decidedAt: nowIso(),
              artifactPath: null,
            };
          }

          const decisionLine = `Human auth ${decision.status} request_id=${decision.requestId} message=${decision.message}`;
          const stepResultBase = decision.artifactPath
            ? `${decisionLine}\nhuman_artifact=${decision.artifactPath}`
            : decisionLine;
          const stepResult = screenshotPath
            ? `${stepResultBase}\nlocal_screenshot=${screenshotPath}`
            : stepResultBase;

          this.workspace.appendStep(
            session,
            step,
            output.thought,
            JSON.stringify(output.action, null, 2),
            stepResult,
          );
          traces.push({
            step,
            action: output.action,
            result: stepResult,
            thought: output.thought,
            currentApp: snapshot.currentApp,
          });
          history.push(
            `step ${step}: app=${snapshot.currentApp} action=request_human_auth decision=${decision.status} message=${decision.message}`,
          );

          if (onProgress && step % this.config.agent.progressReportInterval === 0) {
            try {
              await onProgress({
                step,
                maxSteps: this.config.agent.maxSteps,
                currentApp: snapshot.currentApp,
                actionType: output.action.type,
                message: decisionLine,
                thought: output.thought,
                screenshotPath,
              });
            } catch {
              // Keep task execution unaffected when progress callback fails.
            }
          }

          if (!decision.approved) {
            const message = `Human authorization ${decision.status}: ${decision.message}`;
            this.workspace.finalizeSession(session, false, message);
            this.workspace.appendDailyMemory(profileKey, task, false, message);
            return {
              ok: false,
              message,
              sessionPath: session.path,
            };
          }

          await sleep(Math.min(this.config.agent.loopDelayMs, 1200));
          continue;
        }

        let executionResult = "";
        try {
          if (output.action.type === "run_script") {
            const scriptResult = await this.scriptExecutor.execute(
              output.action.script,
              output.action.timeoutSec,
            );
            executionResult = [
              `run_script exitCode=${scriptResult.exitCode} timedOut=${scriptResult.timedOut}`,
              `runDir=${scriptResult.runDir}`,
              scriptResult.stdout ? `stdout=${scriptResult.stdout}` : "",
              scriptResult.stderr ? `stderr=${scriptResult.stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          } else {
            executionResult = await this.adb.executeAction(output.action, this.config.agent.deviceId);
          }
        } catch (error) {
          executionResult = `Action execution error: ${(error as Error).message}`;
        }

        const stepResult = screenshotPath
          ? `${executionResult}\nlocal_screenshot=${screenshotPath}`
          : executionResult;
        this.workspace.appendStep(
          session,
          step,
          output.thought,
          JSON.stringify(output.action, null, 2),
          stepResult,
        );
        traces.push({
          step,
          action: output.action,
          result: stepResult,
          thought: output.thought,
          currentApp: snapshot.currentApp,
        });

        history.push(
          `step ${step}: app=${snapshot.currentApp} action=${output.action.type} result=${executionResult}`,
        );

        if (this.config.agent.verbose) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][step ${step}] ${output.action.type}: ${executionResult}`);
        }

        if (onProgress && step % this.config.agent.progressReportInterval === 0) {
          try {
            await onProgress({
              step,
              maxSteps: this.config.agent.maxSteps,
              currentApp: snapshot.currentApp,
              actionType: output.action.type,
              message: executionResult,
              thought: output.thought,
              screenshotPath,
            });
          } catch {
            // Keep task execution unaffected when progress callback fails.
          }
        }

        if (output.action.type !== "wait") {
          await sleep(this.config.agent.loopDelayMs);
        }
      }

      const message = `Max steps reached (${this.config.agent.maxSteps})`;
      this.workspace.finalizeSession(session, false, message);
      this.workspace.appendDailyMemory(profileKey, task, false, message);
      return {
        ok: false,
        message,
        sessionPath: session.path,
      };
    } catch (error) {
      const message = `Agent execution failed: ${(error as Error).message}`;
      this.workspace.finalizeSession(session, false, message);
      this.workspace.appendDailyMemory(profileKey, task, false, message);
      return {
        ok: false,
        message,
        sessionPath: session.path,
      };
    } finally {
      if (shouldReturnHome) {
        await this.safeReturnToHome();
      }
      this.busy = false;
      this.currentTask = null;
      this.currentTaskStartedAtMs = null;
      this.stopRequested = false;
    }
  }
}
