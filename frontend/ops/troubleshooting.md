# Troubleshooting

## `adb not found`

- install Android platform-tools
- set `ANDROID_SDK_ROOT`
- verify `adb` in `PATH`

## `Android emulator binary not found`

- install Android Emulator via SDK manager
- configure `emulator.androidSdkRoot` or `ANDROID_SDK_ROOT`

## `No AVD found`

- run `node dist/cli.js emulator list-avds`
- create an AVD if list is empty
- set `emulator.avdName` to a valid entry

## `Missing API key for model`

- set `models.<profile>.apiKey` or matching env var (`apiKeyEnv`)
- verify current `defaultModel` profile

## Task keeps failing with invalid model output

- inspect session file for raw thought/action progression
- verify model supports requested endpoint and multimodal input
- switch model profile and retry

## Telegram bot does not respond

- validate token (`telegram.botToken` or env)
- check allowed chat IDs (`telegram.allowedChatIds`)
- ensure gateway process is running

## Human-auth link is missing in Telegram

- ensure `humanAuth.enabled=true`
- ensure gateway started with `humanAuth.useLocalRelay=true`
- check gateway logs for local relay startup failure
- use `/auth pending` to verify request creation even when web link fallback is unavailable

## ngrok tunnel does not come up

- verify `humanAuth.tunnel.provider=ngrok` and `humanAuth.tunnel.ngrok.enabled=true`
- verify `NGROK_AUTHTOKEN` (or `humanAuth.tunnel.ngrok.authtoken`) is set
- confirm `ngrok` executable exists in PATH or set `humanAuth.tunnel.ngrok.executable`
- inspect gateway logs for `[human-auth][ngrok]` startup errors

## Human-auth request always times out

- check phone can reach `humanAuth.publicBaseUrl`
- if LAN mode, verify host/port reachability from phone network
- if ngrok mode, verify tunnel URL is active and not blocked
- increase `humanAuth.requestTimeoutSec` when approvals need more time

## Scripts blocked unexpectedly

- inspect `result.json` and `stderr.log` in run directory
- confirm command is in `scriptExecutor.allowedCommands`
- check deny patterns (for example `sudo`, `shutdown`, `rm -rf /`)
