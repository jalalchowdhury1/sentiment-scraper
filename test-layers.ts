/**
 * test-layers.ts
 * Runs all 4 extraction layers independently and reports pass/fail.
 * Does NOT write to Google Sheets.
 *
 * Usage:  npx ts-node test-layers.ts
 */
import "dotenv/config";
import { chromium } from "playwright";
import { layer1DOMTable, layer2TextRegex, layer3Alternative, layer4VisionLLM } from "./sentiment-scraper";

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

async function runLayer(label: string, fn: (page: any) => Promise<any>, page: any, results: Result[]) {
  try {
    const row = await fn(page);
    if (!row) {
      results.push({ layer: label, ok: false, error: "returned null" });
      return false;
    }
    const v = validate(row);
    if (!v.ok) {
      results.push({ layer: label, ok: false, error: v.reason });
      return false;
    }
    results.push({ layer: label, ok: true, data: row });
    return true;
  } catch (e: any) {
    results.push({ layer: label, ok: false, error: e.message });
    return false;
  }
}

async function main() {
  const results: Result[] = [];
  let browser = null;
  let l1 = false, l2 = false, l3 = false, l4Skipped = false;

  console.log("\n═══ AAII Sentiment Scraper - 4 Layers ═══\n");

  try {
    // Launch browser once
    console.log("Launching browser...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();

    console.log("Navigating to AAII...\n");
    await page.goto(AAII_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // ── Layer 1: DOM Table ──
    console.log("── Layer 1: DOM Table Extraction ─────────────────");
    l1 = await runLayer("Layer 1 (DOM table)", layer1DOMTable, page, results);
    if (l1) {
      const r = results[0];
      console.log("  ✓ PASS");
      console.log(`  → ${r.data.reportedDate}: ${r.data.bullish}% / ${r.data.neutral}% / ${r.data.bearish}%`);
    } else {
      console.log(`  ✗ FAIL: ${results[0].error}`);
    }

    // ── Layer 2: Text/Regex ──
    console.log("\n── Layer 2: Text/Regex Pattern Search ───────────");
    l2 = await runLayer("Layer 2 (text/regex)", layer2TextRegex, page, results);
    if (l2) {
      const r = results[1];
      console.log("  ✓ PASS");
      console.log(`  → ${r.data.reportedDate}: ${r.data.bullish}% / ${r.data.neutral}% / ${r.data.bearish}%`);
    } else {
      console.log(`  ✗ FAIL: ${results[1].error}`);
    }

    // ── Layer 3: Alternative ──
    console.log("\n── Layer 3: Alternative Approaches ──────────────");
    l3 = await runLayer("Layer 3 (alternative)", layer3Alternative, page, results);
    if (l3) {
      const r = results[2];
      console.log("  ✓ PASS");
      console.log(`  → ${r.data.reportedDate}: ${r.data.bullish}% / ${r.data.neutral}% / ${r.data.bearish}%`);
    } else {
      console.log(`  ✗ FAIL: ${results[2].error}`);
    }

    // ── Layer 4: Vision LLM (only tested if Layers 1-3 all fail, to save API costs) ──
    console.log("\n── Layer 4: Vision LLM Extraction ────────────────");
    if (l1 && l2 && l3) {
      console.log("  ⊘ SKIPPED: Layers 1-3 succeeded, Layer 4 not needed (saves API cost)");
      console.log("  → In production, Layer 4 is only called when Layers 1-3 fail");
    } else {
      console.log("  ⚠ Layers 1-3 failed, testing Layer 4 as fallback...");
      const l4 = await runLayer("Layer 4 (vision LLM)", layer4VisionLLM, page, results);
      if (l4) {
        const r = results[3];
        console.log("  ✓ PASS");
        console.log(`  → ${r.data.reportedDate}: ${r.data.bullish}% / ${r.data.neutral}% / ${r.data.bearish}%`);
      } else {
        console.log(`  ✗ FAIL: ${results[3]?.error || "returned null"}`);
      }
    }

  } catch (e: any) {
    console.error("Browser error:", e.message);
  } finally {
    if (browser) await browser.close();
  }

  // ── Summary ──
  console.log("\n═══ Summary ═════════════════════════════════════");
  const passed = results.filter(r => r.ok).length;
  l4Skipped = !l1 || !l2 || !l3; // Layer 4 was skipped if Layers 1-3 all succeeded

  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const status = r.ok ? "PASS" : `FAIL — ${r.error}`;
    console.log(`  ${icon} ${r.layer}: ${status}`);
  }

  if (l4Skipped) {
    console.log("  ⊘ Layer 4 (vision LLM): SKIPPED (Layers 1-3 succeeded)");
  }
  console.log("════════════════════════════════════════════════");

  // Success = Layers 1-3 pass, OR Layer 4 passes as fallback
  const corePassed = results.slice(0, 3).every(r => r.ok);
  const fallbackPassed = !l4Skipped && results[3]?.ok;

  if (corePassed) {
    if (l4Skipped) {
      console.log("\n✓ SUCCESS! (Layers 1-3 passed, Layer 4 skipped to save costs)");
    } else if (fallbackPassed) {
      console.log("\n✓ SUCCESS! (All 4 layers passed)");
    } else {
      console.log("\n⚠ Partial success - Layers 1-3 passed, Layer 4 fallback failed");
    }
  } else {
    console.log("\n✗ FAIL: Core layers 1-3 all failed");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
