# Cascading Fallback Layers — Design Spec

**Date:** 2026-06-12
**Repo:** jalalchowdhury1/sentiment-scraper (public)
**Goal:** "If one fails, then another and then another" — at every level: data source, extraction, delivery, scheduling. Plus: alerting on total failure, and security cleanup. Everything reversible.

---

## 1. Problem (verified against code, not docs)

Today's robustness is extraction-deep but source-shallow:

| # | Weakness | Evidence |
|---|---|---|
| 1 | All 4 extraction layers scrape the same `aaii.com/sentimentsurvey/sent_results` page. AAII outage / IP block = total failure. | `sentiment-scraper.ts:380` |
| 2 | `daily-scrape.yml` runs `test-layers.ts` as a pre-scrape gate. The gate exits 1 if **any** of L1–L3 fails (`corePassed = every(ok)`), so one degraded layer kills the run even though the cascade would succeed. And on gate failure the retry harness never fires (its `if:` only checks the scraper step's outcome; failed gate = later steps skipped). | `test-layers.ts:144-157`, `daily-scrape.yml:43-52` |
| 3 | L4 (Gemini vision) silently self-disables when `GOOGLE_API_KEY` is absent/expired. | `sentiment-scraper.ts:284-288` |
| 4 | Sheets write is a single point of failure; one attempt, no retry, no alert. Scrape can succeed and the result is lost. | `sentiment-scraper.ts:419-453` |
| 5 | GitHub cron silently skipped May 28–30, 2026 (no runs at all). Nothing detects a missing day. | `gh run list` history |
| 6 | Secrets (`credentials/sheets-writer.json`, `.env.bak`) were untracked from the tree on 2026-06-08 (`0f0ce38`) but blobs remain recoverable from public git history (`git show 0f0ce38~1:credentials/sheets-writer.json`). Keys not yet rotated. | git history |
| 7 | `test.yml` writes the live sheet on every push to main and spends Gemini credits (`--layer4`) on every push/PR. | `test.yml:23-51` |

## 2. Verified source intelligence (probed 2026-06-12)

| Source | Verdict | Recipe |
|---|---|---|
| **aaii.com sent_results, plain HTTP** | Server-rendered ColdFusion HTML; full 21-row table in raw HTML, no JS needed, no JSON endpoint exists. Fronted by Imperva — datacenter-IP access **unverified**; must smoke-test from a real GHA runner. | GET with Chrome-like headers; regex `<td align="left" class="tableTxt">(Mon DD)</td>` + 3 right-aligned pct cells; first match = latest week; validate sum≈100. |
| **insights.aaii.com (AAII's own Substack)** | **Best backup.** First-party, posted Thursdays, zero lag. Three formats: JSON API, RSS, HTML. Boilerplate text is regex-stable. Jun 11 values (30.4/22.0/47.7) cross-confirmed vs 5 republishers. Substack has light Cloudflare; smoke-test from GHA. | `GET /api/v1/archive?sort=new&limit=12` → filter titles starting "AAII Sentiment Survey" → `GET /api/v1/posts/{slug}` → regex `body_html`: `/[Bb]ullish sentiment.*?(?:to|at)\s+([\d.]+)%/` (same for neutral/bearish). Fallbacks: `/feed` RSS, then canonical post URL. |
| **YCharts indicator pages** | Emergency backup. Latest value + "Wk of <date>" server-rendered in page summary text. Cloudflare risk, unverified from datacenter. | 3 GETs: `/indicators/us_investor_sentiment_{bullish,neutral,bearish}`; regex `/is at\s+([\d.]+)%/` + `/for Wk of (\w{3} \d{2} \d{4})/`. |
| Wayback Machine | **Rejected** — snapshots ~10 weeks stale, months apart; can never pass freshness gate. |
| MacroMicro / Seeking Alpha / Nasdaq Data Link / FRED | **Rejected** — paid API / aggressive 403s / discontinued / not carried. |

## 3. Design

### 3.1 Source-tier cascade (in-process, first valid + fresh wins)

```
Tier 0  aaii.com plain HTTP + regex          sources/aaii-http.ts      (new, ~2s, no browser)
Tier 1  aaii.com Playwright L1→L2→L3→L4      sentiment-scraper.ts      (today's cascade, code untouched)
Tier 2  AAII Substack JSON → RSS → HTML      sources/aaii-substack.ts  (new, first-party backup)
Tier 3  YCharts ×3 pages                     sources/ycharts.ts        (new, third-party emergency)
```

- Each tier returns `SentRow | null` and never throws outward (errors logged per-tier).
- `SentRow.source` records which tier/method won (already a field today).
- Orchestrator (`runWorkflow` in `sentiment-scraper.ts`) tries tiers in order; existing exports (`layer1DOMTable` … `layer4VisionLLM`, `scrapeAAII`) keep their signatures so all existing tests keep working.

### 3.2 Validation & freshness (`lib/validate.ts`, single shared copy)

- Range: each pct 0–100. Sum: |sum−100| ≤ 0.8 (same tolerance as today; per-layer inline checks stay at ±1).
- **NEW freshness gate:** survey date must be ≤ 14 days old (covers a holiday-skipped week); if > 8 days, attach an info note to logging/alerting. Date parsing: "Jun 11" (no year) → nearest past occurrence; Substack `post_date` is ISO; YCharts "Wk of Jun 04 2026" is explicit.
- **NEW anti-regression guard:** before writing, read current `A2`; if the sheet's survey date is newer than the candidate row's, skip the write (prevents a late retry with backup-source data clobbering fresher data) and send info alert.
- Centralizing `validate()` removes the verbatim copies in `test-layers.ts` / `test-comprehensive.ts` / `quick-test.ts` (AGENTS.md's "keep tolerances consistent" rule becomes structural).

### 3.3 Delivery hardening (`writeToSheets`)

- 3 attempts with backoff 5s → 15s → 45s.
- Unchanged: `A2:D2` + `E2` writes, `USER_ENTERED`, delta format. (AGENTS.md gotcha #5/#6 respected — no schema change to consumer cells.)
- **Additive:** `F2 = "updated <ISO-UTC> via <source>"` — implementation must first read `F1:F2` and only claim column F if empty; otherwise fall back to the first empty column in row 2 and record the choice in AGENTS.md. F2 is what the watchdog reads.
- On final write failure: CRITICAL Telegram alert that **includes the scraped numbers** so the data is recoverable by hand.

### 3.4 Alerting (`lib/telegram.ts`)

- Secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (user reuses existing bot). Code **no-ops silently when secrets are absent** — dormant-safe.
- Exactly three alert kinds:
  1. CRITICAL — all tiers failed, sent only on the final retry (workflow-level `curl`, so it fires even if `npm ci` is what broke).
  2. CRITICAL — Sheets write failed after 3 attempts (includes data).
  3. INFO — a backup tier (≥2) won, or data older than 8 days, or anti-regression skip. Means "primary path degrading, look when convenient."

### 3.5 Workflow changes

**`daily-scrape.yml`:**
- **Remove** the `test-layers.ts` gate step (fixes weakness #2; the cascade is its own gate).
- Retry step condition becomes `if: always() && steps.scraper.outcome != 'success'` — fires on scraper failure **and** on earlier-step failure (scraper outcome `skipped`). Keep `MAX_RETRIES=10`, 15-min sleeps.
- Add final-retry Telegram alert step (plain `curl`, no Node dependency).
- Remove vestigial env: `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `GOOGLE_GENERATIVE_AI_API_KEY` (verified unused by any source file).

**`watchdog.yml` (new):** cron `0 20 * * *` (20:00 UTC daily) + dispatch. Runs `watchdog.ts`: reads `F2` (fallback: parses `A2` date) via Sheets API; if last successful write > 26h old → re-dispatch `daily-scrape.yml` once + CRITICAL Telegram alert. Catches silent cron skips (weakness #5). Watchdog never retries itself — no loop risk; two independent crons both silently skipping is far rarer than one.

**`test.yml`:**
- `scrape` job → runs with `DRY_RUN=1` (new env understood by the scraper: full cascade, **no** sheet write, no alerts). Fixes weakness #7a — pushes stop writing the live sheet.
- `test-layer4` job → gated `if: github.event_name == 'workflow_dispatch'` (trigger added). Fixes #7b — no more Gemini spend per push.

**`probe-sources.yml` (new, dispatch-only):** curls each tier's endpoint from a real GHA runner with the production headers, prints status codes + whether the regex matches. Run **first** during implementation to confirm datacenter-IP access (the one thing local probes couldn't prove); kept for future re-probing. If Tier 0 gets 403 from GHA, Tier 0 stays in the code (it costs ~2s) but expectations are documented in AGENTS.md.

**`keepalive.yml`:** unchanged (verified correct).

### 3.6 Fix `test-layers.ts` exit logic

Exit non-zero only when the *cascade as a whole* would fail (no layer produced valid data), not when any single layer fails. Per-layer results stay in the report for diagnostics.

### 3.7 Security cleanup (history purge LAST, after green runs)

1. User-only: rotate Gemini key; delete Browserbase key (vestigial); create new service-account key → update `GOOGLE_SHEETS_CREDENTIALS` secret (sheet sharing unchanged if same SA email). Checklist will be provided with exact consoles/commands.
2. Repo: `git filter-repo` purge of `credentials/sheets-writer.json`, `.env.bak`, and historical `node_modules/` blobs → force-push. Pre-req: local bundle backup exists. Note in AGENTS.md: purge does not clear GitHub's cached views/forks — rotation is the real mitigation; purge is hygiene.
3. AGENTS.md: correct stale claims (secrets already untracked; gate behavior; "3 layers" comments), document the new architecture.

### 3.8 Rollback plan (hard requirement)

- **Before any change:** `git tag v1-pre-cascade && git push origin v1-pre-cascade`; `git bundle create ../sentiment-scraper-pre-cascade.bundle --all` (kept locally; contains true original history).
- Phased, individually-revertible commits: (1) workflow safety fixes + spec, (2) probe workflow + probe run, (3) lib/ + sources/ modules with offline tests, (4) orchestrator integration + dry-run verification, (5) watchdog, (6) docs/AGENTS.md, (7) history purge (last, separately).
- Old behavior preserved inside new code: Tier 1 is today's scraper verbatim; reverting any phase restores prior behavior; full reset = `git reset --hard v1-pre-cascade` + force push (solo repo).
- The history purge rewrites SHAs (including the tag) but file contents are preserved; the bundle is the byte-perfect escape hatch.

### 3.9 Testing

- `quick-test.ts` (offline) keeps passing unchanged.
- New offline fixture tests per source module: captured real HTML/JSON (probe evidence: `/tmp/aaii_sent_results_raw.html` etc.) checked into `fixtures/` — parser regression tests that run with zero network.
- New `test-tiers.ts`: live per-tier diagnostic (PASS/FAIL per tier; exit 0 if ≥1 tier passes). Replaces `test-layers.ts` as the PR gate; `test-layers.ts` retained as a Playwright-layer diagnostic with fixed exit logic.
- E2E on PR: `DRY_RUN=1` full run.
- Verification before "done": probe workflow results read; one manual `workflow_dispatch` of daily-scrape observed green end-to-end; watchdog dispatched once manually; Telegram alert test-fired once (then silence).

## 4. Out of scope

- Sheet history/append tab (AGENTS.md gotcha #5 — consumers expect row-2 overwrite).
- Browserbase/stagehand integration (vestigial dep stays unused or gets removed from package.json).
- Multi-asset/multi-survey expansion.

## 5. Decisions log

- Backup sources allowed: **yes** (user, 2026-06-12).
- Total-failure behavior: **Telegram alert + keep last value** (user).
- Alert plumbing: **reuse existing bot token** (user).
- Security cleanup: **in scope** (user).
- Everything else delegated to implementer with rollback guarantee (user, 2026-06-13 00:19 UTC).
