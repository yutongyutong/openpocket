# Configuration

OpenPocket loads config from JSON, merges with defaults, normalizes legacy keys, and writes a resolved runtime structure.

## File Location

Resolution order:

1. CLI `--config <path>` if provided
2. default `OPENPOCKET_HOME/config.json`
3. if missing, a default config file is auto-created

`OPENPOCKET_HOME` defaults to `~/.openpocket`.

## Load Order

At startup, config handling does the following:

1. Parse JSON from config path.
2. Convert legacy `snake_case` keys to `camelCase` keys.
3. Deep-merge with default config object.
4. Normalize model profiles and typed fields.
5. Resolve paths (`~` and relative paths to absolute).
6. Ensure required directories exist.
7. Bootstrap workspace files if missing.

## API Keys

For each model profile:

- Use `models.<name>.apiKey` if non-empty.
- Else use env var from `models.<name>.apiKeyEnv`.
- Else treat key as missing and fail task early.

For human-auth relay:

- use `humanAuth.apiKey` if non-empty
- else use env from `humanAuth.apiKeyEnv` (default `OPENPOCKET_HUMAN_AUTH_KEY`)
- if both are empty, relay still works in no-auth mode (recommended only for trusted local setups)

## Legacy Keys

The loader accepts old keys and maps them automatically, including:

- top-level: `project_name`, `workspace_dir`, `state_dir`, `default_model`, `script_executor`
- top-level (also): `heartbeat_config`, `cron_config`
- nested: `avd_name`, `android_sdk_root`, `bot_token`, `max_steps`, `save_step_screenshots`, `allowed_commands`, `base_url`, `api_key`, `reasoning_effort`, etc.

After `onboard` (or legacy `init`), saved config uses camelCase keys.

## Validation

Normalization currently enforces:

- `agent.progressReportInterval >= 1`
- `screenshots.maxCount >= 20`
- `scriptExecutor.timeoutSec >= 1`
- `scriptExecutor.maxOutputChars >= 1000`
- `heartbeat.everySec >= 5`
- `heartbeat.stuckTaskWarnSec >= 30`
- `cron.tickSec >= 2`

If `defaultModel` does not exist in `models`, startup throws an error.

## Defaults

See [Config Defaults](../reference/config-defaults.md) for the exact default JSON and field-by-field reference.
