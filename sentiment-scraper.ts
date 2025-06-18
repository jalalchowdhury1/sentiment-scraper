// Generated script for workflow 5293e128-e6cf-426b-b166-a9b52011b832
// Generated at 2025-06-17T18:35:07.961Z

import { Stagehand, type ConstructorParams } from "@browserbasehq/stagehand";
import { z } from "zod";
import { google } from "googleapis";              // ← Google Sheets client

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
    stagehand = new Stagehand(stagehandConfig());
    await stagehand.init();
    console.log("Stagehand initialized.");

    // 2) Navigate + extract AAII sentiment
    const page = stagehand.page;
    if (!page) throw new Error("No page instance from Stagehand.");

    await page.goto("https://www.aaii.com/sentimentsurvey/sent_results");
    console.log("Extracting sentiment data…");

    const extracted = await page.extract({
      instruction:
        "extract the latest sentiment data from the first row of the table, including the reported date, bullish percentage, and bearish percentage",
      schema: z.object({
        reportedDate: z.string().optional(),
        bullishPercent: z.number().optional(),
        bearishPercent: z.number().optional(),
      }),
    });
    console.log("Extracted:", extracted);

    // 3) Compute bearish – bullish delta (e.g. 33.6 − 36.7 = –3.10 %)
    const bullish = extracted.bullishPercent ?? 0;
    const bearish = extracted.bearishPercent ?? 0;
    const delta   = (bearish - bullish).toFixed(2) + "%";

    // 4) Push the delta into Google Sheets (cell A2)
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS!),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.update({
      spreadsheetId: "1zQQ2am1yhzTwY7nx8xPak4Q0WoNMwxWj7Ekr-fDEIF4",
      range: "A2",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[delta]] },
    });
    console.log(`Wrote ${delta} to A2 of the sheet.`);

    // 5) Close browser session
    await stagehand.close();
    console.log("Stagehand closed.");

    return extracted;
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
