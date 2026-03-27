/**
 * test-layers.ts
 * Runs all 3 extraction layers independently and reports pass/fail.
 * Does NOT write to Google Sheets.
 *
 * Usage:  npx ts-node test-layers.ts
 */
import "dotenv/config";
import { Stagehand, type ConstructorParams } from "@browserbasehq/stagehand";
import { layer1Direct, layer2Screenshot, layer3Browser } from "./sentiment-scraper";

const AAII_URL = "https://www.aaii.com/sentimentsurvey/sent_results";

type Result = { layer: string; ok: boolean; data?: any; error?: string };

function validate(row: any): { ok: boolean; reason?: string } {
  const sum = row.bullish + row.neutral + row.bearish;
  if (row.bullish < 0 || row.bullish > 100 || row.neutral < 0 || row.neutral > 100 || row.bearish < 0 || row.bearish > 100)
    return { ok: false, reason: "percentage out of range" };
  if (Math.abs(sum - 100) > 0.8)
    return { ok: false, reason: `sum ${sum.toFixed(2)} != 100` };
  return { ok: true };
}

async function run(label: string, fn: () => Promise<any>, results: Result[]) {
  process.stdout.write(`[${label}] `);
  try {
    const row = await fn();
    if (!row) throw new Error("returned null");
    const v = validate(row);
    if (!v.ok) throw new Error(`validation failed: ${v.reason}`);
    results.push({ layer: label, ok: true, data: row });
    console.log("✓ PASS");
    console.log("  →", row);
  } catch (e) {
    results.push({ layer: label, ok: false, error: String(e) });
    console.log("✗ FAIL:", e);
  }
}

async function main() {
  const results: Result[] = [];

  // ── Layer 1 (no browser) ──
  console.log("\n── Layer 1: Direct HTTP + cheerio ─────────────────────────");
  await run("Layer 1 (direct HTTP)", () => layer1Direct(), results);

  // ── Layers 2 + 3 (share one browser session) ──
  console.log("\n── Layers 2+3: Browser-based ───────────────────────────────");

  if (!process.env.BROWSERBASE_API_KEY) {
    console.log("⚠ BROWSERBASE_API_KEY not set — skipping browser layers (CI only)");
    results.push({ layer: "Layer 2 (screenshot→LLM)", ok: false, error: "BROWSERBASE_API_KEY not set" });
    results.push({ layer: "Layer 3 (DOM+regex)", ok: false, error: "BROWSERBASE_API_KEY not set" });
  } else {
    let stagehand: Stagehand | null = null;
    try {
      stagehand = new Stagehand({
        env: "BROWSERBASE",
        verbose: 0,
        modelName: "google/gemini-2.5-flash-preview-05-20",
        modelClientOptions: { apiKey: process.env.GOOGLE_API_KEY },
      } as ConstructorParams);
      await stagehand.init();
      console.log("Stagehand initialized.\n");

      const page = stagehand.page!;
      await page.goto(AAII_URL, { waitUntil: "load" });
      await new Promise((r) => setTimeout(r, 3000));

      await run("Layer 2 (screenshot→LLM)", () => layer2Screenshot(page), results);
      await run("Layer 3 (DOM+regex)", () => layer3Browser(page), results);
    } catch (e) {
      console.error("Browser init failed:", e);
      results.push({ layer: "Layers 2+3 (browser)", ok: false, error: String(e) });
    } finally {
      if (stagehand) await stagehand.close();
    }
  }

  // ── Summary ──
  console.log("\n── Summary ─────────────────────────────────────────────────");
  const skippedMsg = "BROWSERBASE_API_KEY not set";
  let anyRealFailure = false;
  for (const r of results) {
    const skipped = !r.ok && r.error === skippedMsg;
    const icon = r.ok ? "✓" : skipped ? "⚠" : "✗";
    const status = r.ok ? "PASS" : skipped ? "SKIPPED (no credentials)" : `FAIL — ${r.error}`;
    console.log(`  ${icon} ${r.layer}: ${status}`);
    if (!r.ok && !skipped) anyRealFailure = true;
  }
  console.log("────────────────────────────────────────────────────────────");
  if (anyRealFailure) process.exit(1);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
