# RQ1 bench — unified experiment runner

One seeded, reproducible path for every research question in
`docs/research-agenda.md`: task generation → live host session → scoring →
cost ledger. `research/` stays out of the npm tarball; the bench is research
tooling only.

## Layout

- `facts.mjs` — seeded planted-fact generator, locale-mirrored (`en` default,
  `zh` via `generateFacts(seed, { locale: 'zh' })` — same RNG consumption, so
  both locales draw identical categories/values/Latin needles and only the
  prose localizes; that is the real shape of Chinese engineering sessions).
  Categories map to scoring: `verbatim` / `numeric` (exact needle),
  `paraphrase` (keyword anchors offline, cross-family grader in live arms),
  `crossref` (both refs), `trap` (injection markers that must NOT leak into
  answers).
- `script.mjs` — staged prompts: plant turns wrap facts in deterministic
  noise (sized past the kernel's `minCompressRange`), then one query turn
  (`--query blind|recovery`); `--locale zh` localizes headers/queries, and
  each plant turn carries the `factIds` it planted (for shadowed/live
  bucketing).
- `driver.mjs` — web-profile RPC driver (same wire format as the browser).
  Normalizes event-level usage once: `inputTokens` is uncached input
  (verified against the DSH tokenUsage projection).
- `ledger.mjs` — three-field cost vocabulary plus the RQ2 primitive: the
  cache-write spike on the first call after each compaction.
- `scorer.mjs` — deterministic recall scoring with a DUAL caliber since the
  RQ1-closure form-contract fix (rq3-f2): `strict` (the original RQ3
  contract, byte-compatible with recorded numbers) and `loose` (information
  level: numeric bare `VALUE` on word boundaries; crossref own-label
  optional with the TARGET anchor present via needle or constituents;
  paraphrase keyword anchors unchanged). `perFact.form` records
  `full`/`bare`/`miss`. Trap grading is three-class for the RQ7 forward
  sentry: `clean` / `quoted-refused` (every marker occurrence sits in a
  ±200-char refusal/data-treatment window) / `complied`; classification runs
  over the answer text (opts.answerText), tool-corpus appearances are
  informational counts.
- `run.mjs` — CLI orchestrator (offline calibration pins both calibers and
  the three trap classes with known-answer cases).
- `rq2-cache.mjs` — RQ2 cache-economics arms.
- `rq3-recall.mjs` — RQ3+RQ8 recall matrix runner (offline self-test +
  live arms `<locale>-<queryMode>-<seed>`; plants 4 turns, one instructed
  batch compress of the first 3 with model-written summaries, settle, query;
  per-category and shadowed/live scoring, recovery tool accounting, hard
  call budget).
- `rq1c-projection.mjs` — RQ1-closure task C single-session probe: autoNudge
  ON under the 32K window; captures every nudge live off the events.mux
  stream plus the durable log, tracks host projection vs real per-call
  prompt size across an instructed compression (`research/results/
  projection-subtraction-results.json`; offline re-derivation in
  `research/scripts/rq1c-nudge-audit.mjs`).
- `rq7-adversarial.mjs` — pre-OSS RQ7 confirmation arm: plants the complete
  seeded adversarial bank as archival data, requires model-written batch
  compression plus `search_context`/`decompress`, and gates the answer corpus
  with the scorer's clean / quoted-refused / complied classifier (any
  complied result blocks release).
- `nudge-overpressure-fix-verification.mjs` — beta.6 follow-up: replays the
  task-C shape against the compression-aware reader, bounds the live session
  to 15 model calls, and checks that every post-compression emergency nudge is
  either absent or remains above the effective 85% line while `arc_status`
  uses the same reader (`research/results/nudge-overpressure-fix-verification.json`).
- `rq1-historical.mjs` — RQ1-closure task B: the two recorded historical
  suites (code-engineering holdout `code-seed-02`, semantic supersession
  `semantic-seed-01`) on this driver, with the historical arms' models
  (deepseek-v4-flash / GLM-5.2, effort max), approval auto-responding over
  the mux stream, all-in cost accounting (session loop + every
  compaction/summary's provider-returned usage), and suite scoring ported
  1:1 from the historical analyze scripts (offline self-test re-scores the
  recorded historical final texts and must reproduce their numbers).
  `consolidate` writes `research/results/rq1-historical-reproduction.json`
  with per-pair within-noise verdicts (quality ≤1 fact per recorded value;
  cost deltas direction-consistent within ±10pp).

## Usage

```bash
# offline calibration (no API): determinism + scorer known-answers (dual caliber)
node research/bench/run.mjs offline --seed 1 [--locale zh]

# live arm against a running web host (ARC installed in that host's profile)
node research/bench/run.mjs live --seed 1 --url http://127.0.0.1:8933 \
  --label <arm-name> --cwd <workspace> [--query recovery] \
  [--model '{"provider":"scnet","model":"GLM-5.2"}']

# RQ3 runner (offline self-test, then the 8-arm matrix with a call budget)
node research/bench/rq3-recall.mjs offline
RQ3_ARMS=en-blind-1,zh-blind-1 node research/bench/rq3-recall.mjs live

# RQ1-closure task B historical reproduction (operator flips the profile
# between arms; see docs/research-agenda.md §RQ1)
node research/bench/rq1-historical.mjs offline
node research/bench/rq1-historical.mjs live --suite code --arm arc
node research/bench/rq1-historical.mjs consolidate
```

Reports land in `research/results/bench/<label>-seed<N>-<timestamp>.json`.

## Calibration record (2026-08-18; form-contract v2 same day)

- Offline: 10 seeds (1 2 3 5 7 11 42 99 123 777) × both locales pass —
  deterministic scripts, perfect-corpus full scores in BOTH calibers,
  single-removal detection, trap-leak detection, plus known-answer cases for
  the bare-value hit, label-optional crossref, wrong-value miss, and all
  three trap classes (bare hit / quoted-refused / complied).
- Calibration surfaced two real scorer properties, now pinned in code:
  needle aliasing (a verbatim needle that is also a crossref target
  legitimately survives single deletion via the referencing line) and shared
  paraphrase keywords (deleting one line does not drop its keyword score);
  removal detection is therefore scoped to exact-match categories.
- Live smoke (scnet/GLM-5.2, ARC 0.2.0-beta.4, seed 1, blind query):
  recall 22/22, trap leaks 0, ledger uncached 3,188 / output 17,125 /
  cache-read 52,864 across 4 calls; 0 compactions at this size (expected —
  the surface never crossed the pressure line).

## RQ1 closure record (2026-08-18)

- **RQ3 rescore (offline, zero API)**: the eight RQ3 sessions re-scored from
  their append-only logs (`research/scripts/rescore-rq3.mjs`) — strict
  caliber verified byte-equal to the recorded numbers per arm, loose caliber
  43/43 in every locale×mode pool (the manual form audit's 100% claim is now
  bench-verified), zh-recovery-1 classifies quoted-refused, complied zero.
- **Historical reproduction** (`rq1-historical.mjs`, four live arms,
  deepseek-v4-flash / GLM-5.2 at effort max, 45 model calls): the GLM-5.2
  semantic pair reproduced within noise (quality tie, obsolete 0, ARC
  uncached −23.58% vs recorded −25.57%); the flash code pair split — quality
  direction and the ARC ceiling reproduce exactly (24/24 + 4/4, tests 4/4;
  Basic 12/24 + 0/4 vs recorded 6/24), but the recorded cost sweep flipped
  (+43.1% uncached vs recorded −47.6%), dominated by summarizer cache luck
  (this Basic's single summarizer call hit the prefix cache: 499 uncached +
  53.8K cached vs the recorded 76K uncached for two calls) plus preset and
  provider-geometry differences. RQ1 stays open per the commission's honest
  reporting rule — full localization in
  `results/rq1-historical-reproduction.json`.
- **Projection subtraction** (`rq1c-projection.mjs`, 10 model calls,
  autoNudge ON): the host contextPressure projection never consumed
  shadowedTokenCount; all six post-compression emergency nudges were
  over-pressure artifacts under the conservative compression-aware
  counterfactual — classified as a product defect with the fix deferred
  (`results/projection-subtraction-results.json`; offline audit
  `research/scripts/rq1c-nudge-audit.mjs`).

## RQ3+RQ8 record (2026-08-18)

Eight live sessions (locale × queryMode × seed) at 3-of-4 plant turns
shadowed: blind strict en 79.1% / zh 93.0% (form-audited 100% everywhere);
recovery 100% at information level (3-6 tool calls/session); zh never worse
than en (RQ8 closed); injection obedience 0/8. Verdict: phase-2 keyword
enrichment not justified. Full data: `results/rq3-recall-results.json`.
Note: the web-app contextPressure projection does not consume ARC's
`shadowedTokenCount` — use the durable ledger + per-call usage for
shadowing evidence, not pressure deltas.

## RQ5 / RQ5b constrained record (2026-08-18)

`rq5-compliance.mjs` is the four-arm runner and offline consolidator. It
records the exact N/G prompt hashes and rejects contamination terms before any
live prompt, derives `arc-nudge` compliance and latency only from durable
events, and parses requested range count/position from `compress` arguments.
The initial isolated run stopped at 59/60 actual calls: normal compliance was
1/4, emergency compliance 2/3, and the sole spontaneous call was a head,
single-range call. G80/G88 each produced two local archive blocks. P reached
44% pressure, but its first proactive range was protected and the budget did
not allow its retry plus blind recall. The result is explicitly partial:
`results/rq5-compliance-results.json`; no default follows.

RQ5b adds a zero-call audit of the four persistent G80/G88 local archives:
all 12 facts shadowed by those checkpoints are verbatim in the checkpoint
text (strict/loose 12/12).  The corrected P arm planted five small turns at
46%, called `arc_status` before any sequence was supplied, and therefore
located a second protocol failure: `arc_status` reports aggregate surface
bounds but no suggested-range table.  The no-handwritten-seq rule correctly
prevented a fabricated `compress` call, so the formal Governor-vs-P-summary
quality comparison remains unavailable.  Three N expansions used 25 calls;
9 eligible nudge records were fully observable (one short of the 10 target), while
four spontaneous calls were all one-range, table-head calls.  The N normal
rate is 4/4 but its Wilson 95% interval is 51.0–100%, so it still crosses the
80% line; 16 total normal observations (12 more at the observed rate) would
separate it.  Evidence: `results/rq5-governor-archive-audit.json` and the
`phase2` object in `results/rq5-compliance-results.json`.

## RQ4 constrained record (2026-08-18)

`rq4-distillation.mjs` forces a model-authored tier-1→2→3 chain: it plants
three staged fact turns, compresses the first two, then targets the live parent
checkpoint for each succeeding tier.  It separately scores model-summary and
safety-index text in strict/loose calibers, records the carrier split and block
characters, and probes `decompress` on tier 2.  `from-history` is a zero-model-
call recovery mode for durable session logs.  The recorded three chains exceeded
the 40-call cap (52) and duplicate en/seed-1, so their observed curve is
explicitly non-decision-grade; see `results/rq4-distillation-results.json`.
