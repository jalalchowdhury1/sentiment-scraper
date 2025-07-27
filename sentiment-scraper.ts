// Generated script for workflow 5293e128-e6cf-426b-b166-a9b52011b832
// Generated at 2025-06-17T18:35:07.961Z

import "dotenv/config";
import { Stagehand, type ConstructorParams } from "@browserbasehq/stagehand";
import { google } from "googleapis";              // ← Google Sheets client
import fs from "node:fs/promises";
import type { Page } from "@browserbasehq/stagehand";

type SentRow = {
  reportedDate: string;
  bullish: number;
  neutral: number;
  bearish: number;
  source: "aaii-dom" | "aaii-regex";
};

function pctToNum(txt: string): number {
  return parseFloat(txt.replace(/[%\s,]/g, ""));
}

function within(v: number, lo: number, hi: number) {
  return v >= lo && v <= hi;
}

function validate(row: SentRow): { ok: boolean; reason?: string } {
  const sum = row.bullish + row.neutral + row.bearish;
  if (!within(row.bullish, 0, 100) || !within(row.neutral, 0, 100) || !within(row.bearish, 0, 100)) {
    return { ok: false, reason: "percentage out of range" };
  }
  if (Math.abs(sum - 100) > 0.8) {
    return { ok: false, reason: `sum ${sum.toFixed(2)} != 100` };
  }
  return { ok: true };
}

async function extractFromDom(page: Page): Promise<SentRow | null> {
  // Wait until the correct table is present (contains the header text)
  await page.waitForFunction(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    return tables.some(t => /Reported Date/i.test(t.innerText) && /Bullish/i.test(t.innerText));
  }, { timeout: 20000 });

  const row = await page.evaluate(() => {
    // Find the table that has our headers
    const tables = Array.from(document.querySelectorAll("table"));
    const target = tables.find(t => {
      const txt = t.innerText;
      return /Reported Date/i.test(txt) && /Bullish/i.test(txt) && /Bearish/i.test(txt);
    });
    if (!target) return null;

    // First data row: prefer rows with class "tableTxt", else first <tr> after header
    const rows = Array.from(target.querySelectorAll("tr"));
    // header row often bold; data rows have class="tableTxt" on <td>
    let dataRow: HTMLTableRowElement | null = null;
    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length >= 4 && tds.every(td => td.textContent && td.textContent.trim().length > 0)) {
        // Skip header row containing "Reported Date"
        const joined = tds.map(td => td.textContent!.trim()).join("|");
        if (!/Reported Date/i.test(joined)) {
          dataRow = tr as HTMLTableRowElement;
          break;
        }
      }
    }
    if (!dataRow) return null;

    const tds = Array.from(dataRow.querySelectorAll("td")).map(td => td.textContent?.trim() ?? "");
    // Expect: [date, bull, neutral, bear]
    if (tds.length < 4) return null;

    return { date: tds[0], bull: tds[1], neu: tds[2], bear: tds[3] };
  });

  if (!row) return null;

  return {
    reportedDate: row.date,
    bullish: pctToNum(row.bull),
    neutral: pctToNum(row.neu),
    bearish: pctToNum(row.bear),
    source: "aaii-dom",
  };
}

async function extractWithRegex(page: Page): Promise<SentRow | null> {
  // Use full HTML so we can match across tags/newlines
  const html = await page.content();

  // Match the first occurrence of "Mon DD" (optional year) followed by three percentages.
  // Use [\s\S]*? to cross tags.
  const rx = /([A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)[\s\S]*?([\d.]+)%[\s\S]*?([\d.]+)%[\s\S]*?([\d.]+)%/;
  const m = html.match(rx);
  if (!m) return null;

  return {
    reportedDate: m[1].trim(),
    bullish: parseFloat(m[2]),
    neutral: parseFloat(m[3]),
    bearish: parseFloat(m[4]),
    source: "aaii-regex",
  };
}

async function fetchAAII(page: Page): Promise<SentRow> {
  await page.goto("https://www.aaii.com/sentimentsurvey/sent_results", {
    waitUntil: "domcontentloaded",
  });

  // Primary: DOM table. Secondary: regex on full text.
  const attempts = [extractFromDom, extractWithRegex];

  let lastErr: Error | null = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const row = await attempts[i](page);
      if (!row) {
        lastErr = new Error("no match");
      } else {
        const v = validate(row);
        if (v.ok) return row;
        lastErr = new Error(`validation failed: ${v.reason}`);
      }
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  throw lastErr ?? new Error("AAII extraction failed");
}

// ────────────────────────────────────────────────────────────────────
// Stagehand configuration helper
// ────────────────────────────────────────────────────────────────────
const stagehandConfig = (): ConstructorParams => ({
  env: "BROWSERBASE",
  verbose: 1,
  modelName: "google/gemini-2.5-flash-preview-05-20",
  modelClientOptions: { apiKey: process.env.GOOGLE_API_KEY },
});

// ────────────────────────────────────────────────────────────────────
// Main workflow
// ────────────────────────────────────────────────────────────────────
async function runWorkflow() {
  let stagehand: Stagehand | null = null;

  try {
    // 1) Start a browser session
    console.log("Initializing Stagehand…");
    const mask = (s?: string) => (s ? `${s.slice(0,4)}…${s.slice(-4)}` : "MISSING");
    if (process.env.DEBUG === "1") {
      console.log("BB_API:", mask(process.env.BROWSERBASE_API_KEY));
      console.log("BB_PROJ:", process.env.BROWSERBASE_PROJECT_ID ? "SET" : "MISSING");
      console.log("GOOGLE_API_KEY:", mask(process.env.GOOGLE_API_KEY));
      console.log("SHEETS_JSON:", process.env.GOOGLE_SHEETS_CREDENTIALS ? "SET" : "MISSING");
    }
    stagehand = new Stagehand(stagehandConfig());
    await stagehand.init();
    console.log("Stagehand initialized.");

    // 2) Navigate + extract AAII sentiment (robust)
    const page = stagehand.page;
    if (!page) throw new Error("No page instance from Stagehand.");

    let row: SentRow;
    try {
      row = await fetchAAII(page);
      console.log("AAII row:", row);
    } catch (e) {
      console.warn("AAII scrape failed. Capturing artifacts then aborting:", e);
      try { await page.screenshot({ path: "aaii-fail.png", fullPage: true }); } catch {}
      try { await fs.writeFile("aaii-fail.html", await page.content()); } catch {}
      throw e; // fail-fast, do NOT write to Sheets
    }

    const bullish = row.bullish;
    const neutral = row.neutral;
    const bearish = row.bearish;
    const deltaNumber = bearish - bullish;
    const deltaDisplay = `${deltaNumber.toFixed(2)}%`;

    console.log(`Validated sum: ${(bullish + neutral + bearish).toFixed(2)}%`);

    // 4) Push validated sentiment data into Google Sheets
    const SHEET_ID = process.env.SHEET_ID ?? "1zQQ2am1yhzTwY7nx8xPak4Q0WoNMwxWj7Ekr-fDEIF4";
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS!),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // Write all sentiment percentages to the sheet
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "A2:D2",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[row.reportedDate, `${bullish}%`, `${neutral}%`, `${bearish}%`]],
      },
    });

    // Write delta to column E
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "E2",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[deltaDisplay]] },
    });
    console.log(`Wrote sentiment data and ${deltaDisplay} delta to sheet.`);

    // 5) Close browser session
    await stagehand.close();
    console.log("Stagehand closed.");

    return row;
  } catch (err) {
    console.error("Workflow failed:", err);
    if (stagehand) await stagehand.close();
    throw err;
  }
}

// kick it off
runWorkflow()
  .then((data) => {
    console.log("Workflow finished successfully. Extracted data:", data);
  })
  .catch((err) => {
    console.error("Workflow execution failed:", err);
    process.exit(1);
  });
