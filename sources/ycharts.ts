import { SentRow } from "../lib/types";
import { CHROME_HEADERS } from "./aaii-http";

const PAGES = {
  bullish: "https://ycharts.com/indicators/us_investor_sentiment_bullish",
  neutral: "https://ycharts.com/indicators/us_investor_sentiment_neutral",
  bearish: "https://ycharts.com/indicators/us_investor_sentiment_bearish",
} as const;

export type YChartsStat = { value: number; weekOf: string };

/** The latest stat is server-rendered prose: "...is at 30.40%, compared to ... for Wk of Jun 10 2026". */
export function parseYChartsPage(html: string): YChartsStat | null {
  const v = /is at\s+([\d.]+)%/.exec(html);
  const w = /for Wk of ([A-Za-z]{3} \d{1,2} \d{4})/.exec(html);
  if (!v) return null;
  return { value: parseFloat(v[1]), weekOf: w ? w[1] : "" };
}

export function assembleYCharts(stats: { bullish: YChartsStat | null; neutral: YChartsStat | null; bearish: YChartsStat | null }, now: Date = new Date()): SentRow | null {
  const { bullish, neutral, bearish } = stats;
  if (!bullish || !neutral || !bearish) return null;
  const weeks = new Set([bullish.weekOf, neutral.weekOf, bearish.weekOf]);
  if (weeks.size !== 1) return null; // three pages must describe the same survey week
  if (Math.abs(bullish.value + neutral.value + bearish.value - 100) > 1) return null;
  // "Jun 10 2026" -> "Jun 10" (strip year + leading-zero days like "Jun 04")
  const m = /^([A-Za-z]{3}) 0?(\d{1,2}) \d{4}$/.exec(bullish.weekOf);
  if (!m) return null;
  return { reportedDate: `${m[1]} ${m[2]}`, bullish: bullish.value, neutral: neutral.value, bearish: bearish.value, source: "ycharts" };
}

/** Tier 3: emergency third-party backup. 3 sequential GETs. */
export async function fetchYCharts(now: Date = new Date()): Promise<SentRow | null> {
  console.log("  [Tier 3] YCharts...");
  const out: { bullish: YChartsStat | null; neutral: YChartsStat | null; bearish: YChartsStat | null } = { bullish: null, neutral: null, bearish: null };
  for (const [key, url] of Object.entries(PAGES) as [keyof typeof PAGES, string][]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const res = await fetch(url, { headers: CHROME_HEADERS, signal: ctrl.signal, redirect: "follow" });
      clearTimeout(timer);
      if (!res.ok) { console.log(`  [Tier 3] ${key} -> HTTP ${res.status}`); continue; }
      out[key] = parseYChartsPage(await res.text());
    } catch (e: any) { console.log(`  [Tier 3] ${key} failed: ${e.message}`); }
  }
  const row = assembleYCharts(out, now);
  console.log(row ? `  [Tier 3] SUCCESS: ${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish}` : "  [Tier 3] no consistent data");
  return row;
}
