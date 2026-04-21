# Tenant isolation

## Always pass `projectId`
Every MCP tool that accepts `projectId` must receive the correct id for the inbox you are processing.

## Thread ids
Thread document ids are `{projectId}__{gmailThreadId}`. Never attach emails from one `projectId` to another.

## Slack / Telegram + Trello
Approval posts must use the Slack channel or Telegram chat configured on the same `projectId`. Trello cards must be created with the same project's credentials.
