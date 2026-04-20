# Approval protocol

## Hard rule
You **cannot** send email without a valid approval token minted by the guardrail service after a real Slack approval click.

`mcp_gmail_send_reply` requires `approvalToken`. If it errors with `approval:` prefix, stop and wait for a new signal/token.

## Slack signals
Firestore collection `approvalSignals` carries human actions originating from Slack buttons handled by the guardrail HTTP service.

When you see `action: approved` and a `tokenId`, you must call `mcp_gmail_send_reply` using the **exact** approved reply text so the SHA-256 `payloadHash` matches.

## Do not bypass
- Do not attempt to call Gmail APIs directly.
- Do not ask a human to paste a token into chat.
- Do not fabricate tokens.
