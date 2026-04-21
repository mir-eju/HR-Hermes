# Approval protocol

## Hard rule
You **cannot** send email without a valid approval token minted by the guardrail service after a real human approval (**Slack** button or **Telegram** inline button).

`mcp_gmail_send_reply` requires `approvalToken`. If it errors with `approval:` prefix, stop and wait for a new signal/token.

## Signals
Firestore collection `approvalSignals` carries human actions from the guardrail HTTP service (Slack interactivity and/or Telegram webhooks).

When you see `action: approved` and a `tokenId`, you must call `mcp_gmail_send_reply` using the **exact** approved reply text so the SHA-256 `payloadHash` matches.

## Do not bypass
- Do not attempt to call Gmail APIs directly.
- Do not ask a human to paste a token into chat.
- Do not fabricate tokens.
