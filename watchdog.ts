/**
 * watchdog.ts — detects silent scrape failures (e.g. GitHub cron skips).
 * Reads the sheet's F2 "updated <ISO> via <source>" stamp; falls back to parsing
 * the A2 survey date. Prints STALE/FRESH and writes stale=true|false to
 * $GITHUB_OUTPUT when present. Exit 0 always (the workflow reads the output).
 */
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { google } from "googleapis";
import { parseSurveyDate, daysOld } from "./lib/validate";

const MAX_WRITE_AGE_H = 26;   // F2 stamp: a successful write should happen daily
const MAX_SURVEY_AGE_D = 9;   // A2 fallback: weekly survey + 2-day grace

async function main() {
  const SHEET_ID = process.env.SHEET_ID ?? "1zQQ2am1yhzTwY7nx8xPak4Q0WoNMwxWj7Ekr-fDEIF4";
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS!),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "A2:F2" });
  const vals = (res.data.values?.[0] ?? []).map(String);
  const now = new Date();

  let stale: boolean;
  let detail: string;
  const stamp = /^updated (\S+) via (\S+)$/.exec(vals[5] ?? "");
  if (stamp) {
    const ageH = (now.getTime() - new Date(stamp[1]).getTime()) / 3_600_000;
    stale = !(ageH <= MAX_WRITE_AGE_H);   // NaN-safe: NaN comparisons are false -> stale
    detail = `last write ${isNaN(ageH) ? "unparseable" : ageH.toFixed(1) + "h ago"} via ${stamp[2]}`;
  } else {
    const d = vals[0] ? parseSurveyDate(vals[0], now) : null;
    stale = !d || daysOld(d, now) > MAX_SURVEY_AGE_D;
    detail = `no F2 stamp; A2 survey date "${vals[0] ?? "(empty)"}" ${d ? daysOld(d, now) + " days old" : "unparseable"}`;
  }

  console.log(`${stale ? "STALE" : "FRESH"}: ${detail}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `stale=${stale}\ndetail=${detail}\n`);
}
main().catch(e => { console.error("Watchdog error:", e); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `stale=true\ndetail=watchdog error: ${e.message}\n`); });
