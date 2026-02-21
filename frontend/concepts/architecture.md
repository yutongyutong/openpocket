# Architecture

OpenPocket is a local-first phone-use runtime centered on a local Android emulator.

## Topology

```text
User (CLI / Telegram / Panel)
           |
           v
Gateway / Command Router
           |
           v
AgentRuntime + HeartbeatRunner + CronService + HumanAuthBridge
   |          |          |            |              |
   v          v          v            v              v
ModelClient AdbRuntime SkillLoader ScriptExecutor LocalHumanAuthStack
    |          |                                       |
    v          v                                       v
 LLM APIs   Android Emulator (local adb target)   HumanAuthRelay + Optional ngrok tunnel
```

## Why Local Emulator

- automation does not consume runtime resources on the user’s main phone
- execution remains local instead of running on a hosted cloud phone service
- task artifacts and permissions stay under local control

## Control Modes

OpenPocket supports two complementary control paths on the same runtime:

- **Human direct control**: users can directly operate the local emulator.
- **Agent control**: agent actions operate the local emulator via `adb`.

This makes human-agent handoff practical for real app workflows.

For authorization checkpoints, gateway also supports a third interaction surface:

- **Remote auth handoff**: one-time web link approval (plus Telegram fallback commands) when `request_human_auth` is emitted.

## Components

- `AgentRuntime`: orchestrates task loop, step execution, and session/memory persistence.
- `ModelClient`: builds multimodal prompts, calls model endpoints, parses normalized actions.
- `AdbRuntime`: captures snapshots and executes mobile actions (`tap`, `swipe`, `type`, etc.).
- `EmulatorManager`: manages emulator lifecycle (`start`, `stop`, `status`, `screenshot`).
- `WorkspaceStore`: writes auditable session and daily memory files.
- `SkillLoader`: loads markdown skills from workspace/local/bundled sources.
- `ScriptExecutor`: validates and executes `run_script` with allowlist and safety controls.
- `TelegramGateway`: routes chat/task commands and sends progress.
- `HeartbeatRunner`: emits liveness snapshots and stuck-task warnings.
- `CronService`: triggers scheduled tasks from `workspace/cron/jobs.json`.
- `runGatewayLoop`: robust long-running gateway loop with graceful restart/stop behavior.
- `HumanAuthBridge`: blocks task flow on `request_human_auth` and waits for human approval.
- `HumanAuthRelayServer`: serves one-time approval web links and polling APIs for unblock flows.
- `LocalHumanAuthStack`: auto-starts local relay (and optional ngrok tunnel) when gateway boots.

## Task Flow

1. Create a session markdown file.
2. Resolve model profile and credentials.
3. For each step:
   - capture emulator snapshot
   - optionally persist screenshot
   - request next action from model
   - execute action via `adb` or script runner
   - append step history to session
   - emit progress callback when configured
4. Stop on `finish`, step cap, error, or explicit user stop.
5. Finalize session and append one daily memory entry.
6. Optionally return emulator to home screen.

## Model Fallback

OpenPocket attempts provider endpoints in fallback order:

- task loop (`ModelClient`): `chat` -> `responses` -> `completions`
- chat assistant (`ChatAssistant`): `responses` -> `chat` -> `completions`

This keeps runtime compatibility across providers with partial endpoint support.

## Persistence

- runtime state is stored under `OPENPOCKET_HOME`
- task execution is auditable through session/memory/script artifacts
- screenshot storage uses configured retention limits

## Near-Term Extensions

Planned next step:

- richer remote phone controls beyond auth approvals (pause/resume/retry/session-level controls)
