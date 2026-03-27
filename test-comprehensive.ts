/**
 * test-comprehensive.ts
 * Comprehensive tests including failure scenarios.
 * 
 * Run with different modes:
 *   npx ts-node test-comprehensive.ts           # Normal (Layers 1-3 only)
 *   npx ts-node test-comprehensive.ts --force4  # Force Layer 4 to run (tests fallback)
 *   npx ts-node test-comprehensive.ts --layer4  # Test Layer 4 standalone
 */
import "dotenv/config";
import { chromium, Browser, Page } from "playwright";
import { layer1DOMTable, layer2TextRegex, layer3Alternative, layer4VisionLLM } from "./sentiment-scraper";

const AAII_URL = "https://www.aaii.com/sentimentsurvey/sent_results";

type Result = { name: string; ok: boolean; data?: any; error?: string };

function validate(row: any): { ok: boolean; reason?: string } {
    const sum = row.bullish + row.neutral + row.bearish;
    if (row.bullish < 0 || row.bullish > 100 || row.neutral < 0 || row.neutral > 100 || row.bearish < 0 || row.bearish > 100)
        return { ok: false, reason: "percentage out of range" };
    if (Math.abs(sum - 100) > 0.8)
        return { ok: false, reason: `sum ${sum.toFixed(2)} != 100` };
    return { ok: true };
}

// Mock page that simulates failed extraction for Layers 1-3
function createMockPageWithNoTable(): any {
    return {
        locator: () => ({
            count: async () => 0,
            all: async () => [],
            allTextContents: async () => [],
        }),
        textContent: async () => "",
        content: async () => "<html><body>No data here</body></html>",
        evaluate: async () => null,
        setViewportSize: async () => { },
        reload: async () => { },
        waitForTimeout: async () => { },
        goto: async () => { },
    };
}

// Mock page with valid data
function createMockPageWithValidData(): any {
    return {
        locator: () => ({
            count: async () => 1,
            all: async () => [{
                locator: () => ({
                    allTextContents: async () => ["Mar 25", "32.1%", "18.1%", "49.8%"],
                }),
            }],
            allTextContents: async () => ["Mar 25", "32.1%", "18.1%", "49.8%"],
        }),
        textContent: async () => "Mar 25 32.1% 18.1% 49.8%",
        content: async () => "<html><body>Mar 25 32.1% 18.1% 49.8%</body></html>",
        evaluate: async () => ({ date: "Mar 25", bullish: 32.1, neutral: 18.1, bearish: 49.8 }),
        setViewportSize: async () => { },
        reload: async () => { },
        waitForTimeout: async () => { },
        goto: async () => { },
    };
}

async function testLayer(name: string, fn: (page: any) => Promise<any>, page: any): Promise<Result> {
    console.log(`\n📋 Testing: ${name}`);
    try {
        const result = await fn(page);
        if (!result) {
            console.log(`   ❌ Returned null`);
            return { name, ok: false, error: "returned null" };
        }
        const v = validate(result);
        if (!v.ok) {
            console.log(`   ❌ Validation failed: ${v.reason}`);
            return { name, ok: false, error: v.reason };
        }
        console.log(`   ✅ PASS: ${result.reportedDate} ${result.bullish}/${result.neutral}/${result.bearish}`);
        return { name, ok: true, data: result };
    } catch (e: any) {
        console.log(`   ❌ Error: ${e.message}`);
        return { name, ok: false, error: e.message };
    }
}

async function runTests() {
    const args = process.argv.slice(2);
    const forceLayer4 = args.includes("--force4") || args.includes("--layer4");
    const testMode = args.includes("--layer4") ? "layer4-only" : "full";

    console.log("═══════════════════════════════════════════════════");
    console.log("   AAII Sentiment Scraper - Comprehensive Tests   ");
    console.log("═══════════════════════════════════════════════════");
    console.log(`\nMode: ${testMode}`);
    console.log(`Layer 4 forced: ${forceLayer4 ? "YES (tests fallback)" : "NO (tests normal flow)"}`);

    const results: Result[] = [];
    let browser: Browser | null = null;

    try {
        if (testMode === "layer4-only") {
            // Test Layer 4 in isolation with real page
            console.log("\n═══════════════════════════════════════════════════");
            console.log("   Mode: Layer 4 Standalone Test");
            console.log("═══════════════════════════════════════════════════");

            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            });
            const page = await context.newPage();
            await page.goto(AAII_URL, { waitUntil: "networkidle", timeout: 30000 });
            // Wait for table to be visible
            await page.waitForSelector("table", { timeout: 10000 });
            await page.waitForTimeout(3000);

            const result = await testLayer("Layer 4 (Vision LLM) - Standalone", layer4VisionLLM, page);
            results.push(result);

        } else if (forceLayer4) {
            // Test with mock page that has no data (forces Layer 4 fallback)
            console.log("\n═══════════════════════════════════════════════════");
            console.log("   Mode: Force Layer 4 Fallback Test");
            console.log("═══════════════════════════════════════════════════");
            console.log("\n⚠️  Using mock page (no data) to force Layer 4 fallback...\n");

            const mockPage = createMockPageWithNoTable();

            const r1 = await testLayer("Layer 1 (should fail - no table)", layer1DOMTable, mockPage);
            results.push(r1);

            const r2 = await testLayer("Layer 2 (should fail - no text)", layer2TextRegex, mockPage);
            results.push(r2);

            const r3 = await testLayer("Layer 3 (should fail - no data)", layer3Alternative, mockPage);
            results.push(r3);

            // Layer 4 should work even with mock page (takes screenshot)
            console.log("\n⚠️  Note: Layer 4 can't work with mock page (no real DOM).");
            console.log("   For full fallback test, use --layer4 mode with real AAII page.");

        } else {
            // Normal test with real AAII page
            console.log("\n═══════════════════════════════════════════════════");
            console.log("   Mode: Normal Flow Test (Layers 1-3, skip Layer 4)");
            console.log("═══════════════════════════════════════════════════");

            browser = await chromium.launch({
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox"]
            });
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            });
            const page = await context.newPage();

            console.log("\n🌐 Navigating to AAII...");
            await page.goto(AAII_URL, { waitUntil: "networkidle", timeout: 30000 });
            await page.waitForTimeout(3000);
            console.log("✅ Page loaded\n");

            // Test Layers 1-3
            const r1 = await testLayer("Layer 1 (DOM Table)", layer1DOMTable, page);
            results.push(r1);

            const r2 = await testLayer("Layer 2 (Text/Regex)", layer2TextRegex, page);
            results.push(r2);

            const r3 = await testLayer("Layer 3 (Alternative)", layer3Alternative, page);
            results.push(r3);

            // Skip Layer 4 in normal mode (costs money)
            console.log("\n───────────────────────────────────────────────────");
            console.log("⏭️  Layer 4 skipped (normal mode - saves API cost)");
            console.log("   Use --layer4 flag to test Layer 4");
        }

    } catch (e: any) {
        console.error(`\n❌ Test error: ${e.message}`);
    } finally {
        if (browser) await browser.close();
    }

    // Summary
    console.log("\n═══════════════════════════════════════════════════");
    console.log("                    SUMMARY");
    console.log("═══════════════════════════════════════════════════");

    const passed = results.filter(r => r.ok).length;
    for (const r of results) {
        const icon = r.ok ? "✅" : "❌";
        console.log(`  ${icon} ${r.name}: ${r.ok ? "PASS" : r.error}`);
    }

    console.log(`\n${passed}/${results.length} tests passed`);

    if (passed === results.length && results.length > 0) {
        console.log("\n🎉 ALL TESTS PASSED!");
        process.exit(0);
    } else {
        console.log("\n⚠️  SOME TESTS FAILED");
        process.exit(1);
    }
}

runTests().catch(e => {
    console.error("Unexpected error:", e);
    process.exit(1);
});
