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
- **Browser:** Playwright (headless Chromium).
- **Optional vision fallback:** Google Gemini (`gemini-2.5-flash`) via
  `@google/generative-ai`.
- **Sink:** Google Sheets API v4 via `googleapis` + a service-account.
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
GitHub Actions cron (daily-scrape.yml, 08:00 UTC)
        │
        ▼
 ts-node sentiment-scraper.ts  ──▶  Playwright headless Chromium
        │                                   │
        │                           goto AAII sentiment page
        │                                   │
        │            ┌──────────────────────┴───────────────────────────┐
        │            │  4-layer extraction cascade (first hit wins)       │
        │            │  L1 DOM table → L2 text/regex → L3 alternatives →  │
        │            │  L4 Gemini Flash vision (only if L1–L3 all fail)   │
        │            └──────────────────────┬───────────────────────────┘
        │                                   │ SentRow {date,bull,neu,bear,source}
        ▼                                   ▼
   validate(row)  ──fail──▶ throw → workflow retries (up to 10× / 15 min apart)
        │ ok
        ▼
   writeToSheets() ──▶ Google Sheets API v4 (service-account)
        ├─ A2:D2  = reportedDate, bullish%, neutral%, bearish%
        └─ E2     = delta = (bearish − bullish)%
```

### The 4-layer extraction cascade (`sentiment-scraper.ts`)
`scrapeAAII()` navigates once, then tries layers in order and returns the **first** layer
that produces a row passing the inline `sum ≈ 100` check. Each layer is `export`ed so the
test harness can call it in isolation.

1. **`layer1DOMTable`** — finds `<table>` rows whose first cell matches a `Mon DD` date
   pattern and parses cells 1–3 as bullish/neutral/bearish percents. The common path.
2. **`layer2TextRegex`** — scrapes `body` text + data-attribute elements with several
   regexes (plain `Mon DD 32.1% 18.1% 49.8%`, labeled `Bullish/Neutral/Bearish`, and a
   JSON-ish `"date":…"bullish":…` shape).
3. **`layer3Alternative`** — four sub-methods: (a) regex over full `page.content()` HTML,
   (b) `page.evaluate()` scanning inline `<script>` tags + `window.sentimentData` /
   `window.aaiiData`, (c) re-try the DOM table under a **mobile viewport** (375×667), and
   (d) `page.reload({waitUntil:"networkidle"})` then re-try the DOM table.
4. **`layer4VisionLLM`** — screenshots the full page, sends it to **Gemini 2.5 Flash** with
   a prompt to return `{"date","bullish","neutral","bearish"}` JSON, parses it (tolerating
   markdown code fences). **Skipped entirely if `GOOGLE_API_KEY` is unset.** This costs API
   credits, so it only runs as a last resort.

On total failure (`scrapeAAII` returns `null`) the scraper attempts to dump
`aaii-fail.png` + `aaii-fail.html` for debugging (both are gitignored), then the workflow
returns null → `runWorkflow()` throws → the job fails → the retry harness fires.

### Validation (the data-quality gate)
- Per-layer (inline in each layer): rejects a row unless `|bullish+neutral+bearish − 100| ≤ 1`.
- Top-level `validate()` in `runWorkflow()` (and mirrored in every test file): each percent
  must be 0–100 **and** the sum must be within **0.8** of 100, else it throws and nothing is
  written. **Keep these tolerances consistent** if you touch one — the test files duplicate
  the function verbatim.

---

## 3. How to run / test

### Local
```bash
npm ci
node node_modules/playwright/cli.js install --with-deps chromium   # CI install style
# or: npx playwright install chromium

cp .env.bak .env            # then fill in real values (see §4)
npm run scrape:aaii         # = ts-node sentiment-scraper.ts  (WRITES TO THE SHEET)
```
A VS Code launch config (`.vscode/launch.json`, **"Scrape AAII"**) runs the scraper under
`ts-node` with `envFile=.env`.

### Test harnesses (none write to the sheet)
| Command | What it does |
|---|---|
| `npx ts-node test-layers.ts` | Runs L1–L3 against the **live** AAII page; runs L4 only if L1–L3 fail. Exits non-zero only if all of L1–L3 fail. This is the CI gate in both workflows. |
| `npx ts-node test-comprehensive.ts` | Normal mode: L1–L3 vs live page, skips L4. |
| `npx ts-node test-comprehensive.ts --force4` | Uses a mock no-data page to drive the fallback path (L4 can't run on the mock). |
| `npx ts-node test-comprehensive.ts --layer4` | Standalone L4 test against the live page (**costs Gemini credits**). |
| `npx ts-node quick-test.ts` | Pure-offline unit test: feeds 3 canned HTML strings via `page.setContent` and asserts the L1–L3 recover/fail behavior. |
| `npx ts-node test-gemini.ts` | Sanity-checks that `GOOGLE_API_KEY` works (text + a 1×1-pixel vision call). |

### GitHub Actions (the only "deploy")
- **`.github/workflows/daily-scrape.yml`** — the production job.
  - **Schedule:** `cron: '0 8 * * *'` → **08:00 UTC daily**. (The inline comment says
    "= 04:00 EDT"; that's only true during US daylight time — it's 03:00 EST in winter.)
  - Also `workflow_dispatch` with a `retry_count` input (used by the self-retry loop).
  - Steps: checkout → Node 22 → `npm ci` → install Chromium → run `test-layers.ts` (gate) →
    run `sentiment-scraper.ts` with `continue-on-error: true`.
  - **Self-retry harness:** if the scraper step fails, the next step `sleep 900` (15 min)
    then POSTs to the GitHub API to re-dispatch this same workflow with
    `retry_count+1`, up to **`MAX_RETRIES=10`** (~2.5h of attempts). A final step
    re-fails the job so the run shows red. Needs `permissions: actions: write`.
- **`.github/workflows/test.yml`** ("Test Layers") — runs on **push/PR to `main`**. Three
  jobs: `test` (`test-layers.ts`), `test-layer4` (`test-comprehensive.ts --layer4`,
  **spends Gemini credits on every push/PR**), and `scrape` (needs `test`; actually runs
  `sentiment-scraper.ts` and **writes to the sheet on every push to `main`** — see Gotchas).
- **`.github/workflows/keepalive.yml`** — `cron: '17 3 1,15 * *'` (03:17 UTC on the 1st &
  15th). Makes an **empty `[skip ci]` commit only if the repo has been idle ≥ 40 days**,
  resetting GitHub's 60-day inactivity timer so the cron workflows never auto-disable.
  `workflow_dispatch` has a `force` boolean to commit regardless. Needs
  `permissions: contents: write`.

---

## 4. Secrets & environment variables

| Var | Used by | Purpose |
|---|---|---|
| `GOOGLE_SHEETS_CREDENTIALS` | scraper (`writeToSheets`) | Full **service-account JSON** (as a string) for Sheets write auth. Required to write. |
| `SHEET_ID` | scraper | Target spreadsheet id. **Falls back to a hardcoded default** `1zQQ2am1yhzTwY7nx8xPak4Q0WoNMwxWj7Ekr-fDEIF4` in `sentiment-scraper.ts` if unset. |
| `GOOGLE_API_KEY` | scraper L4 + Gemini tests | Gemini Flash key. If absent, L4 silently skips (L1–L3 still work). |
| `GOOGLE_GENERATIVE_AI_API_KEY` | (set in daily workflow only) | Mirror of `GOOGLE_API_KEY`; set as job env but the code reads `GOOGLE_API_KEY`. |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | nothing | Set in the daily workflow env and present in `.env.bak`, but **no source file reads them** (vestigial — see Gotchas). |

- **Where secrets live:** GitHub Actions repo secrets (`GOOGLE_SHEETS_CREDENTIALS`,
  `GOOGLE_API_KEY`, `SHEET_ID`, `BROWSERBASE_*`). Locally, a `.env` file (gitignored) loaded
  via `dotenv`.
- The service-account is `sheets-writer@gen-lang-client-0758527558.iam.gserviceaccount.com`
  (project `gen-lang-client-0758527558`). The target sheet must be shared with that account
  for writes to succeed.
- **NEVER** hardcode key values — the repo is public.

---

## 5. Gotchas / hard rules (highest-value section)

1. **🔴 SECRETS ARE COMMITTED TO THIS PUBLIC REPO.** Despite `.gitignore` listing
   `credentials/*.json` and `.env`, two real-secret files are **tracked in git**:
   - `credentials/sheets-writer.json` — a **live Google service-account private key**.
   - `.env.bak` — a `.env` copy containing real `GOOGLE_API_KEY`, `BROWSERBASE_API_KEY`,
     `BROWSERBASE_PROJECT_ID`, and `SHEET_ID` values.
   These were committed before/around the ignore rules, so `.gitignore` does nothing for
   them now. **Owner action required:** rotate the Gemini key, the Browserbase key, and the
   service-account key; `git rm --cached` both files (and purge from history); the sheet
   should be re-shared with a fresh service account. Do **not** assume these are dummy.
2. **`node_modules/` is committed (~10k files).** The repo vendors all dependencies into git
   and `node_modules` is **not** in `.gitignore`. CI still runs `npm ci` (which wipes/reinstalls
   it from the lockfile), so the committed copy is dead weight. Don't rely on editing the
   committed `node_modules`; change `package.json` instead. (`.DS_Store` is also tracked.)
3. **Pushing to `main` writes to the live sheet.** `test.yml`'s `scrape` job runs the real
   `sentiment-scraper.ts` with the real `GOOGLE_SHEETS_CREDENTIALS`/`SHEET_ID` on **every
   push and the daily cron also writes**. There is no dry-run guard. If you push code
   changes to `main`, expect a sheet write. Use a branch + PR if you don't want that.
4. **`test.yml` spends Gemini credits on every push/PR.** The `test-layer4` job calls the
   real vision model unconditionally. If cost matters, gate or remove that job.
5. **The sheet write is a fixed-cell OVERWRITE, not an append.** `writeToSheets` writes
   `A2:D2` and `E2` only — it always clobbers row 2 with the latest survey and never keeps
   history in the sheet itself. Row 1 is assumed to be headers. Don't "fix" this into an
   append without checking what downstream consumers expect.
6. **`delta = (bearish − bullish)` formatted as a string `"x.xx%"`** goes into `E2` with
   `valueInputOption: USER_ENTERED`. A leading `-` makes Sheets treat it as text, not a
   number — intended here, but be aware if a consumer expects a numeric delta.
7. **L4 is gated on `GOOGLE_API_KEY`.** No key → L4 returns null immediately, so the scraper
   depends on L1–L3 succeeding. That's fine in steady state but removes the safety net.
8. **Validation tolerances differ by layer.** Per-layer inline checks allow `±1`; the
   top-level/test `validate()` allows only `±0.8`. A row can pass a layer but fail the final
   gate. Keep that in mind when debugging a "scraped but threw" failure.
9. **Stale code comments — trust the code.** `scrapeAAII`'s comment says "runs all 3 layers"
   but it runs **4** (L4 was added later). Various test banners still say "3 layers". There
   is no "Layer 5"/Browserbase path despite the `@browserbasehq/stagehand` dependency.
10. **Vestigial dependencies.** `@browserbasehq/stagehand`, `cheerio`, and `zod` are in
    `package.json` but **not imported by any source file** (only `playwright`, `googleapis`,
    `@google/generative-ai`, and `dotenv` are actually used). Safe to leave, but don't assume
    they do anything.
11. **Node 22 in CI, `ts-node` everywhere.** No transpile/build artifact is produced or
    shipped; everything runs through `ts-node`. `npm run build` does not exist.
12. **AAII page is the single external dependency.** If AAII changes its DOM/markup, L1–L3
    can all silently miss and the run will lean on L4 (cost) or fail into the retry loop.
    The `aaii-fail.png` / `aaii-fail.html` artifacts (written on total failure, gitignored)
    are the first thing to inspect.

---

## 6. Known issues / open items (owner action)

- **Rotate & purge committed secrets** (see Gotcha #1): Gemini key, Browserbase key,
  service-account JSON, then `git rm --cached credentials/sheets-writer.json .env.bak` and
  scrub history.
- **Add `node_modules/` and `.DS_Store` to `.gitignore`** and `git rm -r --cached
  node_modules` to stop vendoring ~10k files.
- **Decide whether `main`-push should write to the sheet** (Gotcha #3) and whether the
  per-push Gemini L4 test (Gotcha #4) is worth the spend.
- **Clean up scaffolding:** `package.json` name/main/test fields, the unused `test.js`,
  and the unused deps still reflect a leftover template.

---

## 7. File / module map

| Path | Role |
|---|---|
| `sentiment-scraper.ts` | **The scraper.** `setupBrowser`, `layer1DOMTable`/`layer2TextRegex`/`layer3Alternative`/`layer4VisionLLM` (all exported), `scrapeAAII` (the cascade), `validate`, `writeToSheets`, `runWorkflow`. Runs only when invoked directly (`require.main === module`). |
| `test-layers.ts` | CI gate. Runs L1–L3 on the live page, L4 only if those fail. No sheet write. |
| `test-comprehensive.ts` | Test modes: normal (L1–L3), `--force4` (mock no-data page), `--layer4` (standalone live L4). No sheet write. |
| `quick-test.ts` | Offline unit test of L1–L3 recover/fail on 3 canned HTML inputs via `page.setContent`. |
| `test-gemini.ts` | Verifies `GOOGLE_API_KEY` (text + tiny vision call). |
| `test.js` | Empty stub (`// Function to reverse a string`). Unused. |
| `package.json` | Deps + the `scrape:aaii` script. Name/main/test are leftover scaffolding. |
| `tsconfig.json` | CommonJS, `target es2018`, `strict`, `outDir dist` (dist never built). |
| `.github/workflows/daily-scrape.yml` | Daily 08:00 UTC scrape + self-retry loop (≤10×). |
| `.github/workflows/test.yml` | Push/PR: `test`, `test-layer4` (paid), `scrape` (writes sheet). |
| `.github/workflows/keepalive.yml` | Empty-commit keepalive (≥40-day idle guard) to dodge GitHub's 60-day cron auto-disable. |
| `.vscode/launch.json` | "Scrape AAII" debug config (ts-node + `.env`). |
| `.env.bak` | **Committed secrets** (should be removed/rotated). |
| `credentials/sheets-writer.json` | **Committed service-account key** (should be removed/rotated). |
| `.gitignore` | Ignores `.env`, `credentials/*.json`, `aaii-fail.*` — but the above were committed before it took effect. |
