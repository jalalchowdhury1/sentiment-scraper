import "dotenv/config";
import { Stagehand, type ConstructorParams } from "@browserbasehq/stagehand";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";
import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import type { Page } from "@browserbasehq/stagehand";

const AAII_URL = "https://www.aaii.com/sentimentsurvey/sent_results";
const AAII_API_URL = "https://www.aaii.com/sentimentsurvey/sent_results/export?format=json";
const AAII_MOBILE_URL = "https://www.aaii.com/sentimentsurvey/sent_results?format=mobile";

type SentRow = {
  reportedDate: string;
  bullish: number;
  neutral: number;
  bearish: number;
  source: "aaii-direct" | "aaii-mobile" | "aaii-api" | "aaii-archive" | "aaii-stagehand";
};

function pctToNum(txt: string): number {
  return parseFloat(txt.replace(/[%\s,]/g, ""));
}

function validate(row: SentRow): { ok: boolean; reason?: string } {
  const sum = row.bullish + row.neutral + row.bearish;
  if (
    row.bullish < 0 || row.bullish > 100 ||
    row.neutral < 0 || row.neutral > 100 ||
    row.bearish < 0 || row.bearish > 100
  ) return { ok: false, reason: "percentage out of range" };
  if (Math.abs(sum - 100) > 0.8)
    return { ok: false, reason: `sum ${sum.toFixed(2)} != 100` };
  return { ok: true };
}

// ── Layer 1: Direct HTTP + cheerio (no browser needed) ───────────────────────
export async function layer1Direct(): Promise<SentRow | null> {
  const res = await fetch(AAII_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    console.warn(`Layer 1: HTTP ${res.status}`);
    return null;
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  let result: SentRow | null = null;

  $("table").each((_, table) => {
    if (result) return false;
    const tableText = $(table).text();
    if (!/Reported Date/i.test(tableText) || !/Bullish/i.test(tableText))
      return;

    $(table)
      .find("tr")
      .each((_, tr) => {
        if (result) return false;
        const tds = $(tr).find("td");
        if (tds.length < 4) return;
        const cells = tds.map((_, td) => $(td).text().trim()).get();
        if (!cells.every((c: string) => c.length > 0)) return;
        if (/Reported Date/i.test(cells.join("|"))) return; // skip header

        const candidate: SentRow = {
          reportedDate: cells[0],
          bullish: pctToNum(cells[1]),
          neutral: pctToNum(cells[2]),
          bearish: pctToNum(cells[3]),
          source: "aaii-direct",
        };
        if (validate(candidate).ok) result = candidate;
      });
  });

  return result;
}

// ── Layer 2: Alternative URLs and API (completely different from Layer 1) ────
export async function layer2Alternative(page: Page): Promise<SentRow | null> {
  // Try alternative AAII URLs that might not have CAPTCHA
  const alternativeUrls = [
    { url: AAII_API_URL, type: "api" as const },
    { url: AAII_MOBILE_URL, type: "mobile" as const },
  ];

  for (const alt of alternativeUrls) {
    try {
      console.warn(`  Layer 2: Trying ${alt.type} URL: ${alt.url}`);

      // Set mobile user agent for mobile URL
      if (alt.type === "mobile") {
        await page.setExtraHTTPHeaders({
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        });
      }

      const response = await page.goto(alt.url, { waitUntil: "domcontentloaded", timeout: 15000 });

      if (response && response.ok()) {
        const content = await page.content();
        const $ = cheerio.load(content);

        // Try to extract from JSON response
        if (alt.type === "api") {
          try {
            const jsonData = JSON.parse(content);
            if (jsonData.data && Array.isArray(jsonData.data)) {
              const latest = jsonData.data[0];
              if (latest && latest.Bullish !== undefined) {
                return {
                  reportedDate: latest["Reported Date"] || latest.Date || "N/A",
                  bullish: parseFloat(latest.Bullish) || 0,
                  neutral: parseFloat(latest.Neutral) || 0,
                  bearish: parseFloat(latest.Bearish) || 0,
                  source: "aaii-api",
                };
              }
            }
          } catch {
            // Not JSON, try HTML parsing
          }
        }

        // Try HTML table parsing
        let result: SentRow | null = null;
        $("table").each((_, table) => {
          if (result) return false;
          const tableText = $(table).text();
          if (!/Reported Date/i.test(tableText) && !/Bullish/i.test(tableText))
            return;

          $(table)
            .find("tr")
            .each((_, tr) => {
              if (result) return false;
              const tds = $(tr).find("td");
              if (tds.length < 4) return;
              const cells = tds.map((_, td) => $(td).text().trim()).get();
              if (!cells.every((c: string) => c.length > 0)) return;
              if (/Reported Date/i.test(cells.join("|"))) return;

              const candidate: SentRow = {
                reportedDate: cells[0],
                bullish: pctToNum(cells[1]),
                neutral: pctToNum(cells[2]),
                bearish: pctToNum(cells[3]),
                source: alt.type === "mobile" ? "aaii-mobile" : "aaii-direct",
              };
              if (validate(candidate).ok) result = candidate;
            });
        });

        if (result) return result;
      }
    } catch (e) {
      console.warn(`  Layer 2 ${alt.type} attempt failed:`, (e as Error).message);
    }
  }

  // Try Internet Archive/Wayback Machine
  let archiveResult: SentRow | null = null;
  try {
    console.warn("  Layer 2: Trying Internet Archive...");
    const archiveUrl = `https://web.archive.org/web/2024/${AAII_URL}`;
    const archiveRes = await fetch(archiveUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; archive.org_bot; WaybackMachine)"
      }
    });

    if (archiveRes.ok) {
      const html = await archiveRes.text();
      const $ = cheerio.load(html);

      $("table").each((_, table) => {
        if (archiveResult) return false;
        const tableText = $(table).text();
        if (!/Reported Date/i.test(tableText) || !/Bullish/i.test(tableText))
          return;

        $(table)
          .find("tr")
          .each((_, tr) => {
            if (archiveResult) return false;
            const tds = $(tr).find("td");
            if (tds.length < 4) return;
            const cells = tds.map((_, td) => $(td).text().trim()).get();
            if (!cells.every((c: string) => c.length > 0)) return;
            if (/Reported Date/i.test(cells.join("|"))) return;

            const candidate: SentRow = {
              reportedDate: cells[0],
              bullish: pctToNum(cells[1]),
              neutral: pctToNum(cells[2]),
              bearish: pctToNum(cells[3]),
              source: "aaii-archive",
            };
            if (validate(candidate).ok) {
              console.warn("  Layer 2: Found data from Internet Archive");
              archiveResult = candidate;
            }
          });
      });

      if (archiveResult) return archiveResult;
    }
  } catch (e) {
    console.warn("  Layer 2 Archive attempt failed:", (e as Error).message);
  }

  return null;
}

// ── Layer 3: Stagehand interaction (completely different approach) ─────────────
export async function layer3Stagehand(stagehand: Stagehand): Promise<SentRow | null> {
  // Use Stagehand's act() to try to interact with the page and bypass CAPTCHA
  // This is a completely different method from DOM extraction

  try {
    console.warn("  Layer 3: Trying Stagehand interaction...");

    // Navigate with different settings
    const page = stagehand.page!;

    // Try to set viewport to mobile size (often bypasses CAPTCHA)
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(AAII_URL, { waitUntil: "networkidle", timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));

    // Try scrolling the page manually
    try {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 1000));
    } catch {
      // scroll might fail, continue
    }

    // Take screenshot and analyze with LLM
    const screenshotBuf = await page.screenshot({ fullPage: true });

    // Try to extract data from page after interaction
    const data = await page.evaluate(() => {
      // Look for any JSON data in the page
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const script of scripts) {
        const content = script.textContent || "";
        if (content.includes("bullish") || content.includes("Bearish")) {
          // Try to extract numbers
          const match = content.match(/"Bullish"\s*:\s*([\d.]+)/);
          if (match) {
            return { found: true, type: "script" };
          }
        }
      }

      // Try to find data in any attribute
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const attrs = Array.from(el.attributes).map(a => a.value);
        const text = attrs.join(" ");
        if (/[\d.]+%\s+[\d.]+%\s+[\d.]+%/.test(text)) {
          const numbers = text.match(/([\d.]+)%/g);
          if (numbers && numbers.length >= 3) {
            return { found: true, type: "attribute" };
          }
        }
      }

      return { found: false };
    });

    if (data && data.found) {
      // Try to parse the data we found
      const content = await page.content();
      const rx = /([A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)\s+([\d.]+)%?\s+([\d.]+)%?\s+([\d.]+)%?/;
      const m = content.match(rx);
      if (m) {
        return {
          reportedDate: m[1].trim(),
          bullish: parseFloat(m[2]),
          neutral: parseFloat(m[3]),
          bearish: parseFloat(m[4]),
          source: "aaii-stagehand",
        };
      }
    }

    // Try to extract from any visible table
    const tableData = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll("table"));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll("tr"));
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("td, th")).map(td => td.textContent?.trim() || "");
          if (cells.length >= 4 && /\d+/.test(cells[1])) {
            return cells;
          }
        }
      }
      return null;
    });

    if (tableData && tableData.length >= 4) {
      return {
        reportedDate: tableData[0],
        bullish: pctToNum(tableData[1]),
        neutral: pctToNum(tableData[2]),
        bearish: pctToNum(tableData[3]),
        source: "aaii-stagehand",
      };
    }

  } catch (e) {
    console.warn("  Layer 3 Stagehand interaction failed:", (e as Error).message);
  }

  return null;
}

// ── Stagehand config ──────────────────────────────────────────────────────────
const stagehandConfig = (): ConstructorParams => ({
  env: "BROWSERBASE",
  verbose: 1,
  modelName: "google/gemini-2.5-flash-preview-05-20",
  modelClientOptions: { apiKey: process.env.GOOGLE_API_KEY },
});

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
  // ── Layer 1: Direct HTTP + cheerio (no browser) ──
  console.log("Layer 1: trying direct HTTP + cheerio…");
  try {
    const row = await layer1Direct();
    if (row) {
      console.log("Layer 1 succeeded:", row);
      await writeToSheets(row);
      return row;
    }
    console.warn("Layer 1: no valid data found — page may require JS");
  } catch (e) {
    console.warn("Layer 1 failed:", e);
  }

  // ── Layers 2 & 3: Browser-based ──
  console.log("Falling back to browser-based extraction…");
  let stagehand: Stagehand | null = null;
  try {
    console.log("Initializing Stagehand…");
    stagehand = new Stagehand(stagehandConfig());
    await stagehand.init();
    console.log("Stagehand initialized.");

    const page = stagehand.page;
    if (!page) throw new Error("No page instance from Stagehand.");

    let row: SentRow | null = null;
    let lastErr: Error | null = null;

    // ── Layer 2: Alternative URLs and API ──
    console.log("Layer 2: trying alternative URLs (API, mobile, archive)…");
    try {
      row = await layer2Alternative(page);
      if (row) {
        const v = validate(row);
        if (!v.ok) {
          console.warn(`Layer 2 returned invalid data: ${v.reason}`);
          row = null;
        } else {
          console.log("Layer 2 succeeded:", row);
        }
      }
    } catch (e) {
      console.warn("Layer 2 failed:", e);
      lastErr = e instanceof Error ? e : new Error(String(e));
    }

    // ── Layer 3: Stagehand interaction ──
    if (!row) {
      console.log("Layer 3: trying Stagehand interaction…");
      try {
        row = await layer3Stagehand(stagehand);
        if (row) {
          const v = validate(row);
          if (!v.ok) {
            console.warn(`Layer 3 returned invalid data: ${v.reason}`);
            row = null;
          } else {
            console.log("Layer 3 succeeded:", row);
          }
        } else {
          lastErr = new Error("Layer 3: no data found");
        }
      } catch (e) {
        console.warn("Layer 3 failed:", e);
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }

    if (!row) {
      // Save debug artifacts before giving up
      try {
        await page.screenshot({ path: "aaii-fail.png", fullPage: true });
      } catch { }
      try {
        await fs.writeFile("aaii-fail.html", await page.content());
      } catch { }
      throw lastErr ?? new Error("All extraction layers failed");
    }

    await writeToSheets(row);
    await stagehand.close();
    return row;
  } catch (err) {
    console.error("Workflow failed:", err);
    if (stagehand) await stagehand.close();
    throw err;
  }
}

// Only run when invoked directly (not when imported by tests)
if (require.main === module) {
  runWorkflow()
    .then((data) =>
      console.log("Workflow finished successfully. Extracted data:", data)
    )
    .catch((err) => {
      console.error("Workflow execution failed:", err);
      process.exit(1);
    });
}
