/**
 * test-layers.ts
 * Runs the Playwright-based scraper and reports pass/fail.
 * Does NOT write to Google Sheets.
 *
 * Usage:  npx ts-node test-layers.ts
 */
import "dotenv/config";
import { scrapeAAII } from "./sentiment-scraper";

type Result = { layer: string; ok: boolean; data?: any; error?: string };

function validate(row: any): { ok: boolean; reason?: string } {
  const sum = row.bullish + row.neutral + row.bearish;
  if (row.bullish < 0 || row.bullish > 100 || row.neutral < 0 || row.neutral > 100 || row.bearish < 0 || row.bearish > 100)
    return { ok: false, reason: "percentage out of range" };
  if (Math.abs(sum - 100) > 0.8)
    return { ok: false, reason: `sum ${sum.toFixed(2)} != 100` };
  return { ok: true };
}

async function main() {
  const results: Result[] = [];

  console.log("\n── AAII Sentiment Scraper (Playwright) ─────────────────────────");

  try {
    const row = await scrapeAAII();

    if (!row) {
      throw new Error("returned null");
    }

    const v = validate(row);
    if (!v.ok) {
      throw new Error(`validation failed: ${v.reason}`);
    }

    console.log("✓ PASS");
    console.log("  → reportedDate:", row.reportedDate);
    console.log("  → bullish:", row.bullish + "%");
    console.log("  → neutral:", row.neutral + "%");
    console.log("  → bearish:", row.bearish + "%");
    console.log("  → source:", row.source);

    results.push({ layer: "Scraper", ok: true, data: row });

  } catch (e: any) {
    console.log("✗ FAIL:", e.message);
    results.push({ layer: "Scraper", ok: false, error: e.message });
  }

  // ── Summary ──
  console.log("\n── Summary ─────────────────────────────────────────────────");
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const status = r.ok ? "PASS" : `FAIL — ${r.error}`;
    console.log(`  ${icon} ${r.layer}: ${status}`);
  }
  console.log("────────────────────────────────────────────────────────────");

  if (!results[0]?.ok) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
