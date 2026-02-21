import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../dist/config/index.js");
const { TelegramGateway } = require("../dist/gateway/telegram-gateway.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempHome(prefix, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("TelegramGateway keeps typing heartbeat during async operation", async () => {
  await withTempHome("openpocket-telegram-typing-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});
    const calls = [];

    gateway.bot.sendChatAction = async (chatId, action) => {
      calls.push({ chatId, action, at: Date.now() });
      return true;
    };

    await gateway.withTypingStatus(123456, async () => {
      await sleep(135);
    });

    assert.equal(calls.length >= 3, true, "typing should be sent repeatedly during operation");
    assert.equal(calls.every((item) => item.chatId === 123456), true);
    assert.equal(calls.every((item) => item.action === "typing"), true);

    const doneCount = calls.length;
    await sleep(80);
    assert.equal(calls.length, doneCount, "typing heartbeat should stop after operation finishes");
  });
});

test("TelegramGateway typing heartbeat supports nested operations", async () => {
  await withTempHome("openpocket-telegram-typing-nested-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 25 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});
    const calls = [];

    gateway.bot.sendChatAction = async (chatId, action) => {
      calls.push({ chatId, action, at: Date.now() });
      return true;
    };

    await gateway.withTypingStatus(8899, async () => {
      await sleep(40);
      await gateway.withTypingStatus(8899, async () => {
        await sleep(60);
      });
      await sleep(40);
    });

    assert.equal(calls.length >= 3, true);

    const doneCount = calls.length;
    await sleep(70);
    assert.equal(calls.length, doneCount, "typing heartbeat should not leak after nested operations");
  });
});
