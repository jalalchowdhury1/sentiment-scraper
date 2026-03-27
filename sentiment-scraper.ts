import "dotenv/config";
import { chromium, Browser, Page } from "playwright";
import { google } from "googleapis";
import fs from "node:fs/promises";

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

// ── Main scraping function using Playwright ───────────────────────────────────
export async function scrapeAAII(): Promise<SentRow | null> {
  let browser: Browser | null = null;

  try {
    console.log("Launching browser...");
    browser = await chromium.launch({
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

    const page: Page = await context.newPage();

    console.log("Navigating to AAII...");
    await page.goto(AAII_URL, { waitUntil: "networkidle", timeout: 30000 });

    // Wait for page to fully load
    await page.waitForTimeout(3000);

    // Method 1: Find table directly
    const tableCount = await page.locator("table").count();
    console.log("Tables found:", tableCount);

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
                console.log("SUCCESS! Found data:", { dateText, bullish, neutral, bearish, sum });
                return {
                  reportedDate: dateText,
                  bullish,
                  neutral,
                  bearish,
                  source: "aaii-playwright"
                };
              }
            }
          }
        }
      }
    }

    // Method 2: Search in page text
    console.log("Searching in page text...");
    const allText = await page.textContent("body");
    const datePattern = /([A-Z][a-z]{2}\s+\d{1,2})\s+([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)/g;
    let match;

    while ((match = datePattern.exec(allText || "")) !== null) {
      const [_, date, bull, neut, bear] = match;
      const bullish = pctToNum(bull);
      const neutral = pctToNum(neut);
      const bearish = pctToNum(bear);
      const sum = bullish + neutral + bearish;

      if (Math.abs(sum - 100) <= 1) {
        console.log("SUCCESS (text search):", { date, bullish, neutral, bearish, sum });
        return {
          reportedDate: date,
          bullish,
          neutral,
          bearish,
          source: "aaii-playwright"
        };
      }
    }

    // Method 3: Retry with reload
    console.log("Retrying...");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(5000);

    // Try table again
    const rowsRetry = await page.locator("table tr").all();
    for (const row of rowsRetry) {
      const cells = await row.locator("td").allTextContents();
      if (cells.length >= 4) {
        const dateText = cells[0].trim();
        if (!/reported date/i.test(dateText) && /^[A-Z][a-z]{2}\s+\d{1,2}$/.test(dateText)) {
          const bullish = pctToNum(cells[1].trim());
          const neutral = pctToNum(cells[2].trim());
          const bearish = pctToNum(cells[3].trim());
          const sum = bullish + neutral + bearish;

          if (Math.abs(sum - 100) <= 1) {
            console.log("SUCCESS (retry):", { dateText, bullish, neutral, bearish, sum });
            return {
              reportedDate: dateText,
              bullish,
              neutral,
              bearish,
              source: "aaii-playwright"
            };
          }
        }
      }
    }

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
