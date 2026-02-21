# Operations Runbook

This runbook focuses on day-to-day operation of the current runtime.

## Daily Start

1. Ensure Android emulator dependencies are available.
2. Verify config and environment variables.
3. Run onboarding if first launch.
4. Start emulator and check booted device.
5. Start gateway or run tasks from CLI.
6. Validate human-auth readiness if remote approvals are enabled.

Commands:

```bash
openpocket config-show
openpocket onboard
openpocket emulator status
openpocket emulator start
openpocket gateway start
```

If the launcher is not in PATH yet, use `node dist/cli.js <command>`.

Human-auth readiness checks:

- `humanAuth.enabled` and `humanAuth.useLocalRelay` in config
- `humanAuth.relayBaseUrl` / `humanAuth.publicBaseUrl` populated after gateway boot
- if ngrok mode is enabled, verify `NGROK_AUTHTOKEN` (or config token) is available

## Monitoring

- gateway terminal logs show accepted task, step progress, and final status
- heartbeat logs are printed periodically and appended to `state/heartbeat.log`
- cron execution status is persisted in `state/cron-state.json`
- each task writes a session markdown file
- each task appends one line to daily memory file
- human-auth relay requests are persisted in `state/human-auth-relay/requests.json`
- uploaded auth artifacts are stored in `state/human-auth-artifacts/`

## Safe Stop

- use `/stop` in Telegram to request cancellation
- runtime checks stop flag between steps and finalizes session as failed with stop reason
- for blocked auth requests, use `/auth pending` and resolve with `/auth approve|reject`

## Data Retention

- screenshots: bounded by `screenshots.maxCount`
- sessions/memory/scripts: retained until manually cleaned

## Model Switch

Use Telegram `/model <name>` or edit `defaultModel` in config.

When changing model, verify:

- profile exists in `models`
- API key or env var is valid
- model supports required capabilities for your task

## Script Safety

- keep allowlist narrow in production
- disable script executor globally when not needed (`scriptExecutor.enabled=false`)
- inspect run artifacts under `workspace/scripts/runs` regularly
