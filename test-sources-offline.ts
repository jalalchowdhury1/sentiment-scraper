/** Offline parser tests against captured fixtures. Run: npx ts-node test-sources-offline.ts */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseSurveyDate } from "./lib/validate";
import { parseAAIIHtml } from "./sources/aaii-http";

const NOW = new Date("2026-06-12T20:00:00Z");

// --- sources/aaii-http.ts ---
const html = readFileSync("fixtures/aaii-sent-results.html", "utf8");
const row = parseAAIIHtml(html, NOW);
assert.ok(row, "parseAAIIHtml returned null");
assert.equal(row!.reportedDate, "Jun 10");
assert.equal(row!.bullish, 30.4);
assert.equal(row!.neutral, 22.0);
assert.equal(row!.bearish, 47.7);
assert.equal(row!.source, "aaii-http");
console.log("test-aaii-http: ALL PASS");
