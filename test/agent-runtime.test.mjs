import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../dist/config/index.js");
const { AgentRuntime } = require("../dist/agent/agent-runtime.js");
const { ModelClient } = require("../dist/agent/model-client.js");

function makeSnapshot() {
  return {
    deviceId: "emulator-5554",
    currentApp: "com.android.launcher3",
    width: 1080,
    height: 2400,
    screenshotBase64: "abc",
    capturedAt: new Date().toISOString(),
  };
}

function setupRuntime({ returnHomeOnTaskEnd }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-runtime-"));
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();
  cfg.agent.verbose = false;
  cfg.agent.maxSteps = 3;
  cfg.agent.loopDelayMs = 1;
  cfg.agent.returnHomeOnTaskEnd = returnHomeOnTaskEnd;
  cfg.models[cfg.defaultModel].apiKey = "dummy";
  cfg.models[cfg.defaultModel].apiKeyEnv = "MISSING_OPENAI_KEY";

  const runtime = new AgentRuntime(cfg);
  if (prevHome === undefined) {
    delete process.env.OPENPOCKET_HOME;
  } else {
    process.env.OPENPOCKET_HOME = prevHome;
  }
  return runtime;
}

test("AgentRuntime returns home after successful task by default", async () => {
  const runtime = setupRuntime({ returnHomeOnTaskEnd: true });
  const actionCalls = [];

  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async (action) => {
      actionCalls.push(action);
      return "ok";
    },
  };
  runtime.autoArtifactBuilder = {
    build: () => ({ skillPath: null, scriptPath: null }),
  };

  const originalNextStep = ModelClient.prototype.nextStep;
  ModelClient.prototype.nextStep = async () => ({
    thought: "done",
    action: { type: "finish", message: "task completed" },
    raw: '{"thought":"done","action":{"type":"finish","message":"task completed"}}',
  });

  try {
    const result = await runtime.runTask("go home test");
    assert.equal(result.ok, true);
    assert.equal(
      actionCalls.some((action) => action.type === "keyevent" && action.keycode === "KEYCODE_HOME"),
      true,
    );
  } finally {
    ModelClient.prototype.nextStep = originalNextStep;
  }
});

test("AgentRuntime does not return home when config is disabled", async () => {
  const runtime = setupRuntime({ returnHomeOnTaskEnd: false });
  const actionCalls = [];

  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async (action) => {
      actionCalls.push(action);
      return "ok";
    },
  };
  runtime.autoArtifactBuilder = {
    build: () => ({ skillPath: null, scriptPath: null }),
  };

  const originalNextStep = ModelClient.prototype.nextStep;
  ModelClient.prototype.nextStep = async () => ({
    thought: "done",
    action: { type: "finish", message: "task completed" },
    raw: '{"thought":"done","action":{"type":"finish","message":"task completed"}}',
  });

  try {
    const result = await runtime.runTask("no-home test");
    assert.equal(result.ok, true);
    assert.equal(
      actionCalls.some((action) => action.type === "keyevent" && action.keycode === "KEYCODE_HOME"),
      false,
    );
  } finally {
    ModelClient.prototype.nextStep = originalNextStep;
  }
});

test("AgentRuntime pauses for request_human_auth and resumes after approval", async () => {
  const runtime = setupRuntime({ returnHomeOnTaskEnd: false });
  const actions = [];
  const authRequests = [];

  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };
  runtime.autoArtifactBuilder = {
    build: () => ({ skillPath: null, scriptPath: null }),
  };

  let callCount = 0;
  const originalNextStep = ModelClient.prototype.nextStep;
  ModelClient.prototype.nextStep = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        thought: "Need real camera authorization",
        action: {
          type: "request_human_auth",
          capability: "camera",
          instruction: "Please approve camera access.",
          timeoutSec: 120,
        },
        raw: '{"thought":"Need real camera authorization","action":{"type":"request_human_auth","capability":"camera","instruction":"Please approve camera access.","timeoutSec":120}}',
      };
    }
    return {
      thought: "Done",
      action: { type: "finish", message: "Completed after approval" },
      raw: '{"thought":"Done","action":{"type":"finish","message":"Completed after approval"}}',
    };
  };

  try {
    const result = await runtime.runTask(
      "human auth resume test",
      undefined,
      undefined,
      async (request) => {
        authRequests.push(request);
        return {
          requestId: "req-1",
          approved: true,
          status: "approved",
          message: "Approved by test.",
          decidedAt: new Date().toISOString(),
          artifactPath: null,
        };
      },
    );
    assert.equal(result.ok, true);
    assert.equal(authRequests.length, 1);
    assert.equal(authRequests[0].capability, "camera");
    assert.equal(actions.some((item) => item.type === "request_human_auth"), false);
  } finally {
    ModelClient.prototype.nextStep = originalNextStep;
  }
});

test("AgentRuntime fails when request_human_auth is rejected", async () => {
  const runtime = setupRuntime({ returnHomeOnTaskEnd: false });
  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };
  runtime.autoArtifactBuilder = {
    build: () => ({ skillPath: null, scriptPath: null }),
  };

  const originalNextStep = ModelClient.prototype.nextStep;
  ModelClient.prototype.nextStep = async () => ({
    thought: "Need OTP",
    action: {
      type: "request_human_auth",
      capability: "2fa",
      instruction: "Confirm OTP code.",
      timeoutSec: 60,
    },
    raw: '{"thought":"Need OTP","action":{"type":"request_human_auth","capability":"2fa","instruction":"Confirm OTP code.","timeoutSec":60}}',
  });

  try {
    const result = await runtime.runTask(
      "human auth reject test",
      undefined,
      undefined,
      async () => ({
        requestId: "req-2",
        approved: false,
        status: "rejected",
        message: "User rejected",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /Human authorization rejected/);
  } finally {
    ModelClient.prototype.nextStep = originalNextStep;
  }
});

test("AgentRuntime auto-triggers human auth on Android permission dialog app", async () => {
  const runtime = setupRuntime({ returnHomeOnTaskEnd: false });
  runtime.config.humanAuth.enabled = true;
  const authRequests = [];
  let snapshotCount = 0;

  runtime.adb = {
    captureScreenSnapshot: () => {
      snapshotCount += 1;
      if (snapshotCount === 1) {
        return {
          ...makeSnapshot(),
          currentApp: "com.android.permissioncontroller",
        };
      }
      return makeSnapshot();
    },
    executeAction: async () => "ok",
  };
  runtime.autoArtifactBuilder = {
    build: () => ({ skillPath: null, scriptPath: null }),
  };

  let modelCalls = 0;
  const originalNextStep = ModelClient.prototype.nextStep;
  ModelClient.prototype.nextStep = async () => {
    modelCalls += 1;
    return {
      thought: "done",
      action: { type: "finish", message: "Completed after auto human auth" },
      raw: '{"thought":"done","action":{"type":"finish","message":"Completed after auto human auth"}}',
    };
  };

  try {
    const result = await runtime.runTask(
      "auto permission dialog test",
      undefined,
      undefined,
      async (request) => {
        authRequests.push(request);
        return {
          requestId: "req-auto-perm",
          approved: true,
          status: "approved",
          message: "Approved from phone",
          decidedAt: new Date().toISOString(),
          artifactPath: null,
        };
      },
    );

    assert.equal(result.ok, true);
    assert.equal(authRequests.length, 1);
    assert.equal(authRequests[0].capability, "permission");
    assert.match(authRequests[0].instruction, /system permission dialog/i);
    assert.equal(modelCalls >= 1, true);
  } finally {
    ModelClient.prototype.nextStep = originalNextStep;
  }
});
