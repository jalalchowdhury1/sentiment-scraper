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

// --- sources/aaii-substack.ts ---
import { parseSubstackBody } from "./sources/aaii-substack";
const body = readFileSync("fixtures/substack-post-body.html", "utf8");
// Fixture is the real "Pessimism Steps Down" post (2026-06-06): bullish 36.3, neutral 26.7, bearish 37.0.
const sRow = parseSubstackBody(body, "2026-06-06T15:30:38.041Z", NOW);
assert.ok(sRow, "parseSubstackBody returned null");
assert.equal(sRow!.bullish, 36.3);
assert.equal(sRow!.neutral, 26.7);
assert.equal(sRow!.bearish, 37.0);
assert.match(sRow!.source, /^aaii-substack/);
assert.ok(parseSurveyDate(sRow!.reportedDate, NOW), "substack reportedDate must parse");
// regression: the summary "neutral sentiment increased." sentence (no number) must NOT
// steal the Bullish number — the parser must anchor each label to its own sentence.
assert.notEqual(sRow!.neutral, sRow!.bullish);
// synthetic: flat-week "unchanged at X%" phrasing must also parse
const flat = "<p>Bullish sentiment was unchanged at 35.0%.</p><p>Neutral sentiment declined 0.2 percentage points to 30.0%.</p><p>Bearish sentiment, expectations that stock prices will fall, increased to 35.0%.</p>";
const fRow = parseSubstackBody(flat, "2026-06-11T12:00:00.000Z", NOW);
assert.ok(fRow, "flat-week parse returned null");
assert.equal(fRow!.bullish, 35.0);
assert.equal(fRow!.neutral, 30.0);
assert.equal(fRow!.bearish, 35.0);
console.log("test-aaii-substack: ALL PASS");

// --- sources/ycharts.ts ---
import { parseYChartsPage, assembleYCharts } from "./sources/ycharts";
const yc = (v: number) => `<meta name="description" content="In depth view... US Investor Sentiment, % Bull is at ${v}%, compared to ${v - 1}% last week and 20.9% last year... for Wk of Jun 10 2026.">`;
assert.deepEqual(parseYChartsPage(yc(30.4)), { value: 30.4, weekOf: "Jun 10 2026" });
assert.equal(parseYChartsPage("<html>paywall</html>"), null);
const yRow = assembleYCharts({ bullish: { value: 30.4, weekOf: "Jun 10 2026" }, neutral: { value: 22.0, weekOf: "Jun 10 2026" }, bearish: { value: 47.7, weekOf: "Jun 10 2026" } }, NOW);
assert.ok(yRow);
assert.equal(yRow!.reportedDate, "Jun 10");
assert.equal(yRow!.source, "ycharts");
// mismatched weeks across the 3 pages -> reject
assert.equal(assembleYCharts({ bullish: { value: 30.4, weekOf: "Jun 10 2026" }, neutral: { value: 22.0, weekOf: "Jun 3 2026" }, bearish: { value: 47.7, weekOf: "Jun 10 2026" } }, NOW), null);
console.log("test-ycharts: ALL PASS");
