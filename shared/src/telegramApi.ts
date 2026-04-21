/** Call Telegram Bot API (JSON POST). */
export async function telegramApi(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok?: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(json.description || `Telegram HTTP ${res.status}`);
  return json.result;
}
