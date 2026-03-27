import "dotenv/config";
import { Stagehand, type ConstructorParams } from "@browserbasehq/stagehand";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";
import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import type { Page } from "@browserbasehq/stagehand";

const AAII_URL = "https://www.aaii.com/sentimentsurvey/sent_results";

type SentRow = {
  reportedDate: string;
  bullish: number;
  neutral: number;
  bearish: number;
  source: "aaii-direct" | "aaii-screenshot" | "aaii-dom" | "aaii-regex";
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

// ── Layer 2: Screenshot → Gemini Vision LLM ──────────────────────────────────
export async function layer2Screenshot(page: Page): Promise<SentRow | null> {
  const screenshotBuf = await page.screenshot({ fullPage: false });

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

  const imagePart = {
    inlineData: {
      data: Buffer.from(screenshotBuf).toString("base64"),
      mimeType: "image/png" as const,
    },
  };

  const prompt = `This is a screenshot of the AAII Investor Sentiment Survey historical results page.
Find the MOST RECENT row in the data table (the first data row after the header).
Extract the reported date and the three sentiment percentages.
Reply with ONLY valid JSON, no markdown, no explanation:
{"reportedDate": "Mon DD", "bullish": XX.X, "neutral": XX.X, "bearish": XX.X}`;

  const result = await model.generateContent([imagePart, prompt]);
  const text = result.response.text().trim().replace(/```json\n?|\n?```/g, "");
  const parsed = JSON.parse(text);

  return {
    reportedDate: String(parsed.reportedDate),
    bullish: parseFloat(parsed.bullish),
    neutral: parseFloat(parsed.neutral),
    bearish: parseFloat(parsed.bearish),
    source: "aaii-screenshot",
  };
}

// ── Layer 3: Browser (DOM then regex, no blocking wait) ──────────────────────
export async function layer3Browser(page: Page): Promise<SentRow | null> {
  // 3a: DOM table extraction — no waitForFunction, evaluate directly
  try {
    const row = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll("table"));
      const target = tables.find((t) => {
        const txt = t.textContent ?? "";
        return /Reported Date/i.test(txt) && /Bullish/i.test(txt) && /Bearish/i.test(txt);
      });
      if (!target) return null;

      for (const tr of Array.from(target.querySelectorAll("tr"))) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds.length < 4) continue;
        const cells = tds.map((td) => td.textContent?.trim() ?? "");
        if (!cells.every((c) => c.length > 0)) continue;
        if (/Reported Date/i.test(cells.join("|"))) continue;
        return { date: cells[0], bull: cells[1], neu: cells[2], bear: cells[3] };
      }
      return null;
    });

    if (row) {
      return {
        reportedDate: row.date,
        bullish: pctToNum(row.bull),
        neutral: pctToNum(row.neu),
        bearish: pctToNum(row.bear),
        source: "aaii-dom",
      };
    }
    console.warn("  Layer 3 DOM: no matching table found");
  } catch (e) {
    console.warn("  Layer 3 DOM failed:", (e as Error).message);
  }

  // 3b: regex on rendered innerText
  try {
    const text: string = await page.evaluate(() => document.body.innerText);
    // Log first 300 chars so we can diagnose what the browser is seeing
    console.warn("  Layer 3 page text preview:", text.substring(0, 300).replace(/\n+/g, " "));

    const rx = /([A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%/;
    const m = text.match(rx);
    if (m) {
      return {
        reportedDate: m[1].trim(),
        bullish: parseFloat(m[2]),
        neutral: parseFloat(m[3]),
        bearish: parseFloat(m[4]),
        source: "aaii-regex",
      };
    }
    console.warn("  Layer 3 regex: no date+percentage pattern found in rendered text");
  } catch (e) {
    console.warn("  Layer 3 regex failed:", (e as Error).message);
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

    await page.goto(AAII_URL, { waitUntil: "load" });
    // Give JS-rendered content time to paint
    await new Promise((r) => setTimeout(r, 3000));

    let row: SentRow | null = null;
    let lastErr: Error | null = null;

    // ── Layer 2: Screenshot → Gemini Vision ──
    console.log("Layer 2: trying screenshot → Gemini Vision…");
    try {
      row = await layer2Screenshot(page);
      if (row) {
        const v = validate(row);
        if (!v.ok) {
          console.warn(`Layer 2 vision returned invalid data: ${v.reason}`);
          row = null;
        } else {
          console.log("Layer 2 succeeded:", row);
        }
      }
    } catch (e) {
      console.warn("Layer 2 failed:", e);
      lastErr = e instanceof Error ? e : new Error(String(e));
    }

    // ── Layer 3: Browser DOM + regex ──
    if (!row) {
      console.log("Layer 3: trying browser DOM + regex…");
      try {
        row = await layer3Browser(page);
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
      } catch {}
      try {
        await fs.writeFile("aaii-fail.html", await page.content());
      } catch {}
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
