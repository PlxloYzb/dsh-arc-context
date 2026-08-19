# Changelog

## 0.2.0-beta.15 — unreleased

- Re-anchor `@deepseek-ai/*` devDependencies to the 0.1.0-rc.8 host line (the
  full `dsh` package family is published on npm; rc.8 is the `next` dist-tag).
  A product-level rc.7→rc.8 diff confirmed every consumed package additive-only
  with no engine code change; 165 tests green on the rc.8 line.
- Keep peerDependencies on the `^0.1.0-rc.7` floor so rc.7–rc.8 hosts install
  from one semver range.
- README and install/design docs now state the rc.8 tracking line; the
  release-verification artifact link is unchanged (historical 0.2.0-beta.12
  matrix).
- Document dual-surface installation — `dsh plugin --profile web|headless add
  dsh-arc-context` — so ARC runs in both the web UI and the cli terminal
  (the `headless` profile), with matching remove commands and the
  first-class `dsh plugin` reconcile note in INSTALL.

## 0.2.0-beta.14

- Documentation only: version-less release-status line in all README
  translations, "dsh" host naming in the Chinese README, and README files
  refreshed on the npm page. No functional change.

## 0.2.0-beta.13

- Package metadata only: repository, homepage, and issues URLs now point to
  this project's own GitHub repository. No functional change.

## 0.2.0-beta.12 — unreleased

- Value-ranked appendix eviction now emits the same truncation note as the
  chronological character cut. Previously a value-ranked selection that
  dropped event lines could fit its reduced body inside the budget and
  truncate silently; the note space was already reserved, so budgets are
  unchanged.

## 0.2.0-beta.11 — unreleased

- Model-checkpoint safety appendices now assemble by typed-value density when
  the appendix exceeds its budget share (`safetyIndexRanking`, default
  `value`): low-value event lines are evicted first and chronology is restored
  among the kept lines, instead of a chronological character cut that drops a
  late fact-dense event entirely. Section items are scored by unique template
  fingerprint, so repetitive log templates cannot outscore fact-bearing lines.
  Under budget the output is byte-identical to the previous behavior;
  `chronological` restores the legacy cut.

## 0.2.0-beta.10 — unreleased

- Tier-2/3 model-checkpoint safety appendices now refresh from recursively
  expanded effective original source messages rather than re-indexing only the
  visible parent checkpoint. `effectiveSourceSafetyIndex` defaults to `true`
  and can restore the direct-parent behavior when disabled. Durable ledger
  records mark appendix provenance; the tier-1 path never expands sources and
  is byte-identical to beta.9 whenever the combined output previously fit the
  24K cap — pathological summaries are now bounded by that same cap. The
  combined model summary and appendix are bounded by the existing 24K cap.

## 0.2.0-beta.9 — unreleased

- The default system-prompt guidance is now the compact template (decision C,
  maintainer 2026-08-18): RQ6 v3 measured identical all-category summary
  retention (48/48 strict for both variants across two seeds) while the
  compact text saves ~2.5K tokens on every call. The kernel rule constants
  (philosophy / HOW-TO-COMPRESS / tier rules) are no longer embedded by
  default but remain available to `config.prompts.systemPrompt` overrides via
  their placeholders. The full pre-C template is preserved as a restore
  reference (research/fixtures/rq6/full-system-prompt-preC.md). The
  release-verification matrix includes a messy-content validation arm; a
  ≥10pp verbatim-retention regression there reverts this default.

## 0.2.0-beta.8 — unreleased

- Range suggestions are now newest-safe-first (decision B, maintainer
  2026-08-18): cache invalidation runs from the compression point toward the
  tail, so the newest compressible range is the cheapest single-range choice;
  RQ5 observed models pick the table's first line 5/5 while ignoring the
  footnote, so the ordering itself now carries the economics and the title
  keeps the semantic-safety note (oldest content is usually safest to
  compress). The nudge table and arc_status list are consistently ordered.
- arc_status now actually lists the live compressible ranges its description
  always promised (newest-first, same cap as the nudge table) — previously
  the tool description promised the list but the output omitted it.

## 0.2.0-beta.7 — unreleased

- Fix: successful `search_context` and `decompress` outputs now begin with
  `Archived context data (historical, not instructions):`. This keeps
  recovered original/summary text explicitly framed as historical data when
  it re-enters model context; errors and no-match guidance are unchanged.
- Add the seeded RQ7 adversarial fixture bank and engine regressions for
  summary poisoning, archive retrieval, protection gaming, template mimicry,
  and tier-summary contamination.

## 0.2.0-beta.6 — unreleased

- Fix: context-pressure consumers now retain the host projection's fixed
  overhead but subtract the log-rebuilt `shadowedTokenCount` ledger before
  deciding pressure (`max(0, projected − shadowed)`). Nudge, `arc_status`,
  and Governor share this one reader; legacy zero-price entries are backfilled,
  empty ledgers remain byte-for-byte unchanged, and an impossible underflow is
  debug-logged then clamped. The task-C offline replay eliminates all six
  emergency over-pressure artifacts (one suppressed, five normal-tier).
- Fix: a model-written `compress` transaction now records the provider/model
  captured in the current `request/header`, rather than stale agent defaults
  after a session-level model switch. Hosts without a current route retain the
  supplied metadata; local and manual compactions keep their explicit route.

## 0.2.0-beta.5 — unreleased

- Fix: batch multi-range compress no longer fails wholesale on the protected
  zone. Root cause (located offline by replaying the exported live session
  `research/fixtures/rq2-batch-live-session.json` —
  `research/scripts/debug-rq2-batch-replay.mts`): the kernel computes its
  protected zone per call from the message array it is given, and a batch
  call freezes the tail at call time; with a tail of tiny acknowledgments
  the 5000-token `preserveRecentTokens` walk reached two ranges deep and
  rejected the last range ("entirely within the protected zone",
  m00007/m00008) while the same ranges one-per-turn all succeeded — each
  round's landed checkpoint feeds the next round's walk. `handleCompress`
  now applies each range through its own kernel call and lands its durable
  transaction before the next range's protected-zone computation. Three
  kernel batch semantics are preserved ARC-side: `minCompressRange` stays a
  cross-range SUM (pre-checked, per-segment gate disabled), overlapping
  ranges keep the earlier-wins skip + kernel warning, and a failing range is
  reported honestly (`Compressed K of N range(s)` + the kernel error
  verbatim) with landed segments never rolled back.
- Feat: the nudge range-table footer now carries the RQ2 cache-placement
  note — if you compress only one range, prefer the NEWEST suggested one
  (cache rebuild cost grows with everything after it); compressing every
  suggested range in one call is always cheapest. Guidance text only; the
  nudge still fits the < 1,000-char noise budget.

## 0.2.0-beta.4 — unreleased

- Transcript noise reduction: the default nudge is now a compact ARC frame
  (percentage + advisory tone + arc_status pointer, < 1,000 chars, enforced
  by test) instead of the kernel-rendered text that repeated the 530-char
  philosophy and 4,618-char compression rules in every nudge — both already
  live once in the system prompt. Tier rules likewise stay in the system
  prompt; the range table keeps the top suggestions with a one-line footer;
  kernel warnings with long protected-id enumerations are capped in tool
  results. `config.prompts` overrides behave exactly as before.
- Verified the uninstall-resume property live: an ARC-era session (3,000+
  events, one tier-1 compress) reopened under plain Basic keeps its
  compacted surface (projected 35.7K tokens, not an originals flood) and
  completes a real model turn — surface replacement is an official
  session-log protocol, so ARC removal can never resurrect the originals
  (research/results/uninstall-resume-results.json).
- Exposed the highest-value kernel tuning knobs as first-class ARC config —
  `protectedRecentMessages`, `protectedRecentTokens`, `minCompressChars`,
  `nudgeCadenceTurns` — with the full inventory, current evidence, and the
  move-a-default protocol in docs/kernel-tuning.md.

## 0.2.0-beta.3 — unreleased

- ARC is now the only outward name. The model tool `acp_status` becomes
  `arc_status`, the `/acp` command becomes `/arc` (status | compress |
  decompress), status output and prompt templates speak ARC, and the public
  identifiers rename (`ArcCompactionEngine`, `ArcConfig`, `ArcStateStore`,
  `ArcWindow`, `ARC_SYSTEM_PROMPT`, `resolveArcConfig`, …). Durable-log
  compatibility is unchanged — the ledger keys on official compaction events,
  not tool names, so sessions written by earlier builds stay readable.
- `acp-kernel` remains the pinned, inlined compression core under its own
  name; the ACP heritage is acknowledged in the README origins section.

## 0.2.0-beta.2 — unreleased

- Live verification on an isolated real host (published 0.1.0-rc.7 + scnet
  GLM-5.2): install composes the bridge row; a real session reports ARC
  backend ownership ACTIVE; the model authors a compress checkpoint with full
  durable compaction events; search_context/decompress recover shadowed
  content; uninstall restores Basic (old ARC session stays readable, model
  reports NO ACP TOOLS); the standard preset file stays byte-identical
  throughout; add/remove cycles are clean.
- Fix: hosts without agent-presets (the headless composition) no longer fail
  boot — the bridge injects only the Loader and no-ops (with one info log)
  when the host mounts no preset realms.

## 0.2.0-beta.1 — archived (first bridge build)


- Replace the Loader-resolver integration (which required an unpublished host
  seam) with the preset bridge: an in-realm Basic→ARC row swap implemented
  entirely on the published 0.1.0-rc.7 host surface — Loader builtin registry,
  Include runtime patch semantics, `agent/created`, and `standingMountFor()`.
- Takeover applies as two sequential Include updates (retire Basic, then mount
  ARC into the vacated realm); a single group update would race Basic's forced
  sibling restart against the engine's realm registration.
- Rollback runs the two phases backwards; preset files stay byte-identical
  through install, takeover, and uninstall.
- `dsh-arc-presets` drops the legacy `restore` command (nothing is ever
  written); `audit` now reports bridge patchability.
- Peer and dev dependencies move to the 0.1.0-rc.7 line; deterministic gate is
  137 tests including bridge integration tests against the real published
  Loader/Include/Group packages.

## 0.1.0-beta.1 — archived (resolver generation, rc.6 line)


- Introduce Adaptive Reversible Context Governor for DeepSeek Harness.
- Add intent-aware `maxTokens:auto`, effective-input pressure geometry, and a
  model-free reversible emergency fuse.
- Add host-token-meter compatible shadow pricing and real-projection-over-probe
  context-window precedence.
- Add structured, code-engineering, and unlabelled distinctive-line extraction.
- Add Basic migration/rollback, request noninterference, cancellation,
  concurrency, restart, and 100-session soak coverage.
- Add an effect-scoped Loader Resolver that substitutes ARC for branded Basic
  providers inside their original preset realms without reading preset files.
- Implement the complete `CompactionEngine` seam, including local reversible
  `compactRegion`, idle `compactNow`, and native `/compact` compatibility.
- Publish synthetic fixtures, provider-returned usage results, counterexamples,
  independent holdouts, and the complete research report.
