/**
 * test-tiers.ts — live diagnostic of every source tier. No sheet writes, no alerts.
 * Exit 0 if AT LEAST ONE tier yields valid fresh data (the cascade's real success
 * condition). Per-tier results printed for diagnostics.
 * Usage: npx ts-node test-tiers.ts
 */
import "dotenv/config";
import { validate } from "./lib/validate";
import { fetchAAIIHttp } from "./sources/aaii-http";
import { scrapeAAII } from "./sentiment-scraper";
import { fetchSubstack } from "./sources/aaii-substack";
import { fetchYCharts } from "./sources/ycharts";

async function main() {
  const tiers = [
    ["Tier 0 aaii-http", fetchAAIIHttp],
    ["Tier 1 playwright", scrapeAAII],
    ["Tier 2 substack", fetchSubstack],
    ["Tier 3 ycharts", fetchYCharts],
  ] as const;
  let passed = 0;
  for (const [name, fn] of tiers) {
    try {
      const row = await fn();
      const v = row ? validate(row) : { ok: false, reason: "returned null" };
      if (row && v.ok) { passed++; console.log(`✓ ${name}: ${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish} [${row.source}]`); }
      else console.log(`✗ ${name}: ${v.reason}`);
    } catch (e: any) {
      console.log(`✗ ${name}: threw ${e.message}`);
    }
  }
  console.log(`\n${passed}/4 tiers passing`);
  if (passed === 0) { console.log("✗ FAIL: cascade would fail — every tier is down"); process.exit(1); }
  console.log("✓ SUCCESS: cascade viable");
}
main().catch(e => { console.error(e); process.exit(1); });
