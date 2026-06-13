/** Offline unit tests for lib/validate.ts. Run: npx ts-node test-validate.ts */
import assert from "node:assert";
import { validate, parseSurveyDate, daysOld } from "./lib/validate";

const NOW = new Date("2026-06-12T20:00:00Z");
const row = (over: object) => ({ reportedDate: "Jun 10", bullish: 30.4, neutral: 22.0, bearish: 47.7, source: "t", ...over });

// parseSurveyDate
assert.equal(parseSurveyDate("Jun 10", NOW)?.toISOString().slice(0, 10), "2026-06-10");
assert.equal(parseSurveyDate("Jun 4 2026", NOW)?.toISOString().slice(0, 10), "2026-06-04");
assert.equal(parseSurveyDate("Jun 04 2026", NOW)?.toISOString().slice(0, 10), "2026-06-04");
assert.equal(parseSurveyDate("2026-06-11", NOW)?.toISOString().slice(0, 10), "2026-06-11");
// year wrap: "Dec 30" seen in January belongs to LAST year
assert.equal(parseSurveyDate("Dec 30", new Date("2026-01-02T00:00:00Z"))?.toISOString().slice(0, 10), "2025-12-30");
assert.equal(parseSurveyDate("garbage", NOW), null);
assert.equal(daysOld(parseSurveyDate("Jun 10", NOW)!, NOW), 2);

// validate: happy path
assert.deepEqual(validate(row({}), NOW), { ok: true });
// range + sum (same tolerances as before: ±0.8)
assert.equal(validate(row({ bullish: 101 }), NOW).ok, false);
assert.equal(validate(row({ neutral: 23.0 }), NOW).ok, false); // sum 101.1
// freshness: >14 days = fail; 9-14 days = ok with warn
assert.equal(validate(row({ reportedDate: "May 20" }), NOW).ok, false);
const warned = validate(row({ reportedDate: "Jun 2" }), NOW); // 10 days
assert.equal(warned.ok, true);
assert.match(warned.warn ?? "", /days old/);
// unparseable date = fail
assert.equal(validate(row({ reportedDate: "???" }), NOW).ok, false);

console.log("test-validate: ALL PASS");
