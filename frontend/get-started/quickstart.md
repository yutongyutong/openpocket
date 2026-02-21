# Quickstart

This page gets OpenPocket running locally with the current Node.js + TypeScript runtime.

OpenPocket runs automation on a local Android emulator, so tasks do not consume resources on your physical phone.

## Prerequisites

- Node.js 20+
- Android SDK Emulator and platform-tools (`adb`)
- At least one Android AVD
- API key for your configured model profile
- Telegram bot token (for gateway mode)

You do not need to root or modify your personal phone to use OpenPocket.

## npm Install

```bash
npm install -g openpocket
openpocket onboard
```

If you use the native macOS panel, install the release package from:

- [OpenPocket Releases](https://github.com/SergioChan/openpocket/releases)

Then start the panel:

```bash
openpocket panel start
```

## Source Install

```bash
git clone git@github.com:SergioChan/openpocket.git
cd openpocket
npm install
npm run build
./openpocket onboard
```

`./openpocket` uses `dist/cli.js` when present and falls back to `tsx src/cli.ts` in dev installs.

Default runtime home is `~/.openpocket`, unless `OPENPOCKET_HOME` is set.

For commands below:

- use `openpocket ...` for npm package install
- use `./openpocket ...` for local clone

On first `onboard`, OpenPocket creates:

- `config.json`
- `workspace/` with bootstrap files and directories
- `state/` for runtime state and emulator logs

`onboard` creates/updates onboarding state in `state/onboarding.json` and guides:

- user consent
- model profile selection (GPT/Claude/AutoGLM profiles)
- provider-specific API key setup based on selected model
- Telegram token source and chat allowlist policy
- option prompts use Up/Down arrows + Enter
- emulator wake-up + manual Gmail login for Play Store
- human-auth mode selection (`disabled`, `LAN relay`, `local relay + ngrok`)
- Android dependency doctor + auto-install on macOS when required (includes Java 17+ runtime for sdkmanager)
- existing AVD reuse to avoid repeated heavy system-image/bootstrap downloads on later onboard runs

If you explicitly want a user-local PATH command without npm global install:

```bash
./openpocket install-cli
```

Legacy aliases still work (deprecated): `openpocket init`, `openpocket setup`.

## Env Vars

```bash
export OPENAI_API_KEY="<your_key>"
export OPENROUTER_API_KEY="<your_key>"        # required if using Claude/OpenRouter profile
export TELEGRAM_BOT_TOKEN="<your_bot_token>"   # only for Telegram gateway
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"   # recommended
```

Optional:

```bash
export OPENPOCKET_HOME="$HOME/.openpocket"
export AUTOGLM_API_KEY="<optional>"
export OPENPOCKET_HUMAN_AUTH_KEY="<optional relay api key>"
export NGROK_AUTHTOKEN="<optional ngrok token>"
```

## Command Check

```bash
openpocket config-show
openpocket emulator status
openpocket emulator start
openpocket emulator screenshot --out ~/Desktop/openpocket-screen.png
openpocket skills list
openpocket script run --text "echo hello"
```

## Run a Task

```bash
openpocket agent --model gpt-5.2-codex "Open Chrome and search weather"
```

Result includes:

- terminal summary message
- session file path (`workspace/sessions/session-*.md`)
- daily memory append in `workspace/memory/YYYY-MM-DD.md`

## Control Modes

OpenPocket supports two operating styles:

- direct local control of the emulator by the user
- agent control of the same emulator runtime

This allows practical handoff between manual and automated execution.

Current remote human-in-the-loop support:

- if agent emits `request_human_auth`, gateway can issue a one-time approval link
- user can approve/reject from phone browser, or use `/auth approve|reject` in Telegram

Planned next step:

- broader phone-side remote controls (pause/resume/retry beyond auth-only checkpoints)

## Telegram Gateway

```bash
openpocket gateway start
```

Then chat with your bot and send `/help`.

For auth workflow testing, use:

- `/auth pending`
- `/auth approve <request-id> [note]`
- `/auth reject <request-id> [note]`
