# AGENTS.md — AAII Sentiment Scraper

> **This is the single source of truth for anyone (human or AI) touching this repo.**
> Read it fully before changing code, editing workflows, or rotating secrets. The repo
> had **no docs** before this file; nothing was consolidated or deleted to create it.
> If something here is wrong, fix *this* file.

---

## 1. What this is

A tiny TypeScript scraper that, **once a day**, pulls the latest **AAII Investor
Sentiment Survey** (bullish / neutral / bearish percentages) from
<https://www.aaii.com/sentimentsurvey/sent_results> and writes the most recent row into a
**Google Sheet**. There is no server and no deploy target — it runs entirely as a
**GitHub Actions** cron job on `ubuntu-latest`.

- **Language / stack:** TypeScript run directly via `ts-node` (CommonJS, `target es2018`).
  No build/compile step is used in CI (`outDir: dist` exists in `tsconfig.json` but is
  never produced).
- **Source cascade (first valid + fresh row wins):** Tier 0 aaii.com plain-HTTP+regex
  (no browser) → Tier 1 Playwright headless Chromium (4 internal layers, incl. an optional
  Gemini `gemini-2.5-flash` vision layer via `@google/generative-ai`) → Tier 2 AAII's own
  Substack `insights.aaii.com` (JSON API → RSS) → Tier 3 YCharts indicator pages.
- **Sink:** Google Sheets API v4 via `googleapis` + a service-account (3 attempts w/ backoff).
- **Alerts:** Telegram Bot API (plain HTTPS) — dormant/no-op until `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_CHAT_ID` secrets exist.
- **Repo:** `https://github.com/jalalchowdhury1/sentiment-scraper` (**public**), default
  branch `main`.

The single scraper entry point is **`sentiment-scraper.ts`** (run with
`npm run scrape:aaii`, i.e. `ts-node sentiment-scraper.ts`). Everything else is a test
harness.

### Note on `package.json` metadata vs reality
`package.json` still has scaffolding defaults — `"name": "my-demo-project"`,
`"main": "test.js"`, and a `"test"` script that just `exit 1`s. **Ignore these.** The real
entry is `sentiment-scraper.ts` via the `scrape:aaii` script; `test.js` is a one-line empty
stub (`// Function to reverse a string`) and is not used by anything.

---

## 2. Architecture / data flow

```
GitHub Actions cron (daily-scrape.yml, 08:00 UTC) ── watchdog.yml (20:00 UTC) re-dispatches if stale
        │
        ▼
 ts-node sentiment-scraper.ts  ── runWorkflow(): SOURCE-TIER CASCADE (first valid+fresh wins)
        │
        ├─ Tier 0  sources/aaii-http.ts     plain HTTPS GET + table regex (no browser, ~2s)
        ├─ Tier 1  scrapeAAII()             Playwright Chromium, internal layers L1→L2→L3→L4
        ├─ Tier 2  sources/aaii-substack.ts insights.aaii.com JSON API → RSS  (first-party backup)
        └─ Tier 3  sources/ycharts.ts       3 YCharts indicator pages         (third-party backup)
        │                                   each returns SentRow {date,bull,neu,bear,source} | null
        ▼
   validate(row)  (lib/validate.ts: range + sum±0.8 + freshness ≤14d)
        │ ok                                   │ all tiers fail
        ▼                                       ▼
   writeToSheets()  3 attempts (5s/15s/45s)   throw → workflow retry harness (≤10× / 15min)
        ├─ anti-regression: skip if sheet date NEWER than candidate          → on exhaustion: 🚨 Telegram
        ├─ A2:D2 = reportedDate, bullish%, neutral%, bearish%
        ├─ E2    = delta = (bearish − bullish)%
        ├─ F2    = "updated <ISO-UTC> via <source>"  (watchdog reads this)
        └─ on write failure after 3 tries → 🚨 Telegram (with the numbers, for manual entry)
```

### The source-tier cascade (`runWorkflow` in `sentiment-scraper.ts`)
`runWorkflow()` tries the four tiers in order and returns the **first** row that passes
`validate()`. A tier throwing is caught and logged; the loop continues. If a backup tier
(≥ Tier 2) wins, an INFO Telegram alert fires ("aaii.com path failed; used backup …").

- **Tier 0 — `fetchAAIIHttp` (`sources/aaii-http.ts`):** plain `fetch()` of the
  server-rendered sent_results page + strict cell regex (loose tag-stripped fallback).
  Imperva-fronted but **does not block GitHub Actions IPs** (probe-verified). The common path.
- **Tier 1 — `scrapeAAII` (`sentiment-scraper.ts`):** the original Playwright cascade,
  unchanged. Navigates once, then tries internal layers, first inline-`sum≈1%` hit wins:
  1. `layer1DOMTable` — `<table>` rows, first cell `Mon DD`, cells 1–3 = bull/neu/bear.
  2. `layer2TextRegex` — `body` text + data-attribute regexes.
  3. `layer3Alternative` — (a) `page.content()` regex, (b) `page.evaluate()` script/window
     scan, (c) mobile-viewport retry, (d) reload+retry.
  4. `layer4VisionLLM` — full-page screenshot → **Gemini 2.5 Flash** → JSON. **Skipped if
     `GOOGLE_API_KEY` unset.** Costs credits; last resort within Tier 1. On total Tier-1
     failure it dumps `aaii-fail.png`/`aaii-fail.html` (gitignored) and returns null.
- **Tier 2 — `fetchSubstack` (`sources/aaii-substack.ts`):** AAII's own Substack. Hits the
  archive JSON API (`/api/v1/archive?sort=new&limit=30` — the sentiment post is often not in
  the newest dozen), finds the `…sentiment-survey…` post, parses `body_html` prose. Falls
  back to the RSS `/feed`. **Typically lags the website by ~1 week** (posted later), so it's
  a lower tier. The label→number regex uses a negative lookahead so a summary sentence that
  names a label without a number can't steal the next label's percentage.
- **Tier 3 — `fetchYCharts` (`sources/ycharts.ts`):** 3 indicator pages; latest value +
  "Wk of <date>" are server-rendered in page prose. All three must agree on the week.

### Validation (the data-quality gate) — `lib/validate.ts` (single source of truth)
- `validate(row, now?)`: each percent 0–100, `|sum − 100| ≤ 0.8`, and **freshness** — the
  survey date must parse and be ≤ 14 days old (8–14 days → `ok` with a `warn`). Returns
  `{ok, reason?, warn?}`.
- `parseSurveyDate` handles `"Jun 10"`, `"Jun 04 2026"`, `"June 10"`, ISO `2026-06-11`, and
  the Dec-in-January year-wrap.
- Per-layer inline checks inside Tier 1 still use `±1` (historical, untouched). The shared
  `validate()` replaced the old copy-pasted function — test harnesses that still inline their
  own `validate` (`test-layers`, `test-comprehensive`, `quick-test`) are self-contained and
  unaffected.

---

## 3. How to run / test

### Local
```bash
npm ci
node node_modules/playwright/cli.js install chromium   # project CLI — version-matched to the package

# create .env with real values (see §4); there is NO committed .env.bak anymore
npm run scrape:aaii            # = ts-node sentiment-scraper.ts  (WRITES TO THE SHEET)
DRY_RUN=1 npm run scrape:aaii  # full cascade, NO sheet write, NO alerts — safe to run anywhere
```
A VS Code launch config (`.vscode/launch.json`, **"Scrape AAII"**) runs the scraper under
`ts-node` with `envFile=.env`.

### Test harnesses (none write to the sheet)
| Command | What it does |
|---|---|
| `npm test` | **Offline suite (no network):** `test-validate.ts` (validate/date parsing + telegram no-op) → `test-sources-offline.ts` (Tier 0/2/3 parsers vs committed `fixtures/`) → `quick-test.ts` (Tier-1 layers vs canned HTML). |
| `npx ts-node test-tiers.ts` | **Live per-tier diagnostic** — runs all 4 tiers against live sources, prints PASS/FAIL each, exits 0 if **≥1** tier yields valid fresh data. This is the CI gate in `test.yml`. |
| `npx ts-node test-layers.ts` | Live Tier-1 layer diagnostic. Exits non-zero only if **all** layers fail (fixed — was previously "all of L1–L3 must pass"). |
| `npx ts-node test-comprehensive.ts [--force4\|--layer4]` | Tier-1 layer test modes; `--layer4` hits Gemini (**costs credits**). |
| `npx ts-node test-gemini.ts` | Sanity-checks that `GOOGLE_API_KEY` works (text + a 1×1-pixel vision call). |
| `npx ts-node watchdog.ts` | Reads the sheet's F2/A2 freshness; prints STALE/FRESH. Needs `GOOGLE_SHEETS_CREDENTIALS`. |

### GitHub Actions (the only "deploy")
- **`.github/workflows/daily-scrape.yml`** — the production job.
  - **Schedule:** `cron: '0 8 * * *'` → **08:00 UTC daily** (≈04:00 EDT / 03:00 EST).
  - Also `workflow_dispatch` with a `retry_count` input (used by the self-retry loop).
  - Steps: checkout → Node 22 → `npm ci` → install Chromium → run `sentiment-scraper.ts`
    with `continue-on-error: true`. **No pre-scrape gate** (the cascade is its own gate).
  - **Self-retry harness:** retry step fires `if: always() && steps.scraper.outcome != 'success'`
    (so it fires even when an earlier step failed and the scraper was skipped), `sleep 900`,
    re-dispatches with `retry_count+1`, up to **`MAX_RETRIES=10`**. On exhaustion it sends a
    🚨 Telegram alert, then a final step re-fails the job. Needs `permissions: actions: write`.
- **`.github/workflows/test.yml`** — runs on **push/PR to `main`** + `workflow_dispatch`. Jobs:
  `test` (`test-tiers.ts`), `test-layer4` (`if: workflow_dispatch` only — **no Gemini spend on
  push/PR**), and `scrape` (needs `test`; runs the scraper with **`DRY_RUN=1` — no sheet write**).
- **`.github/workflows/watchdog.yml`** — `cron: '0 20 * * *'` (20:00 UTC) + dispatch. Runs
  `watchdog.ts`; if the sheet's last successful write is stale (>26h via F2 stamp, or >9d via
  A2 date) it re-dispatches `daily-scrape.yml` **once** and sends a 🚨 Telegram alert. Never
  retries itself (no loop). Catches silently-skipped crons. Needs `permissions: actions: write`.
- **`.github/workflows/probe-sources.yml`** — `workflow_dispatch` only. Curls every source
  from a real GHA runner and prints HTTP status + regex hits. Diagnostic for re-checking
  datacenter-IP access. **Probe result (2026-06-13, run 27451648730): all four sources
  returned 200 from GHA** — aaii.com (`Jun 10 30.4/22.0/47.7`, Imperva does not block GHA),
  Substack archive (200; sentiment post beyond newest 12 → `limit=30`), YCharts ×3 (200).
- **`.github/workflows/keepalive.yml`** — `cron: '17 3 1,15 * *'`. Empty `[skip ci]` commit
  only if the repo has been idle ≥ 40 days, to dodge GitHub's 60-day cron auto-disable.
  Unchanged. Needs `permissions: contents: write`.

---

## 4. Secrets & environment variables

| Var | Used by | Purpose |
|---|---|---|
| `GOOGLE_SHEETS_CREDENTIALS` | scraper (`writeToSheets`), watchdog | Full **service-account JSON** (as a string) for Sheets auth. Required to write. |
| `SHEET_ID` | scraper, watchdog | Target spreadsheet id. **Falls back to a hardcoded default** `1zQQ2am1yhzTwY7nx8xPak4Q0WoNMwxWj7Ekr-fDEIF4` if unset. |
| `GOOGLE_API_KEY` | Tier-1 layer4 + Gemini tests | Gemini Flash key. If absent, layer4 silently skips (Tier 0/2/3 + Tier-1 L1–L3 still work). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `lib/telegram.ts`, daily/watchdog alert steps | **Optional.** Reuse an existing bot's token. Absent → all alerts are logged no-ops (nothing breaks). |

- **Where secrets live:** GitHub Actions repo secrets (`GOOGLE_SHEETS_CREDENTIALS`,
  `GOOGLE_API_KEY`, `SHEET_ID`, and the two `TELEGRAM_*`). Locally, a `.env` file
  (gitignored) loaded via `dotenv`. The `GOOGLE_GENERATIVE_AI_API_KEY` and `BROWSERBASE_*`
  env vars were removed from the workflows (nothing read them).
- The service-account is `sheets-writer@gen-lang-client-0758527558.iam.gserviceaccount.com`
  (project `gen-lang-client-0758527558`). The target sheet must be shared with that account
  for writes to succeed.
- **NEVER** hardcode key values — the repo is public.

---

## 5. Gotchas / hard rules (highest-value section)

1. **🔴 LEAKED SECRETS — rotation may still be pending.** `credentials/sheets-writer.json`
   (a live service-account key) and `.env.bak` (real `GOOGLE_API_KEY`, `BROWSERBASE_*`,
   `SHEET_ID`) were **untracked from the working tree** on 2026-06-08 (`0f0ce38`) and their
   **blobs purged from git history** during the cascade work (see §6 for date). **A purge is
   not a rotation:** anyone who cloned before, or any fork, still has the old keys, and GitHub
   may serve orphaned commits by SHA until GC. **The real mitigation is rotation** — confirm
   the Gemini key and the `sheets-writer@gen-lang-client-0758527558` service-account key were
   rotated (and the Browserbase key deleted). If §6 still lists rotation as open, treat the
   old keys as live.
2. **The sheet write is a fixed-cell OVERWRITE, not an append.** `writeToSheets` writes
   `A2:D2`, `E2`, and `F2` only — it clobbers row 2 with the latest survey and never keeps
   history in the sheet. Row 1 is headers. Don't "fix" this into an append without checking
   downstream consumers.
3. **`delta = (bearish − bullish)` is a string `"x.xx%"`** written to `E2` with
   `USER_ENTERED`. A leading `-` makes Sheets treat it as text — intended; beware if a
   consumer expects a numeric delta.
4. **F2 is a freshness stamp (`updated <ISO> via <source>`).** The watchdog reads it.
   `writeToSheets` only writes F2 if F2 is empty or already a prior stamp (so it won't
   clobber an unrelated value a human put there); otherwise it skips the stamp and the
   watchdog falls back to the A2 survey date.
5. **Anti-regression guard:** before writing, `writeToSheets` reads A2 and **skips the write
   if the sheet's survey date is newer than the candidate's** (prevents a late retry that only
   reached a lagging backup — e.g. Substack runs ~1 week behind — from overwriting fresher
   data). It sends an INFO alert and returns without error.
6. **Backup-source freshness varies.** Tier 2 (Substack) typically lags the website by ~1
   week; Tier 3 (YCharts) is usually same-day. The freshness gate (≤14d) and tier ordering
   (first-party aaii.com first) handle this, but a Tier-2/3 win means the sheet may show a
   slightly older survey date than the website currently shows. A backup win sends an INFO alert.
7. **layer4 (Gemini) is gated on `GOOGLE_API_KEY`** — but it's now only one rung of Tier 1.
   No key just means Tier 1 leans on L1–L3; Tiers 0/2/3 are the real safety net.
8. **Two sum tolerances by design.** Tier-1 inline layer checks use `±1`; the shared
   `validate()` (`lib/validate.ts`) uses `±0.8` + freshness. A row can pass a layer but fail
   the final gate — expected.
9. **Node 22 in CI, `ts-node` everywhere.** No build artifact; `npm run build` does not exist.
10. **No longer a single point of failure.** Four independent sources back each other (probe
    confirmed all four reachable from GHA). If aaii.com changes markup, Tier 0/1 may miss but
    Tier 2/3 cover it (and you get an INFO alert). Tier-1 total failure still dumps
    `aaii-fail.png`/`aaii-fail.html` (gitignored).
11. **`fixtures/` are real captures pinned in time.** Offline tests freeze `now` at
    2026-06-12 so the fixtures never "age out" of the freshness gate. If you re-capture a
    fixture, keep the test's frozen `NOW` consistent with it.

---

## 6. Known issues / open items (owner action)

- **🔴 ROTATE THE LEAKED KEYS** (the one thing a history purge does NOT fix): Gemini
  `GOOGLE_API_KEY`, the `sheets-writer@gen-lang-client-0758527558` service-account key
  (create new → update `GOOGLE_SHEETS_CREDENTIALS` secret → delete old), and delete the
  Browserbase key. *(Mark done here once rotated, with date.)*
- **Add Telegram secrets** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) to enable alerts —
  optional; everything works without them (alerts are logged no-ops).
- **Resolved during the cascade work:** committed secrets untracked + history-purged;
  `node_modules`/`.DS_Store` untracked; push no longer writes the sheet (DRY_RUN); per-push
  Gemini spend gated off; `package.json` metadata fixed; unused deps removed.

---

## 7. File / module map

| Path | Role |
|---|---|
| `sentiment-scraper.ts` | **Tier 1 + orchestrator.** `setupBrowser`, `layer1DOMTable`/`layer2TextRegex`/`layer3Alternative`/`layer4VisionLLM` + `scrapeAAII` (all exported, unchanged), `writeToSheets` (3-try + anti-regression + F2 stamp), `runWorkflow` (the tier cascade). Runs only when invoked directly. |
| `lib/types.ts` | The shared `SentRow` type. |
| `lib/validate.ts` | `validate` (range + sum±0.8 + freshness), `parseSurveyDate`, `daysOld`. Single source of truth. |
| `lib/telegram.ts` | `alert(level, msg)` / `formatAlert` — dormant no-op without secrets. |
| `sources/aaii-http.ts` | Tier 0: `fetchAAIIHttp` + `parseAAIIHtml`; exports `CHROME_HEADERS`. |
| `sources/aaii-substack.ts` | Tier 2: `fetchSubstack` (API→RSS) + `parseSubstackBody`. |
| `sources/ycharts.ts` | Tier 3: `fetchYCharts` + `parseYChartsPage` + `assembleYCharts`. |
| `watchdog.ts` | Reads sheet F2/A2 freshness → STALE/FRESH + `$GITHUB_OUTPUT`. Used by watchdog.yml. |
| `test-validate.ts` | Offline: validate/date-parse + telegram no-op. |
| `test-sources-offline.ts` | Offline: Tier 0/2/3 parsers vs `fixtures/`. |
| `test-tiers.ts` | **CI gate** (`test.yml`). Live per-tier; exits 0 if ≥1 tier valid. |
| `test-layers.ts` | Live Tier-1 layer diagnostic (exit fixed: fails only if all layers fail). |
| `test-comprehensive.ts` / `test-gemini.ts` | Tier-1 layer modes / Gemini key check. |
| `fixtures/` | Real captured `aaii-sent-results.html`, `substack-post-body.html` for offline parser tests. |
| `package.json` | 4 real deps (`playwright`, `googleapis`, `@google/generative-ai`, `dotenv`); `test`/`test:tiers`/`scrape:aaii`/`watchdog` scripts. |
| `tsconfig.json` | CommonJS, `target es2018`, `lib: [es2020, dom, dom.iterable]`, `strict`. |
| `.github/workflows/daily-scrape.yml` | Daily 08:00 UTC cascade + self-retry (≤10×) + exhaustion alert. |
| `.github/workflows/test.yml` | Push/PR + dispatch: `test` (test-tiers), `test-layer4` (dispatch-only), `scrape` (DRY_RUN). |
| `.github/workflows/watchdog.yml` | 20:00 UTC freshness check → re-dispatch + alert. |
| `.github/workflows/probe-sources.yml` | Dispatch-only: curl each source from GHA, print status. |
| `.github/workflows/keepalive.yml` | Empty-commit keepalive (≥40-day idle guard). |
| `docs/superpowers/specs|plans/` | The cascading-fallbacks design spec + implementation plan. |
| `.gitignore` | Ignores `.env`, `credentials/*.json`, `aaii-fail.*`, `node_modules/`, `.env.bak`, `*.bak`. |
| `.vscode/launch.json` | "Scrape AAII" debug config (ts-node + `.env`). |
