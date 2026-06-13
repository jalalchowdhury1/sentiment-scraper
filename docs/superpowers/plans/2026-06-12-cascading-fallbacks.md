# Cascading Fallback Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-tier source cascade (aaii.com HTTP → Playwright L1-L4 → AAII Substack → YCharts) with freshness validation, Sheets-write retry, Telegram alerting, cron watchdog, workflow fixes, and history-purge security cleanup — all reversible.

**Architecture:** New `sources/` modules (one per tier) + `lib/` shared utilities feed an orchestrator loop in `sentiment-scraper.ts`. Existing Playwright layers are untouched (Tier 1). Workflows: gate removed from daily-scrape, retry fixed, watchdog + probe workflows added, test.yml made side-effect-free.

**Tech Stack:** TypeScript via ts-node (CommonJS, strict), Node 22 global `fetch`, Playwright, googleapis, Telegram Bot API (plain HTTPS), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-06-12-cascading-fallbacks-design.md`
**Repo:** `/Users/jalalchowdhury/PycharmProjects/sentiment-scraper` (public; pushes to main run test.yml — Task 1 defuses its side effects, so push Task 1 promptly)

**File map:**

| File | Status | Responsibility |
|---|---|---|
| `lib/types.ts` | create | `SentRow` shared type |
| `lib/validate.ts` | create | shared validate() + survey-date parsing + freshness |
| `lib/telegram.ts` | create | `alert()` — silent no-op without secrets |
| `sources/aaii-http.ts` | create | Tier 0: plain GET + regex |
| `sources/aaii-substack.ts` | create | Tier 2: archive API → RSS → post HTML |
| `sources/ycharts.ts` | create | Tier 3: 3 indicator pages |
| `sentiment-scraper.ts` | modify | orchestrator loop, DRY_RUN, write retry, F2 stamp, anti-regression |
| `watchdog.ts` | create | staleness check for watchdog.yml |
| `test-validate.ts`, `test-sources-offline.ts` | create | offline fixture tests |
| `test-tiers.ts` | create | live per-tier diagnostic (new PR gate) |
| `test-layers.ts` | modify | fix inverted exit logic only |
| `fixtures/*` | create | captured real HTML/JSON for offline tests |
| `.github/workflows/daily-scrape.yml` | modify | drop gate, fix retry `if`, final-failure alert, drop vestigial env |
| `.github/workflows/test.yml` | modify | DRY_RUN scrape, dispatch-gate layer4, later swap gate to test-tiers |
| `.github/workflows/watchdog.yml` | create | 20:00 UTC staleness check + re-dispatch + alert |
| `.github/workflows/probe-sources.yml` | create | dispatch-only curl probe from real GHA runner |
| `tsconfig.json` | modify | add `"lib": ["es2020", "dom"]` (global fetch typings) |
| `package.json` | modify | scripts; drop unused deps (stagehand, cheerio, zod) |
| `AGENTS.md` | modify | correct stale claims, document new architecture |

**Push batching (minimize CI side effects):** push after Tasks 1, 9, 11; E2E in Task 12; history purge Task 13 is its own force-push.

---

### Task 0: Rollback safety net

**Files:** none (git only)

- [ ] **Step 0.1: Verify clean tree** — Run: `git status --porcelain` → Expected: empty (only committed spec present).
- [ ] **Step 0.2: Tag current state**

```bash
git tag v1-pre-cascade 0f0ce38   # tag the pre-spec production state
git push origin v1-pre-cascade
```

- [ ] **Step 0.3: Local byte-perfect backup**

```bash
git bundle create ../sentiment-scraper-pre-cascade.bundle --all
git bundle verify ../sentiment-scraper-pre-cascade.bundle
```
Expected: "The bundle records a complete history" / verify OK.

**Rollback contract:** full reset = `git reset --hard v1-pre-cascade && git push --force origin main`. Post-purge recovery = `git clone ../sentiment-scraper-pre-cascade.bundle`.

---

### Task 1: Defuse test.yml side effects + fix daily-scrape retry (FIRST PUSH)

**Files:**
- Modify: `sentiment-scraper.ts:456-475` (runWorkflow — DRY_RUN guard)
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/daily-scrape.yml`

- [ ] **Step 1.1: DRY_RUN guard in runWorkflow.** In `sentiment-scraper.ts`, replace the `if (row) {` block body's success path:

```ts
  if (row) {
    const v = validate(row);
    if (v.ok) {
      console.log("\nScraping succeeded:", row);
      if (process.env.DRY_RUN) {
        console.log("[DRY_RUN] Skipping sheet write.");
        return row;
      }
      await writeToSheets(row);
      return row;
    } else {
```

- [ ] **Step 1.2: Verify DRY_RUN locally** — Run: `DRY_RUN=1 npx ts-node sentiment-scraper.ts` (needs `npm ci` + chromium once: `npx playwright install chromium`). Expected: "Scraping succeeded" + "[DRY_RUN] Skipping sheet write." and exit 0. No sheet change.
- [ ] **Step 1.3: test.yml — add dispatch trigger, gate layer4, DRY_RUN the scrape job.** Apply three edits:

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
```

`test-layer4` job gets:
```yaml
  test-layer4:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'
```

`scrape` job's run step env gets `DRY_RUN: "1"` added:
```yaml
      - run: npx ts-node sentiment-scraper.ts
        env:
          GOOGLE_SHEETS_CREDENTIALS: ${{ secrets.GOOGLE_SHEETS_CREDENTIALS }}
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          SHEET_ID: ${{ secrets.SHEET_ID }}
          DRY_RUN: "1"
```

- [ ] **Step 1.4: daily-scrape.yml — remove gate, widen retry condition, drop vestigial env, alert at exhaustion.**
  - Delete the step `- name: Test all extraction layers` (`run: npx ts-node test-layers.ts`).
  - Delete env lines `GOOGLE_GENERATIVE_AI_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`; add `TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}` and `TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}` to job env.
  - Retry step: `if: always() && steps.scraper.outcome != 'success'` (covers scraper failure AND earlier-step failure where scraper is skipped).
  - In the retry script's else-branch (max retries reached), before `exit 1`:

```bash
            if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
              curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
                -d chat_id="${TELEGRAM_CHAT_ID}" \
                --data-urlencode text="🚨 sentiment-scraper CRITICAL: daily scrape failed after ${MAX_RETRIES} retries. Sheet keeps last good value. https://github.com/${{ github.repository }}/actions" || true
            fi
```

  - Final step `Mark as failed if scraper failed`: `if: always() && steps.scraper.outcome != 'success'`.
- [ ] **Step 1.5: Validate YAML** — Run: `npx js-yaml .github/workflows/daily-scrape.yml > /dev/null && npx js-yaml .github/workflows/test.yml > /dev/null && echo OK` (or `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/daily-scrape.yml')); yaml.safe_load(open('.github/workflows/test.yml')); print('OK')"`). Expected: OK.
- [ ] **Step 1.6: Commit + push (with spec + tag already pushed)**

```bash
git add sentiment-scraper.ts .github/workflows/test.yml .github/workflows/daily-scrape.yml
git commit -m "ci: stop live sheet writes + Gemini spend on push; fix retry to fire on any failure; alert at retry exhaustion"
git push origin main
```

- [ ] **Step 1.7: Watch the push-triggered run** — Run: `gh run watch $(gh run list --workflow=test.yml --limit 1 --json databaseId -q '.[0].databaseId')`. Expected: `test` + `scrape` jobs green (scrape logs show DRY_RUN skip), `test-layer4` skipped.

---

### Task 2: Probe real GHA datacenter access (`probe-sources.yml`)

**Files:** Create: `.github/workflows/probe-sources.yml`

- [ ] **Step 2.1: Write the workflow** (dispatch-only, no secrets, pure curl):

```yaml
name: Probe Sources
on:
  workflow_dispatch:

jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - name: Probe all candidate sources
        run: |
          UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          probe () {
            name="$1"; url="$2"; pattern="$3"
            body=$(curl -sL --max-time 20 -A "$UA" \
              -H "Accept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" \
              -H "Accept-Language: en-US,en;q=0.9" \
              -w "\n__HTTP_STATUS__%{http_code}" "$url" || echo "__HTTP_STATUS__000")
            status="${body##*__HTTP_STATUS__}"
            matches=$(printf '%s' "$body" | grep -oE "$pattern" | head -3 | tr '\n' ' | ')
            echo "[$name] status=$status pattern_hits='${matches:-NONE}'"
          }
          probe "aaii-direct"      "https://www.aaii.com/sentimentsurvey/sent_results"            "[A-Z][a-z]{2} +[0-9]{1,2}</td>|[0-9]+\.[0-9]%"
          probe "substack-archive" "https://insights.aaii.com/api/v1/archive?sort=new&limit=12"   "\"slug\":\"[a-z0-9-]+\""
          probe "substack-rss"     "https://insights.aaii.com/feed"                               "<title>[^<]*[Ss]entiment[^<]*</title>"
          probe "ycharts-bullish"  "https://ycharts.com/indicators/us_investor_sentiment_bullish" "is at [0-9.]+%"
          probe "ycharts-neutral"  "https://ycharts.com/indicators/us_investor_sentiment_neutral" "is at [0-9.]+%"
          probe "ycharts-bearish"  "https://ycharts.com/indicators/us_investor_sentiment_bearish" "is at [0-9.]+%"
          echo "Done. status=200 + pattern hits = tier viable from GHA. 403/503/000 = blocked."
```

- [ ] **Step 2.2: Commit, push, dispatch, read results**

```bash
git add .github/workflows/probe-sources.yml
git commit -m "ci: add dispatch-only source probe workflow"
git push origin main
gh workflow run probe-sources.yml
sleep 45
gh run view $(gh run list --workflow=probe-sources.yml --limit 1 --json databaseId -q '.[0].databaseId') --log | grep -E "\[(aaii|substack|ycharts)" 
```
Expected: a status + pattern line per source. **Record results in AGENTS.md during Task 11.** Any blocked tier stays implemented (costs seconds) but documented as likely-403 from GHA.

---

### Task 3: `lib/types.ts` + `lib/validate.ts` (TDD)

**Files:**
- Modify: `tsconfig.json:13` — uncomment lib: `"lib": ["es2020", "dom"],` (gives `fetch`/`AbortController` typings for Node 22 runtime)
- Create: `lib/types.ts`, `lib/validate.ts`, `test-validate.ts`

- [ ] **Step 3.1: `lib/types.ts`**

```ts
export type SentRow = {
  reportedDate: string; // e.g. "Jun 10"
  bullish: number;
  neutral: number;
  bearish: number;
  source: string; // which tier/method produced it
};
```

- [ ] **Step 3.2: Write failing tests — `test-validate.ts`** (repo pattern: root-level ts-node script, exit 1 on failure):

```ts
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
```

- [ ] **Step 3.3: Run to verify failure** — Run: `npx ts-node test-validate.ts` → Expected: FAIL "Cannot find module './lib/validate'".
- [ ] **Step 3.4: Implement `lib/validate.ts`**

```ts
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
```

- [ ] **Step 3.5: Run tests** — `npx ts-node test-validate.ts` → Expected: `test-validate: ALL PASS`.
- [ ] **Step 3.6: Commit** — `git add tsconfig.json lib/ test-validate.ts && git commit -m "feat: shared validate() with survey-date parsing and freshness gate"`

---

### Task 4: `lib/telegram.ts` (TDD)

**Files:** Create: `lib/telegram.ts`; Modify: `test-validate.ts` (append telegram no-op tests — keeps offline tests in one runner later)

- [ ] **Step 4.1: Failing test — append to `test-validate.ts`:**

```ts
// --- lib/telegram.ts (offline behavior only) ---
import { alert, formatAlert } from "./lib/telegram";
(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  assert.equal(await alert("INFO", "test"), false); // no secrets -> silent no-op, returns false, never throws
  assert.match(formatAlert("CRITICAL", "all tiers failed"), /^🚨 sentiment-scraper CRITICAL:\nall tiers failed$/);
  assert.match(formatAlert("INFO", "x"), /^ℹ️ sentiment-scraper INFO:\nx$/);
  console.log("test-telegram: ALL PASS");
})();
```

- [ ] **Step 4.2: Verify failure** — `npx ts-node test-validate.ts` → FAIL "Cannot find module './lib/telegram'".
- [ ] **Step 4.3: Implement `lib/telegram.ts`**

```ts
export type AlertLevel = "CRITICAL" | "INFO";

export function formatAlert(level: AlertLevel, message: string): string {
  return `${level === "CRITICAL" ? "🚨" : "ℹ️"} sentiment-scraper ${level}:\n${message}`;
}

/**
 * Send a Telegram alert. Silent no-op (returns false) when TELEGRAM_BOT_TOKEN /
 * TELEGRAM_CHAT_ID are unset — safe to call before secrets exist. Never throws.
 */
export async function alert(level: AlertLevel, message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const text = formatAlert(level, message);
  if (!token || !chatId) {
    console.log(`[telegram] secrets absent, skipping alert: ${text.replace(/\n/g, " | ")}`);
    return false;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) console.log(`[telegram] sendMessage HTTP ${res.status}`);
    return res.ok;
  } catch (e: any) {
    console.log(`[telegram] send failed (non-fatal): ${e.message}`);
    return false;
  }
}
```

- [ ] **Step 4.4: Run tests** — `npx ts-node test-validate.ts` → both `ALL PASS` lines.
- [ ] **Step 4.5: Commit** — `git add lib/telegram.ts test-validate.ts && git commit -m "feat: telegram alert helper, dormant-safe without secrets"`

---

### Task 5: Fixtures + Tier 0 `sources/aaii-http.ts` (TDD)

**Files:** Create: `fixtures/aaii-sent-results.html`, `sources/aaii-http.ts`, `test-sources-offline.ts`

- [ ] **Step 5.1: Install fixture from tonight's probe capture**

```bash
mkdir -p fixtures
cp /tmp/aaii_sent_results_raw.html fixtures/aaii-sent-results.html
grep -c "tableTxt" fixtures/aaii-sent-results.html   # sanity: table cells present
```
Expected: count > 20. (If /tmp file is gone: `curl -sL -A "<Chrome UA from Task 2>" https://www.aaii.com/sentimentsurvey/sent_results -o fixtures/aaii-sent-results.html`; if that 403s, capture via the browser skill and save page HTML.)

- [ ] **Step 5.2: Failing test — `test-sources-offline.ts`:**

```ts
/** Offline parser tests against captured fixtures. Run: npx ts-node test-sources-offline.ts */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseAAIIHtml } from "./sources/aaii-http";

const NOW = new Date("2026-06-12T20:00:00Z");
const html = readFileSync("fixtures/aaii-sent-results.html", "utf8");
const row = parseAAIIHtml(html, NOW);
assert.ok(row, "parseAAIIHtml returned null");
assert.equal(row!.reportedDate, "Jun 10");
assert.equal(row!.bullish, 30.4);
assert.equal(row!.neutral, 22.0);
assert.equal(row!.bearish, 47.7);
assert.equal(row!.source, "aaii-http");
console.log("test-aaii-http: ALL PASS");
```

- [ ] **Step 5.3: Verify failure** — `npx ts-node test-sources-offline.ts` → FAIL "Cannot find module './sources/aaii-http'".
- [ ] **Step 5.4: Implement `sources/aaii-http.ts`**

```ts
import { SentRow } from "../lib/types";
import { parseSurveyDate, daysOld, MAX_AGE_DAYS } from "../lib/validate";

const URL = "https://www.aaii.com/sentimentsurvey/sent_results";
export const CHROME_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Parse the server-rendered sent_results table. Strict cell-regex first, then a
 *  tag-stripped loose pass (sum-validated) so attribute reshuffles don't kill us. */
export function parseAAIIHtml(html: string, now: Date = new Date()): SentRow | null {
  const strict = /<td[^>]*class="tableTxt"[^>]*>([A-Z][a-z]{2}\s+\d{1,2})<\/td>\s*<td[^>]*class="tableTxt"[^>]*>([\d.]+)%\s*<\/td>\s*<td[^>]*class="tableTxt"[^>]*>([\d.]+)%\s*<\/td>\s*<td[^>]*class="tableTxt"[^>]*>([\d.]+)%\s*<\/td>/;
  const candidates: RegExpExecArray[] = [];
  const sMatch = strict.exec(html);
  if (sMatch) candidates.push(sMatch);
  if (!candidates.length) {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const loose = /([A-Z][a-z]{2}\s+\d{1,2})\s+([\d.]+)%?\s+([\d.]+)%?\s+([\d.]+)%?/g;
    let m: RegExpExecArray | null;
    while ((m = loose.exec(text)) !== null) candidates.push(m);
  }
  for (const m of candidates) {
    const [, date, b, n, r] = m;
    const bullish = parseFloat(b), neutral = parseFloat(n), bearish = parseFloat(r);
    if ([bullish, neutral, bearish].some(isNaN)) continue;
    if (Math.abs(bullish + neutral + bearish - 100) > 1) continue;
    const d = parseSurveyDate(date, now);
    if (!d || daysOld(d, now) > MAX_AGE_DAYS) continue; // first FRESH valid row wins
    return { reportedDate: date.replace(/\s+/g, " ").trim(), bullish, neutral, bearish, source: "aaii-http" };
  }
  return null;
}

/** Tier 0: plain HTTPS GET — no browser. Returns null on any failure (logged). */
export async function fetchAAIIHttp(now: Date = new Date()): Promise<SentRow | null> {
  console.log("  [Tier 0] aaii.com plain HTTP...");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(URL, { headers: CHROME_HEADERS, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) { console.log(`  [Tier 0] HTTP ${res.status}`); return null; }
    const row = parseAAIIHtml(await res.text(), now);
    console.log(row ? `  [Tier 0] SUCCESS: ${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish}` : "  [Tier 0] no parseable fresh row");
    return row;
  } catch (e: any) {
    console.log(`  [Tier 0] failed: ${e.message}`);
    return null;
  }
}
```

- [ ] **Step 5.5: Run tests** — `npx ts-node test-sources-offline.ts` → `test-aaii-http: ALL PASS`. NOTE: the fixture's freshness is relative to `NOW` frozen at 2026-06-12, so this test stays green forever.
- [ ] **Step 5.6: Live smoke (info only, may 403 locally):** `npx ts-node -e "require('./sources/aaii-http').fetchAAIIHttp().then(r => console.log(r))"`
- [ ] **Step 5.7: Commit** — `git add fixtures/ sources/aaii-http.ts test-sources-offline.ts && git commit -m "feat: Tier 0 — plain-HTTP AAII fetch with fixture test"`

---

### Task 6: Tier 2 `sources/aaii-substack.ts` (TDD)

**Files:** Create: `fixtures/substack-post-body.html`, `sources/aaii-substack.ts`; Modify: `test-sources-offline.ts`

- [ ] **Step 6.1: Capture fixtures live**

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
curl -sL -A "$UA" "https://insights.aaii.com/api/v1/archive?sort=new&limit=12" -o /tmp/substack-archive.json
python3 -c "import json; d=json.load(open('/tmp/substack-archive.json')); print([p['slug'] for p in d][:5])"
# pick the slug containing 'sentiment-survey', then:
curl -sL -A "$UA" "https://insights.aaii.com/api/v1/posts/<THAT-SLUG>" | python3 -c "import json,sys; print(json.load(sys.stdin)['body_html'])" > fixtures/substack-post-body.html
grep -ci "bullish" fixtures/substack-post-body.html   # expected >= 1
```
(If curl is Cloudflare-blocked locally, fetch the same URLs via the browser skill. The archive JSON itself is NOT committed as a fixture — only the body HTML, which is what the parser regexes run against.)

- [ ] **Step 6.2: Failing tests — append to `test-sources-offline.ts`:**

```ts
// --- sources/aaii-substack.ts ---
import { parseSubstackBody } from "./sources/aaii-substack";
const body = readFileSync("fixtures/substack-post-body.html", "utf8");
const sRow = parseSubstackBody(body, "2026-06-11T12:00:00.000Z", NOW);
assert.ok(sRow, "parseSubstackBody returned null");
assert.equal(sRow!.bullish, 30.4);
assert.equal(sRow!.neutral, 22.0);
assert.equal(sRow!.bearish, 47.7);
assert.match(sRow!.source, /^aaii-substack/);
assert.ok(parseSurveyDate(sRow!.reportedDate, NOW), "substack reportedDate must parse");
// synthetic: "unchanged at X%" phrasing must also parse
const flat = "<p>Bullish sentiment was unchanged at 35.0%.</p><p>Neutral sentiment declined 0.2 percentage points to 30.0%.</p><p>Bearish sentiment, expectations that stock prices will fall, increased to 35.0%.</p>";
const fRow = parseSubstackBody(flat, "2026-06-11T12:00:00.000Z", NOW);
assert.equal(fRow!.bullish, 35.0);
console.log("test-aaii-substack: ALL PASS");
```
Also add `import { parseSurveyDate } from "./lib/validate";` at the top of the test file.

- [ ] **Step 6.3: Verify failure** — `npx ts-node test-sources-offline.ts` → FAIL "Cannot find module './sources/aaii-substack'".
- [ ] **Step 6.4: Implement `sources/aaii-substack.ts`**

```ts
import { SentRow } from "../lib/types";
import { CHROME_HEADERS } from "./aaii-http";

const BASE = "https://insights.aaii.com";
const MONTH_LONG: Record<string, string> = { january: "Jan", february: "Feb", march: "Mar", april: "Apr", may: "May", june: "Jun", july: "Jul", august: "Aug", september: "Sep", october: "Oct", november: "Nov", december: "Dec" };

async function get(url: string, accept: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(url, { headers: { ...CHROME_HEADERS, Accept: accept }, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) { console.log(`  [Tier 2] ${url} -> HTTP ${res.status}`); return null; }
    return await res.text();
  } catch (e: any) {
    console.log(`  [Tier 2] ${url} failed: ${e.message}`);
    return null;
  }
}

/** Extract bull/neutral/bear from AAII's weekly boilerplate prose. postDateISO is the
 *  Substack publish date (Thursday); survey "week ending" date is preferred if present. */
export function parseSubstackBody(bodyHtml: string, postDateISO: string, now: Date = new Date()): SentRow | null {
  const text = bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const grab = (label: string): number => {
    const m = new RegExp(`${label} sentiment[^%]{0,300}?(?:to|at)\\s+([\\d.]+)%`, "i").exec(text);
    return m ? parseFloat(m[1]) : NaN;
  };
  const bullish = grab("Bullish"), neutral = grab("Neutral"), bearish = grab("Bearish");
  if ([bullish, neutral, bearish].some(isNaN)) return null;
  if (Math.abs(bullish + neutral + bearish - 100) > 1) return null;
  // Survey date: prefer explicit "week ending <Month D>" in the prose; fall back to publish date - 1 day (post is Thu, table labels Wed).
  let reportedDate: string;
  const we = /week ending ([A-Za-z]+) (\d{1,2})/i.exec(text);
  if (we && MONTH_LONG[we[1].toLowerCase()]) {
    reportedDate = `${MONTH_LONG[we[1].toLowerCase()]} ${+we[2]}`;
  } else {
    const d = new Date(new Date(postDateISO).getTime() - 86400_000);
    reportedDate = `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  return { reportedDate, bullish, neutral, bearish, source: "aaii-substack" };
}

type ArchivePost = { title?: string; slug?: string; post_date?: string; canonical_url?: string };

/** Tier 2: AAII's first-party Substack. JSON API -> RSS -> post HTML, first hit wins. */
export async function fetchSubstack(now: Date = new Date()): Promise<SentRow | null> {
  console.log("  [Tier 2] AAII Substack...");
  // 2a: archive JSON API -> post JSON API
  const archiveRaw = await get(`${BASE}/api/v1/archive?sort=new&limit=12`, "application/json");
  if (archiveRaw) {
    try {
      const posts = JSON.parse(archiveRaw) as ArchivePost[];
      const post = posts.find(p => /sentiment[- ]survey/i.test(`${p.title ?? ""} ${p.slug ?? ""}`));
      if (post?.slug) {
        const postRaw = await get(`${BASE}/api/v1/posts/${post.slug}`, "application/json");
        if (postRaw) {
          const bodyHtml = (JSON.parse(postRaw) as { body_html?: string }).body_html ?? "";
          const row = parseSubstackBody(bodyHtml, post.post_date ?? new Date(now).toISOString(), now);
          if (row) { row.source = "aaii-substack-api"; console.log(`  [Tier 2] SUCCESS (api): ${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish}`); return row; }
        }
      }
    } catch (e: any) { console.log(`  [Tier 2] archive parse failed: ${e.message}`); }
  }
  // 2b: RSS feed
  const rss = await get(`${BASE}/feed`, "application/rss+xml, application/xml");
  if (rss) {
    const items = rss.split(/<item>/i).slice(1);
    for (const item of items) {
      const title = (/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(item)?.[1] ?? "");
      if (!/sentiment[- ]survey/i.test(title) && !/bullish|bearish/i.test(item)) continue;
      const content = /<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i.exec(item)?.[1] ?? item;
      const pub = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(item)?.[1];
      const row = parseSubstackBody(content, pub ? new Date(pub).toISOString() : new Date(now).toISOString(), now);
      if (row) { row.source = "aaii-substack-rss"; console.log(`  [Tier 2] SUCCESS (rss): ${row.reportedDate}`); return row; }
    }
  }
  console.log("  [Tier 2] no data via api/rss");
  return null;
}
```
(The third sub-fallback — fetching `canonical_url` HTML — is intentionally dropped: the RSS `content:encoded` already carries the full free-post body, so a third fetch of the same origin adds no source diversity. YAGNI.)

- [ ] **Step 6.5: Run tests** — `npx ts-node test-sources-offline.ts` → both ALL PASS lines.
- [ ] **Step 6.6: Live smoke** — `npx ts-node -e "require('./sources/aaii-substack').fetchSubstack().then(r => console.log(r))"` → Expected: row with `aaii-substack-api` (or `-rss`), Jun 11-ish values 30.4/22/47.7.
- [ ] **Step 6.7: Commit** — `git add sources/aaii-substack.ts fixtures/substack-post-body.html test-sources-offline.ts && git commit -m "feat: Tier 2 — AAII Substack (JSON API -> RSS) backup source"`

---

### Task 7: Tier 3 `sources/ycharts.ts` (TDD)

**Files:** Create: `sources/ycharts.ts`; Modify: `test-sources-offline.ts`

- [ ] **Step 7.1: Failing tests — append to `test-sources-offline.ts`** (YCharts fixtures are synthetic — the probe verified the exact phrasing but couldn't save a page capture):

```ts
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
```

- [ ] **Step 7.2: Verify failure** — `npx ts-node test-sources-offline.ts` → FAIL "Cannot find module './sources/ycharts'".
- [ ] **Step 7.3: Implement `sources/ycharts.ts`**

```ts
import { SentRow } from "../lib/types";
import { CHROME_HEADERS } from "./aaii-http";

const PAGES = {
  bullish: "https://ycharts.com/indicators/us_investor_sentiment_bullish",
  neutral: "https://ycharts.com/indicators/us_investor_sentiment_neutral",
  bearish: "https://ycharts.com/indicators/us_investor_sentiment_bearish",
} as const;

export type YChartsStat = { value: number; weekOf: string };

/** The latest stat is server-rendered prose: "...is at 30.40%, compared to ... for Wk of Jun 10 2026". */
export function parseYChartsPage(html: string): YChartsStat | null {
  const v = /is at\s+([\d.]+)%/.exec(html);
  const w = /for Wk of ([A-Za-z]{3} \d{1,2} \d{4})/.exec(html);
  if (!v) return null;
  return { value: parseFloat(v[1]), weekOf: w ? w[1] : "" };
}

export function assembleYCharts(stats: { bullish: YChartsStat | null; neutral: YChartsStat | null; bearish: YChartsStat | null }, now: Date = new Date()): SentRow | null {
  const { bullish, neutral, bearish } = stats;
  if (!bullish || !neutral || !bearish) return null;
  const weeks = new Set([bullish.weekOf, neutral.weekOf, bearish.weekOf]);
  if (weeks.size !== 1) return null; // three pages must describe the same survey week
  if (Math.abs(bullish.value + neutral.value + bearish.value - 100) > 1) return null;
  // "Jun 10 2026" -> "Jun 10" (strip year + leading-zero days like "Jun 04")
  const m = /^([A-Za-z]{3}) 0?(\d{1,2}) \d{4}$/.exec(bullish.weekOf);
  if (!m) return null;
  return { reportedDate: `${m[1]} ${m[2]}`, bullish: bullish.value, neutral: neutral.value, bearish: bearish.value, source: "ycharts" };
}

/** Tier 3: emergency third-party backup. 3 sequential GETs. */
export async function fetchYCharts(now: Date = new Date()): Promise<SentRow | null> {
  console.log("  [Tier 3] YCharts...");
  const out: any = { bullish: null, neutral: null, bearish: null };
  for (const [key, url] of Object.entries(PAGES)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const res = await fetch(url, { headers: CHROME_HEADERS, signal: ctrl.signal, redirect: "follow" });
      clearTimeout(timer);
      if (!res.ok) { console.log(`  [Tier 3] ${key} -> HTTP ${res.status}`); continue; }
      out[key] = parseYChartsPage(await res.text());
    } catch (e: any) { console.log(`  [Tier 3] ${key} failed: ${e.message}`); }
  }
  const row = assembleYCharts(out, now);
  console.log(row ? `  [Tier 3] SUCCESS: ${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish}` : "  [Tier 3] no consistent data");
  return row;
}
```

- [ ] **Step 7.4: Run tests** — `npx ts-node test-sources-offline.ts` → three ALL PASS lines.
- [ ] **Step 7.5: Commit** — `git add sources/ycharts.ts test-sources-offline.ts && git commit -m "feat: Tier 3 — YCharts emergency backup source"`

---

### Task 8: Orchestrator + hardened Sheets write in `sentiment-scraper.ts`

**Files:** Modify: `sentiment-scraper.ts` (imports, `validate` swap, `writeToSheets`, `runWorkflow`)

- [ ] **Step 8.1: Swap local helpers for shared lib.** At the top of `sentiment-scraper.ts`:
  - Replace the local `type SentRow = {...}` block with `import { SentRow } from "./lib/types";` and add `export type { SentRow };` (keeps any existing type importers working).
  - Delete the local `function validate(row: SentRow)...` (lines 21-28) and add `import { validate } from "./lib/validate";` plus `import { alert } from "./lib/telegram";` plus `import { fetchAAIIHttp } from "./sources/aaii-http"; import { fetchSubstack } from "./sources/aaii-substack"; import { fetchYCharts } from "./sources/ycharts";`
  - NOTE: per-layer inline `<= 1` sum checks inside L1-L4 are untouched (historical two-tolerance behavior preserved; the test harness copies of `validate()` in test-layers/test-comprehensive/quick-test keep working because they're self-contained).
- [ ] **Step 8.2: Fix the stale comment** at `sentiment-scraper.ts:370`: `// ── Main scraping function (runs all 3 layers)` → `// ── Tier 1: Playwright cascade over aaii.com (layers 1-4)`.
- [ ] **Step 8.3: Replace `writeToSheets` wholesale:**

```ts
// ── Write results to Google Sheets (3 attempts, anti-regression guard, F2 stamp) ──
const BACKOFFS_MS = [5_000, 15_000, 45_000];

function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS!),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function writeToSheets(row: SentRow): Promise<void> {
  const SHEET_ID = process.env.SHEET_ID ?? "1zQQ2am1yhzTwY7nx8xPak4Q0WoNMwxWj7Ekr-fDEIF4";
  const sheets = sheetsClient();
  const delta = `${(row.bearish - row.bullish).toFixed(2)}%`;

  // Anti-regression guard: never clobber a NEWER survey date with an older one
  // (e.g. a late retry that only reached a lagging backup source).
  try {
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "A2:F2" });
    const vals = cur.data.values?.[0] ?? [];
    const { parseSurveyDate } = await import("./lib/validate");
    const sheetDate = vals[0] ? parseSurveyDate(String(vals[0])) : null;
    const newDate = parseSurveyDate(row.reportedDate);
    if (sheetDate && newDate && sheetDate.getTime() > newDate.getTime()) {
      console.log(`Sheet already has newer survey (${vals[0]}) than candidate (${row.reportedDate}); skipping write.`);
      await alert("INFO", `Skipped write: sheet has ${vals[0]}, candidate ${row.reportedDate} (source ${row.source}) is older.`);
      return;
    }
    // F-column stamp is only safe if F is ours (empty or a previous stamp)
    (writeToSheets as any)._stampOk = !vals[5] || /^updated /.test(String(vals[5]));
  } catch (e: any) {
    console.log(`Pre-write read failed (continuing to write): ${e.message}`);
    (writeToSheets as any)._stampOk = false;
  }

  let lastErr: any;
  for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt++) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "A2:D2",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[row.reportedDate, `${row.bullish}%`, `${row.neutral}%`, `${row.bearish}%`]] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "E2",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[delta]] },
      });
      if ((writeToSheets as any)._stampOk) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: "F2",
          valueInputOption: "RAW",
          requestBody: { values: [[`updated ${new Date().toISOString()} via ${row.source}`]] },
        }).catch((e: any) => console.log(`F2 stamp failed (non-fatal): ${e.message}`));
      }
      console.log(`Wrote to sheet: ${row.reportedDate} | bull=${row.bullish}% | neu=${row.neutral}% | bear=${row.bearish}% | delta=${delta} | source=${row.source}`);
      return;
    } catch (e: any) {
      lastErr = e;
      console.log(`Sheets write attempt ${attempt + 1}/${BACKOFFS_MS.length} failed: ${e.message}`);
      if (attempt < BACKOFFS_MS.length - 1) await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt]));
    }
  }
  await alert("CRITICAL", `Sheets write failed after ${BACKOFFS_MS.length} attempts: ${lastErr?.message}\nDATA (enter manually): ${row.reportedDate} bull=${row.bullish}% neu=${row.neutral}% bear=${row.bearish}% delta=${delta} (source ${row.source})`);
  throw new Error(`Sheets write failed after retries: ${lastErr?.message}`);
}
```
(Note: `_stampOk` rides on the function object to avoid threading a param through — keep it simple, it's module-private state for one call sequence. The E2 delta string format and `USER_ENTERED` semantics are byte-identical to before — AGENTS.md gotchas #5/#6 hold.)

- [ ] **Step 8.4: Replace `runWorkflow` with the tier loop:**

```ts
// ── Main workflow: source-tier cascade, first valid + fresh row wins ──────────
type Tier = { name: string; idx: number; fn: () => Promise<SentRow | null> };

async function runWorkflow() {
  console.log("Starting AAII sentiment scraper (tiered cascade)...\n");
  const tiers: Tier[] = [
    { name: "Tier 0: aaii.com plain HTTP", idx: 0, fn: () => fetchAAIIHttp() },
    { name: "Tier 1: aaii.com Playwright L1-L4", idx: 1, fn: () => scrapeAAII() },
    { name: "Tier 2: AAII Substack", idx: 2, fn: () => fetchSubstack() },
    { name: "Tier 3: YCharts", idx: 3, fn: () => fetchYCharts() },
  ];

  for (const tier of tiers) {
    console.log(`\n=== ${tier.name} ===`);
    let row: SentRow | null = null;
    try {
      row = await tier.fn();
    } catch (e: any) {
      console.log(`${tier.name} threw (continuing to next tier): ${e.message}`);
    }
    if (!row) continue;
    const v = validate(row);
    if (!v.ok) {
      console.log(`${tier.name} row rejected: ${v.reason}`);
      continue;
    }
    if (v.warn) {
      console.log(`WARN: ${v.warn}`);
      if (!process.env.DRY_RUN) await alert("INFO", `${v.warn} (source ${row.source})`);
    }
    console.log(`\nScraping succeeded via ${tier.name}:`, row);
    if (process.env.DRY_RUN) {
      console.log("[DRY_RUN] Skipping sheet write + alerts.");
      return row;
    }
    if (tier.idx >= 2) {
      await alert("INFO", `Primary aaii.com path failed; used backup ${row.source} (${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish}). aaii.com may be blocking or broken — worth a look.`);
    }
    await writeToSheets(row);
    return row;
  }
  throw new Error("All tiers failed - no valid fresh data from any source");
}
```
(The retry-exhaustion CRITICAL alert lives in `daily-scrape.yml` (Task 1), not here — so a single mid-chain failure that self-heals on retry stays silent, and the alert fires even when Node/npm itself is broken.)

- [ ] **Step 8.5: Type-check + offline tests** — Run: `npx tsc --noEmit && npx ts-node test-validate.ts && npx ts-node test-sources-offline.ts && npx ts-node quick-test.ts` → Expected: all pass (quick-test exercises L1-L3 with canned HTML — proves Tier 1 internals untouched).
- [ ] **Step 8.6: Full DRY_RUN e2e** — Run: `DRY_RUN=1 npx ts-node sentiment-scraper.ts` → Expected: Tier 0 (or Tier 1) succeeds, `[DRY_RUN] Skipping sheet write + alerts.`, exit 0.
- [ ] **Step 8.7: Commit** — `git add sentiment-scraper.ts && git commit -m "feat: tiered source cascade with freshness gate, write retry, F2 stamp, anti-regression guard"`

---

### Task 9: Test gates — `test-tiers.ts` (new) + `test-layers.ts` exit-logic fix (SECOND PUSH)

**Files:** Create: `test-tiers.ts`; Modify: `test-layers.ts:143-158`, `.github/workflows/test.yml` (gate swap), `package.json` (scripts)

- [ ] **Step 9.1: Write `test-tiers.ts`:**

```ts
/**
 * test-tiers.ts — live diagnostic of every source tier. No sheet writes, no alerts.
 * Exit 0 if AT LEAST ONE tier yields valid fresh data (the cascade's real success
 * condition). Per-tier results printed for diagnostics.
 * Usage: npx ts-node test-tiers.ts
 */
import "dotenv/config";
import { validate } from "./lib/validate";
import { fetchAAIIHttp } from "./sources/aaii-http";
import { scrapeAAII } from "./sentiment-scraper";
import { fetchSubstack } from "./sources/aaii-substack";
import { fetchYCharts } from "./sources/ycharts";

async function main() {
  const tiers = [
    ["Tier 0 aaii-http", fetchAAIIHttp],
    ["Tier 1 playwright", scrapeAAII],
    ["Tier 2 substack", fetchSubstack],
    ["Tier 3 ycharts", fetchYCharts],
  ] as const;
  let passed = 0;
  for (const [name, fn] of tiers) {
    try {
      const row = await fn();
      const v = row ? validate(row) : { ok: false, reason: "returned null" };
      if (row && v.ok) { passed++; console.log(`✓ ${name}: ${row.reportedDate} ${row.bullish}/${row.neutral}/${row.bearish} [${row.source}]`); }
      else console.log(`✗ ${name}: ${v.reason}`);
    } catch (e: any) {
      console.log(`✗ ${name}: threw ${e.message}`);
    }
  }
  console.log(`\n${passed}/4 tiers passing`);
  if (passed === 0) { console.log("✗ FAIL: cascade would fail — every tier is down"); process.exit(1); }
  console.log("✓ SUCCESS: cascade viable");
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 9.2: Fix `test-layers.ts` inverted exit.** Replace lines 143-158 (`// Success = ...` through the closing brace of the else) with:

```ts
  // Success = the CASCADE succeeds: any layer (1-4) produced valid data.
  // (Previously this required ALL of L1-L3 to pass, which failed the run when
  // one layer degraded even though the cascade would have succeeded.)
  const anyPassed = results.some(r => r.ok);

  if (anyPassed) {
    console.log("\n✓ SUCCESS! At least one layer extracts valid data (cascade viable)");
    const failed = results.filter(r => !r.ok);
    if (failed.length) console.log(`⚠ Degraded layers to investigate: ${failed.map(r => r.layer).join(", ")}`);
  } else {
    console.log("\n✗ FAIL: All layers failed");
    process.exit(1);
  }
```

- [ ] **Step 9.3: `test.yml` gate swap** — in the `test` job, `- run: npx ts-node test-layers.ts` → `- run: npx ts-node test-tiers.ts`.
- [ ] **Step 9.4: `package.json` scripts** (name/main scaffolding fixed while here):

```json
  "name": "sentiment-scraper",
  "main": "sentiment-scraper.ts",
  "scripts": {
    "test": "ts-node test-validate.ts && ts-node test-sources-offline.ts && ts-node quick-test.ts",
    "test:tiers": "ts-node test-tiers.ts",
    "scrape:aaii": "ts-node sentiment-scraper.ts",
    "watchdog": "ts-node watchdog.ts"
  },
```

- [ ] **Step 9.5: Run everything** — `npm test && npx ts-node test-tiers.ts` → Expected: offline suites pass; tiers report ≥1 ✓ (likely 3-4 ✓).
- [ ] **Step 9.6: Commit + push** — `git add -A && git commit -m "feat: per-tier live diagnostic gate; fix inverted test-layers exit logic" && git push origin main` then watch: `gh run watch $(gh run list --workflow=test.yml --limit 1 --json databaseId -q '.[0].databaseId')` → green, no sheet write (DRY_RUN), no Gemini job.

---

### Task 10: Watchdog (`watchdog.ts` + `watchdog.yml`)

**Files:** Create: `watchdog.ts`, `.github/workflows/watchdog.yml`

- [ ] **Step 10.1: Write `watchdog.ts`:**

```ts
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
```
(A watchdog *error* — e.g. revoked credentials — reports stale=true: fail loud, not silent.)

- [ ] **Step 10.2: Write `.github/workflows/watchdog.yml`:**

```yaml
name: Watchdog
# Catches days where the daily scrape never ran (GitHub silently skips crons
# sometimes — e.g. May 28-30, 2026) or ran but never wrote. If the sheet is
# stale by 20:00 UTC, re-dispatch the scraper once and alert.
on:
  schedule:
    - cron: '0 20 * * *'   # 20:00 UTC — 12h after the 08:00 scrape window
  workflow_dispatch:

permissions:
  actions: write   # re-dispatch daily-scrape.yml

jobs:
  watchdog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
      - run: npm ci
      - name: Check sheet freshness
        id: check
        run: npx ts-node watchdog.ts
        env:
          GOOGLE_SHEETS_CREDENTIALS: ${{ secrets.GOOGLE_SHEETS_CREDENTIALS }}
          SHEET_ID: ${{ secrets.SHEET_ID }}
      - name: Re-dispatch daily scrape
        if: steps.check.outputs.stale == 'true'
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          curl -s -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer $GITHUB_TOKEN" \
            https://api.github.com/repos/${{ github.repository }}/actions/workflows/daily-scrape.yml/dispatches \
            -d '{"ref":"main","inputs":{"retry_count":"0"}}'
      - name: Alert
        if: steps.check.outputs.stale == 'true'
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: |
          if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
            curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
              -d chat_id="${TELEGRAM_CHAT_ID}" \
              --data-urlencode text="🚨 sentiment-scraper WATCHDOG: sheet is stale (${{ steps.check.outputs.detail }}). Re-dispatched the daily scrape. https://github.com/${{ github.repository }}/actions" || true
          fi
```
(The watchdog never retries itself — daily-scrape owns retries — so no dispatch loops. Two independent crons both silently skipping is far rarer than one.)

- [ ] **Step 10.3: Local check (optional)** — `npx ts-node watchdog.ts` if a local `.env` with `GOOGLE_SHEETS_CREDENTIALS` exists (fresh clones have none — the old `.env.bak` lives only in git history). If absent, skip; Step 12.3 exercises it on GHA with real secrets. Expected: `FRESH: ...` (or `STALE` + reason if today's write hasn't landed).
- [ ] **Step 10.4: Commit** — `git add watchdog.ts .github/workflows/watchdog.yml && git commit -m "feat: watchdog — detect silent cron skips, re-dispatch + alert"`

---

### Task 11: Dependency cleanup + AGENTS.md corrections (THIRD PUSH)

**Files:** Modify: `package.json` + `package-lock.json` (via npm), `AGENTS.md`

- [ ] **Step 11.1: Drop unused deps** (verified: no source file imports them):

```bash
npm uninstall @browserbasehq/stagehand cheerio zod
npm test   # offline suites still green
npx tsc --noEmit
```

- [ ] **Step 11.2: Update `AGENTS.md`** — precise corrections (it bills itself as the source of truth, so it must match reality):
  - §1: stack list — add "Backup sources: AAII Substack (`insights.aaii.com` JSON API/RSS), YCharts. Alerts: Telegram Bot API."
  - §2: replace the architecture diagram with the tier cascade (Tier 0 plain HTTP → Tier 1 Playwright L1-L4 → Tier 2 Substack → Tier 3 YCharts → validate incl. freshness ≤14d → Sheets write ×3 w/ backoff + F2 stamp → Telegram alerts). Note `DRY_RUN=1` semantics.
  - §3 table: add `test-validate.ts`, `test-sources-offline.ts` (offline), `test-tiers.ts` (live per-tier; the PR gate), `watchdog.ts`; note `test-layers.ts` now exits non-zero only when ALL layers fail.
  - §3 workflows: daily-scrape has no pre-gate, retry fires on any failure, alerts at exhaustion; test.yml scrape job is DRY_RUN and layer4 is dispatch-only; add watchdog.yml (20:00 UTC) and probe-sources.yml (manual) with the Task 2 probe results recorded.
  - §4 secrets table: add `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (optional — alerts silently disabled when absent); delete the `BROWSERBASE_*` and `GOOGLE_GENERATIVE_AI_API_KEY` rows (removed from workflows).
  - §5 Gotcha #1: rewrite — files untracked from the tree on 2026-06-08 (`0f0ce38`); blobs purged from history on <date of Task 13>; keys rotated <date> (leave explicit OWNER TODO if rotation still pending at write time).
  - §5 Gotcha #2 (node_modules): mark resolved. #3 (push writes sheet): resolved via DRY_RUN. #4 (Gemini per push): resolved via dispatch gate. #7: L4 still key-gated, but Tiers 0/2/3 now back it up. #9/#10: stale-comment + vestigial-deps notes — resolved.
  - §6 open items: only rotation remains (until done).
  - §7 file map: add the new `lib/`, `sources/`, `fixtures/`, `watchdog.ts`, new workflows, `docs/superpowers/` paths.
- [ ] **Step 11.3: Commit + push** — `git add -A && git commit -m "docs+deps: AGENTS.md matches tiered reality; drop unused deps" && git push origin main` → watch test.yml green.

---

### Task 12: End-to-end verification (live)

**Files:** none (operations only)

- [ ] **Step 12.1: Real production run** — `gh workflow run daily-scrape.yml` then `gh run watch $(gh run list --workflow=daily-scrape.yml --limit 1 --json databaseId -q '.[0].databaseId')`. Expected: green; logs show `=== Tier 0: aaii.com plain HTTP ===` then either Tier 0 SUCCESS (if Imperva passes GHA — note for AGENTS.md) or fallthrough to Tier 1 SUCCESS; `Wrote to sheet: ... | source=...`.
- [ ] **Step 12.2: Confirm F2 stamp landed** — rerun step 12.1's log grep for `F2` errors (none expected), and/or `gh workflow run watchdog.yml` next step reads it.
- [ ] **Step 12.3: Watchdog live check** — `gh workflow run watchdog.yml`, watch run. Expected: `FRESH: last write 0.Xh ago via <source>`, dispatch + alert steps skipped.
- [ ] **Step 12.4: User adds Telegram secrets (owner action, anytime):**

```bash
gh secret set TELEGRAM_BOT_TOKEN --repo jalalchowdhury1/sentiment-scraper   # paste existing bot's token
gh secret set TELEGRAM_CHAT_ID  --repo jalalchowdhury1/sentiment-scraper    # same chat id used by your other bots
```
Then one test ping: `TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npx ts-node -e "require('./lib/telegram').alert('INFO','sentiment-scraper alert wiring works')"` → message arrives. Until then every alert path is a logged no-op — nothing breaks.
- [ ] **Step 12.5: Verify rollback path is real** — `git describe --tags v1-pre-cascade` resolves; `git bundle verify ../sentiment-scraper-pre-cascade.bundle` OK.

---

### Task 13: Security — history purge + key rotation (LAST; separate force-push)

**Files:** git history only. **Precondition: Tasks 0-12 done and green; bundle verified.**

- [ ] **Step 13.1: Owner rotation checklist (zero-downtime order — create new, switch, verify, then revoke old):**
  1. **Gemini key:** aistudio.google.com/apikey → create new key → `gh secret set GOOGLE_API_KEY` → `gh workflow run test.yml` green (layer4 job via dispatch exercises it) → delete the old key.
  2. **Service account:** console.cloud.google.com → project `gen-lang-client-0758527558` → IAM → Service Accounts → `sheets-writer@...` → Keys → Add key (JSON) → `gh secret set GOOGLE_SHEETS_CREDENTIALS < downloaded.json` → `gh workflow run daily-scrape.yml` green → delete old key (id starts `3872aff8`). Sheet sharing unchanged (same SA email).
  3. **Browserbase key:** dashboard → delete the leaked key outright (nothing uses it anymore).
- [ ] **Step 13.2: Purge history** (local clone, after `brew install git-filter-repo`):

```bash
cd /Users/jalalchowdhury/PycharmProjects/sentiment-scraper
git bundle verify ../sentiment-scraper-pre-cascade.bundle   # escape hatch confirmed
git filter-repo --invert-paths \
  --path credentials/sheets-writer.json \
  --path .env.bak \
  --path node_modules \
  --force
git remote add origin https://github.com/jalalchowdhury1/sentiment-scraper.git  # filter-repo strips remotes
git push --force origin main
git push --force origin v1-pre-cascade   # rewritten tag (same content, minus secret blobs)
```

- [ ] **Step 13.3: Verify purge** — all must hold:

```bash
git log --all --oneline -- .env.bak credentials/ | wc -l        # 0
git show v1-pre-cascade:.env.bak 2>&1 | head -1                  # fatal: path does not exist
gh workflow run test.yml && sleep 60 && gh run list --limit 1    # still green post-rewrite
```

- [ ] **Step 13.4: Residual-exposure notes (tell the user):** GitHub keeps orphaned commits reachable by direct SHA URL until server-side GC (can be requested via GitHub Support). Check forks: `gh api repos/jalalchowdhury1/sentiment-scraper/forks -q '.[].full_name'` — if any exist, they retain the old history. **Rotation (13.1) is the real mitigation; the purge is hygiene.**
- [ ] **Step 13.5: Update AGENTS.md §5/§6** with purge + rotation dates; commit + push.

---

## Self-review (done at plan time)

- **Spec coverage:** §3.1 tiers→T5/6/7/8; §3.2 validate/freshness/anti-regression→T3/T8; §3.3 write retry+F2→T8; §3.4 alerts→T4/T1/T8/T10; §3.5 workflows→T1/T2/T10; §3.6 test-layers→T9; §3.7 security→T13; §3.8 rollback→T0/T12.5/T13.2; §3.9 testing→T3-9,12. F2-occupied handling simplified vs spec (skip stamp + watchdog A2-fallback instead of hunting for an empty column) — deliberate, noted in T8 code.
- **Placeholder scan:** none ("<THAT-SLUG>"/"<date>" are operator-fill-ins at execution time with explicit instructions, not deferred design).
- **Type consistency:** `SentRow` single-sourced from `lib/types.ts` (T3) and re-exported by `sentiment-scraper.ts` (T8.1); `validate(row, now?)`/`parseSurveyDate(text, now?)`/`daysOld(date, now?)` signatures match across T3/T5/T8/T9/T10; `CHROME_HEADERS` exported in T5, imported T6/T7; `alert(level, message)` matches T4/T8.
- **Known judgment calls:** Tier-1 `scrapeAAII` keeps its own browser lifecycle (untouched); offline tests freeze `NOW` so fixtures never rot; watchdog errors report stale (loud-fail).

