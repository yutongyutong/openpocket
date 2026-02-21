# Prompting and Decision Model

This page explains how OpenPocket constructs prompts and routes user messages.

## System Prompt

`buildSystemPrompt(skillsSummary)` generates an instruction block with:

- strict JSON-only output requirement
- allowed `action.type` list
- explicit `request_human_auth` policy for real-device authorization checkpoints
- safety and execution rules
- English-only output text rule (`thought` and action text fields)
- loaded skill summary text

Prompt templates are documented in [Prompt Templates](../reference/prompt-templates.md).

## User Prompt

Per step, `buildUserPrompt(task, step, snapshot, history)` includes:

- task text
- step number
- structured screen metadata (`currentApp`, `width`, `height`, `deviceId`, `capturedAt`)
- recent execution history (last 8 lines)
- explicit instruction to return one JSON object

The screenshot image itself is attached in model request payload as base64 PNG.

## Output Contract

Expected output shape:

```json
{"thought":"...","action":{"type":"..."}}
```

If model output is invalid JSON or has unknown action type, runtime normalizes to safe fallback `wait` action.

## Telegram Routing

`ChatAssistant.decide(chatId, inputText)` uses:

1. heuristic classifier (high-confidence greetings and obvious task keywords)
2. model-based classifier fallback
3. final fallback strategy if model classification fails

When routed to task mode, message is passed to `AgentRuntime.runTask`.
When routed to chat mode, response is generated conversationally.

For task mode with auth checkpoints:

- agent can emit `request_human_auth`
- gateway opens one-time web approval link (when relay is configured)
- Telegram `/auth approve|reject` remains available as manual fallback

## Memory Window

Chat assistant stores in-memory turn history per chat ID:

- keep max 20 turns
- include up to last 12 turns in next prompt

`/clear` removes memory for the current chat.
