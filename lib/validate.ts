import { SentRow } from "./types";

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Parse "Jun 10", "Jun 04 2026", "June 10", or ISO "2026-06-11". Returns null if unparseable. */
export function parseSurveyDate(text: string, now: Date = new Date()): Date | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(t);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = +m[2];
  if (day < 1 || day > 31) return null;
  if (m[3]) return new Date(Date.UTC(+m[3], month, day));
  // No year: pick the most recent past occurrence (handles Dec dates read in Jan)
  let d = new Date(Date.UTC(now.getUTCFullYear(), month, day));
  if (d.getTime() > now.getTime() + 86400_000) d = new Date(Date.UTC(now.getUTCFullYear() - 1, month, day));
  return d;
}

export function daysOld(date: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - date.getTime()) / 86400_000);
}

export type Verdict = { ok: boolean; reason?: string; warn?: string };

export const MAX_AGE_DAYS = 14;   // hard fail beyond this (covers one skipped survey week)
export const WARN_AGE_DAYS = 8;   // info-warn beyond this

/** Single source of truth: range + sum(±0.8, matching the historical top-level gate) + freshness. */
export function validate(row: SentRow, now: Date = new Date()): Verdict {
  const sum = row.bullish + row.neutral + row.bearish;
  for (const [k, v] of [["bullish", row.bullish], ["neutral", row.neutral], ["bearish", row.bearish]] as const)
    if (typeof v !== "number" || isNaN(v) || v < 0 || v > 100) return { ok: false, reason: `${k} out of range: ${v}` };
  if (Math.abs(sum - 100) > 0.8) return { ok: false, reason: `sum ${sum.toFixed(2)} != 100` };
  const d = parseSurveyDate(row.reportedDate, now);
  if (!d) return { ok: false, reason: `unparseable survey date: "${row.reportedDate}"` };
  const age = daysOld(d, now);
  if (age > MAX_AGE_DAYS) return { ok: false, reason: `stale: survey date ${row.reportedDate} is ${age} days old (max ${MAX_AGE_DAYS})` };
  if (age > WARN_AGE_DAYS) return { ok: true, warn: `survey date ${row.reportedDate} is ${age} days old` };
  return { ok: true };
}
