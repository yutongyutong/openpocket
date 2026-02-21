# Filesystem Layout

OpenPocket runtime uses `OPENPOCKET_HOME` (default `~/.openpocket`).

## Runtime Tree

```text
~/.openpocket/
  config.json
  state/
    emulator.log
    heartbeat.log
    cron-state.json
    control-panel.json
    onboarding.json
    human-auth-relay/
      requests.json
    human-auth-artifacts/
      auth-*.png|jpg|json|bin
    screenshots/
      *.png
  workspace/
    AGENTS.md
    SOUL.md
    USER.md
    IDENTITY.md
    TOOLS.md
    HEARTBEAT.md
    MEMORY.md
    memory/
      README.md
      YYYY-MM-DD.md
    sessions/
      session-*.md
    skills/
      README.md
      *.md
      auto/
        *.md
    scripts/
      README.md
      auto/
        *.sh
      runs/
        run-*/
          script.sh
          stdout.log
          stderr.log
          result.json
    cron/
      README.md
      jobs.json
```

## Repo Layout

```text
src/
  agent/       # prompts, model client, runtime loop
  config/      # default config, load/save/normalize
  device/      # emulator and adb runtime
  gateway/     # telegram gateway, heartbeat, cron, and run-loop
  human-auth/  # relay bridge, web relay server, local stack, ngrok tunnel
  memory/      # session, memory, screenshot storage
  skills/      # skill loader and auto artifact builder
  tools/       # script executor
  utils/       # paths and timing helpers
  cli.ts       # command entrypoint
```

## Skill Sources

At runtime, skills are loaded from:

1. `workspace/skills`
2. `OPENPOCKET_HOME/skills`
3. `<repo>/skills`
