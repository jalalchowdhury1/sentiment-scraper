export type AlertLevel = "CRITICAL" | "INFO";

export function formatAlert(level: AlertLevel, message: string): string {
  return `${level === "CRITICAL" ? "🚨" : "ℹ️"} sentiment-scraper ${level}:\n${message}`;
}

/**
 * Send a Telegram alert. Silent no-op (returns false) when TELEGRAM_BOT_TOKEN /
 * TELEGRAM_CHAT_ID are unset — safe to call before secrets exist. Never throws.
 */
export async function alert(level: AlertLevel, message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const text = formatAlert(level, message);
  if (!token || !chatId) {
    console.log(`[telegram] secrets absent, skipping alert: ${text.replace(/\n/g, " | ")}`);
    return false;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) console.log(`[telegram] sendMessage HTTP ${res.status}`);
    return res.ok;
  } catch (e: any) {
    console.log(`[telegram] send failed (non-fatal): ${e.message}`);
    return false;
  }
}
