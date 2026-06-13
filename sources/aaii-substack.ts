import { SentRow } from "../lib/types";
import { CHROME_HEADERS } from "./aaii-http";

const BASE = "https://insights.aaii.com";
const MONTH_LONG: Record<string, string> = { january: "Jan", february: "Feb", march: "Mar", april: "Apr", may: "May", june: "Jun", july: "Jul", august: "Aug", september: "Sep", october: "Oct", november: "Nov", december: "Dec" };

async function get(url: string, accept: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(url, { headers: { ...CHROME_HEADERS, Accept: accept }, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) { console.log(`  [Tier 2] ${url} -> HTTP ${res.status}`); return null; }
    return await res.text();
  } catch (e: any) {
    console.log(`  [Tier 2] ${url} failed: ${e.message}`);
    return null;
  }
}

/** Extract bull/neutral/bear from AAII's weekly boilerplate prose. postDateISO is the
 *  Substack publish date (Thursday); survey "week ending" date is preferred if present.
 *  The label->number regex uses a negative lookahead so a summary sentence that mentions
 *  a label without a number (e.g. "...neutral sentiment increased.") cannot steal the
 *  next label's percentage — each label binds to its own sentence. */
export function parseSubstackBody(bodyHtml: string, postDateISO: string, now: Date = new Date()): SentRow | null {
  const text = bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const grab = (label: string): number => {
    const m = new RegExp(`${label} sentiment(?:(?!sentiment)[^%]){0,260}?(?:to|at)\\s+([\\d.]+)%`, "i").exec(text);
    return m ? parseFloat(m[1]) : NaN;
  };
  const bullish = grab("Bullish"), neutral = grab("Neutral"), bearish = grab("Bearish");
  if ([bullish, neutral, bearish].some(isNaN)) return null;
  if (Math.abs(bullish + neutral + bearish - 100) > 1) return null;
  // Survey date: prefer explicit "week ending <Month D>" in the prose; fall back to publish date - 1 day (post is Thu, table labels Wed).
  let reportedDate: string;
  const we = /week ending ([A-Za-z]+) (\d{1,2})/i.exec(text);
  if (we && MONTH_LONG[we[1].toLowerCase()]) {
    reportedDate = `${MONTH_LONG[we[1].toLowerCase()]} ${+we[2]}`;
  } else {
    const d = new Date(new Date(postDateISO).getTime() - 86400_000);
    reportedDate = `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  return { reportedDate, bullish, neutral, bearish, source: "aaii-substack" };
}

type ArchivePost = { title?: string; slug?: string; post_date?: string; canonical_url?: string };

/** Tier 2: AAII's first-party Substack. JSON API -> RSS, first hit wins. limit=30
 *  because AAII posts several non-sentiment articles between weekly surveys (probe
 *  confirmed the sentiment post is not always within the newest dozen). */
export async function fetchSubstack(now: Date = new Date()): Promise<SentRow | null> {
  console.log("  [Tier 2] AAII Substack...");
  // 2a: archive JSON API -> post JSON API
  const archiveRaw = await get(`${BASE}/api/v1/archive?sort=new&limit=30`, "application/json");
  if (archiveRaw) {
    try {
      const posts = JSON.parse(archiveRaw) as ArchivePost[];
      const post = posts.find(p => /sentiment[- ]survey/i.test(`${p.title ?? ""} ${p.slug ?? ""}`));
      if (post?.slug) {
        const postRaw = await get(`${BASE}/api/v1/posts/${post.slug}`, "application/json");
        if (postRaw) {
          const bodyHtml = (JSON.parse(postRaw) as { body_html?: string }).body_html ?? "";
          const row = parseSubstackBody(bodyHtml, post.post_date ?? new Date(now).toISOString(), now);
          if (row) { row.source = "aaii-substack-api"; console.log(`  [Tier 2] SUCCESS (api): ${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish}`); return row; }
        }
      }
    } catch (e: any) { console.log(`  [Tier 2] archive parse failed: ${e.message}`); }
  }
  // 2b: RSS feed
  const rss = await get(`${BASE}/feed`, "application/rss+xml, application/xml");
  if (rss) {
    const items = rss.split(/<item>/i).slice(1);
    for (const item of items) {
      const title = (/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(item)?.[1] ?? "");
      if (!/sentiment[- ]survey/i.test(title) && !/bullish|bearish/i.test(item)) continue;
      const content = /<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i.exec(item)?.[1] ?? item;
      const pub = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(item)?.[1];
      const row = parseSubstackBody(content, pub ? new Date(pub).toISOString() : new Date(now).toISOString(), now);
      if (row) { row.source = "aaii-substack-rss"; console.log(`  [Tier 2] SUCCESS (rss): ${row.reportedDate}`); return row; }
    }
  }
  console.log("  [Tier 2] no data via api/rss");
  return null;
}
