import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../dist/config/index.js");
const { ensureAndroidPrerequisites } = require("../dist/environment/android-prerequisites.js");

function withTempHome(prefix, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prev;
    }
  }
}

test("ensureAndroidPrerequisites supports skip mode for CI/tests", async () => {
  await withTempHome("openpocket-env-skip-", async () => {
    const prev = process.env.OPENPOCKET_SKIP_ENV_SETUP;
    process.env.OPENPOCKET_SKIP_ENV_SETUP = "1";
    try {
      const cfg = loadConfig();
      cfg.emulator.androidSdkRoot = "";
      const result = await ensureAndroidPrerequisites(cfg, { autoInstall: true });
      assert.equal(result.skipped, true);
      assert.equal(path.isAbsolute(result.sdkRoot), true);
      assert.equal(cfg.emulator.androidSdkRoot.length > 0, true);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENPOCKET_SKIP_ENV_SETUP;
      } else {
        process.env.OPENPOCKET_SKIP_ENV_SETUP = prev;
      }
    }
  });
});

test("strict mode uses only Google Play system image candidates", () => {
  const { getSystemImageCandidates } = require("../dist/environment/android-prerequisites.js");
  assert.equal(typeof getSystemImageCandidates, "function");

  const candidates = getSystemImageCandidates();
  assert.equal(candidates.length > 0, true);
  assert.equal(
    candidates.every((pkg) => pkg.includes(";google_apis_playstore;")),
    true,
  );
});
