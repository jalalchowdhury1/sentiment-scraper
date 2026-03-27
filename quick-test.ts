import { chromium } from "playwright";
import { layer1DOMTable, layer2TextRegex, layer3Alternative } from "./sentiment-scraper";

async function test() {
    console.log("\n=== LAYER FALLBACK TEST ===\n");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

    const tests = [
        { name: "No Table", html: "<html><body><div>Mar 25 32.1% 18.1% 49.8%</div></body></html>", expectRecover: true },
        { name: "Bad Sum", html: "<html><body><table><tr><td>Mar 25</td><td>32.1%</td><td>18.1%</td><td>30.0%</td></tr></table></body></html>", expectRecover: false },
        { name: "Valid", html: "<html><body><table><tr><td>Mar 25</td><td>32.1%</td><td>18.1%</td><td>49.8%</td></tr></table></body></html>", expectRecover: true },
    ];

    let passed = 0, failed = 0;
    for (const t of tests) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.setContent(t.html);

        const l1 = await layer1DOMTable(page);
        const l2 = await layer2TextRegex(page);
        const l3 = await layer3Alternative(page);
        const recovered = !!(l1 || l2 || l3);
        const ok = recovered === t.expectRecover;

        console.log(`${ok ? "✓" : "✗"} ${t.name}: L1=${!!l1} L2=${!!l2} L3=${!!l3} → ${recovered ? "RECOVERED" : "FAILED"}`);
        if (ok) passed++; else failed++;
        await ctx.close();
    }

    await browser.close();
    console.log(`\n📊 ${passed}/${passed + failed} passed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

test().catch(e => { console.error(e); process.exit(1); });
