import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig, saveConfig, getModelProfile, resolveApiKey } = require("../dist/config/index.js");

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

test("loadConfig creates defaults including returnHomeOnTaskEnd", () => {
  withTempHome("openpocket-config-default-", (home) => {
    const cfg = loadConfig();
    assert.equal(cfg.agent.returnHomeOnTaskEnd, true);
    assert.equal(cfg.humanAuth.enabled, false);
    assert.equal(cfg.humanAuth.useLocalRelay, true);
    assert.equal(cfg.humanAuth.localRelayPort, 8787);
    assert.equal(cfg.humanAuth.tunnel.provider, "none");
    assert.equal(cfg.humanAuth.requestTimeoutSec, 300);
    assert.equal(cfg.dashboard.enabled, true);
    assert.equal(cfg.dashboard.host, "127.0.0.1");
    assert.equal(cfg.dashboard.port, 51888);
    assert.equal(cfg.dashboard.autoOpenBrowser, false);
    assert.equal(cfg.heartbeat.enabled, true);
    assert.equal(cfg.cron.enabled, true);
    assert.equal(fs.existsSync(path.join(home, "config.json")), true);
    assert.equal(fs.existsSync(cfg.workspaceDir), true);
    assert.equal(fs.existsSync(cfg.stateDir), true);
    assert.equal(fs.existsSync(cfg.screenshots.directory), true);
    assert.equal(fs.existsSync(path.join(cfg.workspaceDir, "cron", "jobs.json")), true);
  });
});

test("loadConfig migrates legacy snake_case return_home_on_task_end", () => {
  withTempHome("openpocket-config-migrate-", (home) => {
    const cfgPath = path.join(home, "config.json");
    fs.writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          project_name: "OpenPocket",
          workspace_dir: path.join(home, "workspace"),
          state_dir: path.join(home, "state"),
          default_model: "gpt-5.2-codex",
          emulator: {
            avd_name: "TestAVD",
          },
          telegram: {},
          agent: {
            max_steps: 10,
            return_home_on_task_end: false,
            verbose: true,
          },
          models: {
            "gpt-5.2-codex": {
              base_url: "https://api.openai.com/v1",
              model: "gpt-5.2-codex",
              api_key: "",
              api_key_env: "OPENAI_API_KEY",
              max_tokens: 1024,
              reasoning_effort: "medium",
            },
          },
          human_auth: {
            enabled: true,
            use_local_relay: true,
            local_relay_host: "127.0.0.1",
            local_relay_port: 9898,
            relay_base_url: "https://relay.example.com",
            request_timeout_sec: 420,
            poll_interval_ms: 1500,
            tunnel: {
              provider_type: "ngrok",
              ngrok: {
                enabled: true,
                auth_token_env: "NGROK_AUTHTOKEN",
                startup_timeout_sec: 33,
              },
            },
          },
          dashboard_config: {
            enabled: true,
            host: "0.0.0.0",
            port: 51999,
            auto_open_browser: true,
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const cfg = loadConfig();
    assert.equal(cfg.agent.returnHomeOnTaskEnd, false);
    assert.equal(cfg.humanAuth.enabled, true);
    assert.equal(cfg.humanAuth.relayBaseUrl, "https://relay.example.com");
    assert.equal(cfg.humanAuth.localRelayPort, 9898);
    assert.equal(cfg.humanAuth.requestTimeoutSec, 420);
    assert.equal(cfg.humanAuth.tunnel.provider, "ngrok");
    assert.equal(cfg.humanAuth.tunnel.ngrok.enabled, true);
    assert.equal(cfg.humanAuth.tunnel.ngrok.authtokenEnv, "NGROK_AUTHTOKEN");
    assert.equal(cfg.humanAuth.tunnel.ngrok.startupTimeoutSec, 33);
    assert.equal(cfg.dashboard.enabled, true);
    assert.equal(cfg.dashboard.host, "0.0.0.0");
    assert.equal(cfg.dashboard.port, 51999);
    assert.equal(cfg.dashboard.autoOpenBrowser, true);

    saveConfig(cfg);
    const saved = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    assert.equal(saved.agent.returnHomeOnTaskEnd, false);
    assert.equal(saved.agent.return_home_on_task_end, undefined);
    assert.equal(saved.humanAuth.relayBaseUrl, "https://relay.example.com");
    assert.equal(saved.humanAuth.localRelayPort, 9898);
    assert.equal(saved.humanAuth.tunnel.provider, "ngrok");
    assert.equal(saved.human_auth, undefined);
  });
});

test("loadConfig normalizes agent.lang to en", () => {
  withTempHome("openpocket-config-lang-", (home) => {
    const cfgPath = path.join(home, "config.json");
    fs.writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          projectName: "OpenPocket",
          workspaceDir: path.join(home, "workspace"),
          stateDir: path.join(home, "state"),
          defaultModel: "gpt-5.2-codex",
          emulator: {},
          telegram: {},
          agent: {
            lang: "zh",
          },
          models: {
            "gpt-5.2-codex": {
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-5.2-codex",
              apiKey: "",
              apiKeyEnv: "OPENAI_API_KEY",
              maxTokens: 1024,
              reasoningEffort: "medium",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.agent.lang, "en");

    saveConfig(cfg);
    const saved = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    assert.equal(saved.agent.lang, "en");
  });
});

test("getModelProfile and resolveApiKey follow precedence rules", () => {
  withTempHome("openpocket-config-key-", (home) => {
    const cfg = loadConfig(path.join(home, "config.json"));
    const profile = getModelProfile(cfg, cfg.defaultModel);
    assert.equal(profile.model.length > 0, true);

    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "  env-key  ";
    try {
      assert.equal(resolveApiKey({ ...profile, apiKey: " local-key ", apiKeyEnv: "OPENAI_API_KEY" }), "local-key");
      assert.equal(resolveApiKey({ ...profile, apiKey: "", apiKeyEnv: "OPENAI_API_KEY" }), "env-key");
      assert.equal(resolveApiKey({ ...profile, apiKey: "", apiKeyEnv: "MISSING_ENV" }), "");
    } finally {
      if (prev === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prev;
      }
    }
  });
});

test("getModelProfile throws on unknown profile", () => {
  withTempHome("openpocket-config-unknown-", () => {
    const cfg = loadConfig();
    assert.throws(() => getModelProfile(cfg, "unknown-model"), /Unknown model profile/);
  });
});
