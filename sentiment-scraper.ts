import "dotenv/config";
import { chromium, Browser, Page } from "playwright";
import { google } from "googleapis";
import fs from "node:fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

const AAII_URL = "https://www.aaii.com/sentimentsurvey/sent_results";

type SentRow = {
  reportedDate: string;
  bullish: number;
  neutral: number;
  bearish: number;
  source: string;
};

function pctToNum(txt: string): number {
  return parseFloat(txt.replace(/[%\s,]/g, ""));
}

function validate(row: SentRow): { ok: boolean; reason?: string } {
  const sum = row.bullish + row.neutral + row.bearish;
  if (row.bullish < 0 || row.bullish > 100 || row.neutral < 0 || row.neutral > 100 || row.bearish < 0 || row.bearish > 100)
    return { ok: false, reason: "percentage out of range" };
  if (Math.abs(sum - 100) > 0.8)
    return { ok: false, reason: `sum ${sum.toFixed(2)} != 100` };
  return { ok: true };
}

// ── Shared browser setup ───────────────────────────────────────────────────────
async function setupBrowser(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  return { browser, page };
}

// ── Layer 1: DOM Table Extraction ───────────────────────────────────────────
export async function layer1DOMTable(page: Page): Promise<SentRow | null> {
  console.log("  [Layer 1] DOM table extraction...");

  const tableCount = await page.locator("table").count();
  console.log(`  [Layer 1] Tables found: ${tableCount}`);

  if (tableCount > 0) {
    const rows = await page.locator("table tr").all();

    for (const row of rows) {
      const cells = await row.locator("td").allTextContents();
      if (cells.length >= 4) {
        const dateText = cells[0].trim();
        const bullishText = cells[1].trim();

        // Skip header, look for data rows with date pattern
        if (!/reported date/i.test(dateText) && /^[A-Z][a-z]{2}\s+\d{1,2}$/.test(dateText)) {
          const bullish = pctToNum(bullishText);
          const neutral = pctToNum(cells[2].trim());
          const bearish = pctToNum(cells[3].trim());

          if (!isNaN(bullish) && !isNaN(neutral) && !isNaN(bearish)) {
            const sum = bullish + neutral + bearish;
            if (Math.abs(sum - 100) <= 1) {
              console.log(`  [Layer 1] SUCCESS: ${dateText} ${bullish}/${neutral}/${bearish}`);
              return {
                reportedDate: dateText,
                bullish,
                neutral,
                bearish,
                source: "aaii-dom-table"
              };
            }
          }
        }
      }
    }
  }

  console.log("  [Layer 1] No valid data found in DOM table");
  return null;
}

// ── Layer 2: Text/Regex Pattern Search ──────────────────────────────────────
export async function layer2TextRegex(page: Page): Promise<SentRow | null> {
  console.log("  [Layer 2] Text/regex pattern search...");

  // Get all page text
  const allText = await page.textContent("body") || "";

  // Look for date pattern followed by three percentages
  const patterns = [
    // Pattern: "Mar 25 32.1% 18.1% 49.8%"
    /([A-Z][a-z]{2}\s+\d{1,2})\s+([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)/g,
    // Pattern with "Bullish" label
    /([A-Z][a-z]{2}\s+\d{1,2})\s+Bullish\s+([\d.]+%?)[^\d]*Neutral\s+([\d.]+%?)[^\d]*Bearish\s+([\d.]+%?)/gi,
    // Pattern in JSON-like format
    /"date"\s*:\s*"([A-Z][a-z]{2}\s+\d{1,2})"[^}]*"bullish"\s*:\s*([\d.]+)[^}]*"neutral"\s*:\s*([\d.]+)[^}]*"bearish"\s*:\s*([\d.]+)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(allText)) !== null) {
      const [_, date, bull, neut, bear] = match;
      const bullish = pctToNum(bull);
      const neutral = pctToNum(neut);
      const bearish = pctToNum(bear);
      const sum = bullish + neutral + bearish;

      console.log(`  [Layer 2] Found: ${date} ${bullish}/${neutral}/${bearish} (sum: ${sum.toFixed(1)})`);

      if (Math.abs(sum - 100) <= 1) {
        console.log(`  [Layer 2] SUCCESS`);
        return {
          reportedDate: date.trim(),
          bullish,
          neutral,
          bearish,
          source: "aaii-text-regex"
        };
      }
    }
  }

  // Try extracting from any element with data attributes
  const dataElements = await page.locator("[data-bullish], [data-bearish], [class*='sentiment']").all();
  for (const el of dataElements) {
    const text = await el.textContent();
    const match = /([A-Z][a-z]{2}\s+\d{1,2})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text || "");
    if (match) {
      const [_, date, bull, neut, bear] = match;
      const bullish = parseFloat(bull);
      const neutral = parseFloat(neut);
      const bearish = parseFloat(bear);
      const sum = bullish + neutral + bearish;

      if (Math.abs(sum - 100) <= 1) {
        console.log(`  [Layer 2] SUCCESS (data attr)`);
        return { reportedDate: date, bullish, neutral, bearish, source: "aaii-text-regex" };
      }
    }
  }

  console.log("  [Layer 2] No valid data found via text/regex");
  return null;
}

// ── Layer 3: Alternative Approaches ─────────────────────────────────────────
export async function layer3Alternative(page: Page): Promise<SentRow | null> {
  console.log("  [Layer 3] Alternative approaches...");

  // Method 3a: Try to get innerHTML for regex extraction
  console.log("  [Layer 3] Trying innerHTML regex...");
  try {
    const html = await page.content();
    const match = /([A-Z][a-z]{2}\s+\d{1,2})\s+([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)/.exec(html);
    if (match) {
      const [_, date, bull, neut, bear] = match;
      const bullish = pctToNum(bull);
      const neutral = pctToNum(neut);
      const bearish = pctToNum(bear);
      const sum = bullish + neutral + bearish;
      if (Math.abs(sum - 100) <= 1) {
        console.log(`  [Layer 3] SUCCESS (innerHTML)`);
        return { reportedDate: date, bullish, neutral, bearish, source: "aaii-innerhtml" };
      }
    }
  } catch { /* ignore */ }

  // Method 3b: Try JavaScript evaluation
  console.log("  [Layer 3] Trying JS evaluation...");
  try {
    const jsResult = await page.evaluate(() => {
      // Look for JSON data in script tags
      const scripts = document.querySelectorAll("script:not([src])");
      for (const script of scripts) {
        const content = script.textContent || "";
        if (content.includes("bullish") || content.includes("Bearish")) {
          const match = /"date"\s*:\s*"([^"]+)"[^}]*"bullish"\s*:\s*([\d.]+)[^}]*"neutral"\s*:\s*([\d.]+)[^}]*"bearish"\s*:\s*([\d.]+)/.exec(content);
          if (match) {
            return { date: match[1], bullish: parseFloat(match[2]), neutral: parseFloat(match[3]), bearish: parseFloat(match[4]) };
          }
        }
      }

      // Look for window variables
      const win = window as any;
      if (win.sentimentData) return win.sentimentData;
      if (win.aaiiData) return win.aaiiData;

      return null;
    });

    if (jsResult && typeof jsResult === "object") {
      const { date, bullish, neutral, bearish } = jsResult as any;
      if (date && bullish && neutral && bearish) {
        const sum = bullish + neutral + bearish;
        if (Math.abs(sum - 100) <= 1) {
          console.log(`  [Layer 3] SUCCESS (JS eval)`);
          return { reportedDate: date, bullish, neutral, bearish, source: "aaii-js-eval" };
        }
      }
    }
  } catch (e) {
    console.log(`  [Layer 3] JS eval failed: ${e}`);
  }

  // Method 3c: Try mobile viewport
  console.log("  [Layer 3] Trying mobile viewport...");
  try {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(2000);

    // Re-check tables with mobile view
    const mobileTableCount = await page.locator("table").count();
    if (mobileTableCount > 0) {
      const rows = await page.locator("table tr").all();
      for (const row of rows) {
        const cells = await row.locator("td").allTextContents();
        if (cells.length >= 4) {
          const dateText = cells[0].trim();
          if (!/reported date/i.test(dateText) && /^[A-Z][a-z]{2}\s+\d{1,2}$/.test(dateText)) {
            const bullish = pctToNum(cells[1].trim());
            const neutral = pctToNum(cells[2].trim());
            const bearish = pctToNum(cells[3].trim());
            if (Math.abs(bullish + neutral + bearish - 100) <= 1) {
              console.log(`  [Layer 3] SUCCESS (mobile)`);
              return { reportedDate: dateText, bullish, neutral, bearish, source: "aaii-mobile" };
            }
          }
        }
      }
    }
  } catch (e) {
    console.log(`  [Layer 3] Mobile failed: ${e}`);
  }

  // Method 3d: Reload and retry
  console.log("  [Layer 3] Reloading page...");
  try {
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(3000);

    // Try DOM table again after reload
    const rows = await page.locator("table tr").all();
    for (const row of rows) {
      const cells = await row.locator("td").allTextContents();
      if (cells.length >= 4) {
        const dateText = cells[0].trim();
        if (!/reported date/i.test(dateText) && /^[A-Z][a-z]{2}\s+\d{1,2}$/.test(dateText)) {
          const bullish = pctToNum(cells[1].trim());
          const neutral = pctToNum(cells[2].trim());
          const bearish = pctToNum(cells[3].trim());
          if (Math.abs(bullish + neutral + bearish - 100) <= 1) {
            console.log(`  [Layer 3] SUCCESS (reload)`);
            return { reportedDate: dateText, bullish, neutral, bearish, source: "aaii-reload" };
          }
        }
      }
    }
  } catch (e) {
    console.log(`  [Layer 3] Reload failed: ${e}`);
  }

  console.log("  [Layer 3] No valid data found via alternatives");
  return null;
}

// ── Layer 4: Vision LLM Extraction ──────────────────────────────────────────
export async function layer4VisionLLM(page: Page): Promise<SentRow | null> {
  console.log("  [Layer 4] Vision LLM extraction (Gemini Flash)...");

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.log("  [Layer 4] No GOOGLE_API_KEY found, skipping");
    return null;
  }

  try {
    // Take screenshot of the page
    console.log("  [Layer 4] Taking screenshot...");
    const screenshot = await page.screenshot({ fullPage: true });
    const base64Image = screenshot.toString("base64");

    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Send to LLM with vision
    console.log("  [Layer 4] Sending to Gemini Flash...");
    const result = await model.generateContent([
      `You are looking at an AAII Investor Sentiment Survey webpage. 

Look carefully at the table on the page. You should see:
- A column with "Reported Date" and dates like "Mar 25"
- Three columns showing percentages for "Bullish", "Neutral", and "Bearish"

Please extract the FIRST data row (most recent) and return it as JSON:
{"date": "Mar 25", "bullish": 32.1, "neutral": 18.1, "bearish": 49.8}

If you cannot find the sentiment data table, return: {"error": "no data found"}`,
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/png",
        },
      }
    ]);

    const response = result.response;
    const text = response.text().trim();
    console.log(`  [Layer 4] LLM response: ${text}`);

    // Parse the JSON response
    let data: any;
    try {
      // Try to extract JSON from the response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        data = JSON.parse(text);
      }
    } catch {
      console.log("  [Layer 4] Failed to parse LLM response as JSON");
      return null;
    }

    if (data.error || !data.date || !data.bullish || !data.neutral || !data.bearish) {
      console.log("  [Layer 4] LLM did not find valid data");
      return null;
    }

    const bullish = parseFloat(data.bullish);
    const neutral = parseFloat(data.neutral);
    const bearish = parseFloat(data.bearish);
    const sum = bullish + neutral + bearish;

    if (Math.abs(sum - 100) <= 1) {
      console.log(`  [Layer 4] SUCCESS: ${data.date} ${bullish}/${neutral}/${bearish}`);
      return {
        reportedDate: data.date,
        bullish,
        neutral,
        bearish,
        source: "aaii-vision-llm"
      };
    } else {
      console.log(`  [Layer 4] Validation failed: sum ${sum.toFixed(1)} != 100`);
      return null;
    }

  } catch (e: any) {
    console.log(`  [Layer 4] Error: ${e.message}`);
    return null;
  }
}

// ── Main scraping function (runs all 3 layers) ────────────────────────────────
export async function scrapeAAII(): Promise<SentRow | null> {
  let browser: Browser | null = null;

  try {
    console.log("Launching browser...");
    const { browser: b, page } = await setupBrowser();
    browser = b;

    console.log("Navigating to AAII...");
    await page.goto(AAII_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // ── Layer 1: DOM Table ──
    let result = await layer1DOMTable(page);
    if (result) return result;

    // ── Layer 2: Text/Regex ──
    result = await layer2TextRegex(page);
    if (result) return result;

    // ── Layer 3: Alternative ──
    result = await layer3Alternative(page);
    if (result) return result;

    // ── Layer 4: Vision LLM ──
    console.log("\n  ⚠️  Layers 1-3 failed, trying Vision LLM (Layer 4)...");
    result = await layer4VisionLLM(page);
    if (result) return result;

    // Save debug info
    try {
      await page.screenshot({ path: "aaii-fail.png", fullPage: true });
    } catch { /* ignore */ }
    try {
      await fs.writeFile("aaii-fail.html", await page.content());
    } catch { /* ignore */ }

    return null;

  } catch (error) {
    console.error("Error:", error);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// ── Write results to Google Sheets ────────────────────────────────────────────
async function writeToSheets(row: SentRow): Promise<void> {
  const SHEET_ID =
    process.env.SHEET_ID ?? "1zQQ2am1yhzTwY7nx8xPak4Q0WoNMwxWj7Ekr-fDEIF4";
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS!),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const delta = `${(row.bearish - row.bullish).toFixed(2)}%`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "A2:D2",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          row.reportedDate,
          `${row.bullish}%`,
          `${row.neutral}%`,
          `${row.bearish}%`,
        ],
      ],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "E2",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[delta]] },
  });
  console.log(
    `Wrote to sheet: ${row.reportedDate} | bull=${row.bullish}% | neu=${row.neutral}% | bear=${row.bearish}% | delta=${delta} | source=${row.source}`
  );
}

// ── Main workflow ─────────────────────────────────────────────────────────────
async function runWorkflow() {
  console.log("Starting AAII sentiment scraper...\n");

  const row = await scrapeAAII();

  if (row) {
    const v = validate(row);
    if (v.ok) {
      console.log("\nScraping succeeded:", row);
      await writeToSheets(row);
      return row;
    } else {
      console.error("Validation failed:", v.reason);
      throw new Error(`Validation failed: ${v.reason}`);
    }
  } else {
    throw new Error("Scraping failed - no data found");
  }
}

// Only run when invoked directly (not when imported by tests)
if (require.main === module) {
  runWorkflow()
    .then((data) =>
      console.log("\nWorkflow finished successfully. Extracted data:", data)
    )
    .catch((err) => {
      console.error("\nWorkflow execution failed:", err);
      process.exit(1);
    });
}
