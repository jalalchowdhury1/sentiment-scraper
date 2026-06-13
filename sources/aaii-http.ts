import { SentRow } from "../lib/types";
import { parseSurveyDate, daysOld, MAX_AGE_DAYS } from "../lib/validate";

const URL = "https://www.aaii.com/sentimentsurvey/sent_results";
export const CHROME_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Parse the server-rendered sent_results table. Strict cell-regex first, then a
 *  tag-stripped loose pass (sum-validated) so attribute reshuffles don't kill us. */
export function parseAAIIHtml(html: string, now: Date = new Date()): SentRow | null {
  const strict = /<td[^>]*class="tableTxt"[^>]*>([A-Z][a-z]{2}\s+\d{1,2})<\/td>\s*<td[^>]*class="tableTxt"[^>]*>([\d.]+)%\s*<\/td>\s*<td[^>]*class="tableTxt"[^>]*>([\d.]+)%\s*<\/td>\s*<td[^>]*class="tableTxt"[^>]*>([\d.]+)%\s*<\/td>/;
  const candidates: RegExpExecArray[] = [];
  const sMatch = strict.exec(html);
  if (sMatch) candidates.push(sMatch);
  if (!candidates.length) {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const loose = /([A-Z][a-z]{2}\s+\d{1,2})\s+([\d.]+)%?\s+([\d.]+)%?\s+([\d.]+)%?/g;
    let m: RegExpExecArray | null;
    while ((m = loose.exec(text)) !== null) candidates.push(m);
  }
  for (const m of candidates) {
    const [, date, b, n, r] = m;
    const bullish = parseFloat(b), neutral = parseFloat(n), bearish = parseFloat(r);
    if ([bullish, neutral, bearish].some(isNaN)) continue;
    if (Math.abs(bullish + neutral + bearish - 100) > 1) continue;
    const d = parseSurveyDate(date, now);
    if (!d || daysOld(d, now) > MAX_AGE_DAYS) continue; // first FRESH valid row wins
    return { reportedDate: date.replace(/\s+/g, " ").trim(), bullish, neutral, bearish, source: "aaii-http" };
  }
  return null;
}

/** Tier 0: plain HTTPS GET — no browser. Returns null on any failure (logged). */
export async function fetchAAIIHttp(now: Date = new Date()): Promise<SentRow | null> {
  console.log("  [Tier 0] aaii.com plain HTTP...");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(URL, { headers: CHROME_HEADERS, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) { console.log(`  [Tier 0] HTTP ${res.status}`); return null; }
    const row = parseAAIIHtml(await res.text(), now);
    console.log(row ? `  [Tier 0] SUCCESS: ${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish}` : "  [Tier 0] no parseable fresh row");
    return row;
  } catch (e: any) {
    console.log(`  [Tier 0] failed: ${e.message}`);
    return null;
  }
}
