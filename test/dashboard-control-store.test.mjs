import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../dist/config/index.js");
const {
  dashboardPaths,
  defaultControlSettings,
  defaultOnboardingState,
  loadControlSettings,
  loadOnboardingState,
  saveControlSettings,
  saveOnboardingState,
  defaultPromptEntries,
} = require("../dist/dashboard/control-store.js");

function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENPOCKET_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("control store provides defaults and persists onboarding/control files", () => {
  withTempHome("openpocket-dashboard-store-", () => {
    const cfg = loadConfig();

    const onboarding = loadOnboardingState(cfg);
    assert.equal(onboarding.modelProfile, null);

    const control = loadControlSettings(cfg);
    assert.equal(control.permission.allowLocalStorageView, false);
    assert.equal(control.promptFiles.length > 0, true);

    const nextOnboarding = {
      ...onboarding,
      modelProfile: cfg.defaultModel,
      apiKeySource: "env",
    };
    saveOnboardingState(cfg, nextOnboarding);

    const nextControl = {
      ...control,
      permission: {
        ...control.permission,
        allowLocalStorageView: true,
        allowedExtensions: ["md"],
      },
    };
    saveControlSettings(cfg, nextControl);

    const loadedOnboarding = loadOnboardingState(cfg);
    const loadedControl = loadControlSettings(cfg);

    assert.equal(loadedOnboarding.modelProfile, cfg.defaultModel);
    assert.equal(loadedOnboarding.apiKeySource, "env");
    assert.equal(loadedControl.permission.allowLocalStorageView, true);
    assert.deepEqual(loadedControl.permission.allowedExtensions, ["md"]);

    const paths = dashboardPaths(cfg);
    assert.equal(fs.existsSync(paths.onboardingPath), true);
    assert.equal(fs.existsSync(paths.controlPanelPath), true);
  });
});

test("default prompt entries include core prompt files", () => {
  const entries = defaultPromptEntries("/tmp/openpocket-workspace");
  assert.equal(entries.length, 7);
  assert.equal(entries[0].id, "agents");
  assert.match(entries[0].path, /AGENTS\.md$/);

  const onboarding = defaultOnboardingState();
  assert.equal(onboarding.updatedAt.length > 0, true);

  const control = defaultControlSettings({ workspaceDir: "/tmp/openpocket-workspace" });
  assert.equal(control.promptFiles.length, 7);
});
