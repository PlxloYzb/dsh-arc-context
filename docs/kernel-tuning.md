# Kernel tuning inventory and protocol

ARC's compression core is the pinned `acp-kernel`. The kernel decides **when**
to nudge, what is protected, and what a valid compression is; ARC owns the
pressure geometry (Governor), the copy (prompt templates), and the durable
surface semantics. This document inventories every kernel knob, records what
ARC overrides today and why, and defines the protocol for moving a default —
**defaults move on evidence, never on intuition**.

## Inventory (kernel defaults from `defaultConfig()`)

| Knob | Kernel default | ARC surface | ARC ships | Status |
|---|---|---|---|---|
| `nudge.maxContextLimitPct` | 0.75 | `nudgeMaxContextLimitPct` | **0.70** | ARC override — forced nudge must fire below the host compaction-basic 0.80 auto line (documented in `src/index.ts` DEFAULT_CONFIG) |
| `nudge.emergencyThresholdPct` | 0.95 | `nudgeEmergencyThresholdPct` | **0.85** | ARC override — 0.95 leaves no room to act before the API rejects; live 384K/1M evidence |
| `nudge.minContextLimitPct` | 0.45 | `nudgeMinContextLimitPct` | kernel default | validation-only (growth-driven trigger has no percentage floor) |
| `nudge.frequency` | 5 | `nudgeCadenceTurns` | kernel default | first-class since 0.2.0-beta.4 — cadence vs. responsiveness is a per-workload tuning axis |
| `nudge.growthRatio` / `growthFloor` / `growthCap` | 0.05 / 50000 / 50000 | `coreOverrides.nudge` | kernel default | adaptive growth threshold; Governor suppresses growth nudges entirely when enabled |
| `nudge.minGrowthFloor` / `minGrowthRatio` | 20000 / 0.45 | `coreOverrides.nudge` | kernel default | anti-thrashing: suppress nudge unless growth ≥ floor |
| `nudge.tier2GrowthMultiplier` | 1.5 | `coreOverrides.nudge` | kernel default | tier-2 distillation trigger |
| `preserveRecentMessages` | 5 | `protectedRecentMessages` | kernel default | first-class since 0.2.0-beta.4; live test confirmed the protected zone correctly blocks over-eager compress on a young session |
| `preserveRecentTokens` | 5000 | `protectedRecentTokens` | kernel default | first-class since 0.2.0-beta.4 |
| `compress.minCompressRange` | 5000 | `minCompressChars` | kernel default | first-class since 0.2.0-beta.4 — the small-span vs. dense-block axis |
| `compress.maxSummaryLength` | 20000 | `coreOverrides.compress` | kernel default | per-call `summaryMaxChars` override exists for the model |
| `compress.minSummaryLength` | 50 | `coreOverrides.compress` | kernel default | — |
| `tiers.tier2Trigger` / `tier3Trigger` | 5 / 10 | `coreOverrides.tiers` | kernel default | — |
| `truncate.threshold` | 0.95 | `coreOverrides.truncate` | kernel default | — |
| `protectedTools` | `[]` | `coreOverrides` | kernel default | DSH protection is enforced upstream (protected tool outputs are hard-excluded from ranges) |

Everything stays reachable through `coreOverrides` (the escape hatch), so no
knob is ever blocked behind ARC's curated surface.

## What is already evidenced

- **0.70/0.85 nudge lines**: the host's compaction-basic auto line is 0.80;
  a forced ARC nudge at 0.75 would race it. Live sessions on rc.7 confirmed
  the ordering (nudge fires while Basic would still be silent).
- **Protected zone**: the 2026-08-18 live session saw the kernel reject a
  compress of `7..370` as entirely within the protected zone on a young
  session — exactly the intended guard.
- **Governor geometry** (input-budget pressure, output-intent preservation):
  the 384K live run and the paired quality/cost tables in
  `docs/adaptive-governor-validation.md`.

## Protocol for moving a default

1. Name the hypothesis (e.g. "protected zone 5 → 8 messages reduces
   re-compression churn without losing recall").
2. Paired A/B on the same seed: identical task, identical model, one knob
   difference; measure quality rubric + raw uncached input / output /
   cache-read + nudge/compress counts.
3. An independent holdout seed must confirm; a counterexample sends the knob
   back.
4. Record the run in `research/results/` and the rationale here; only then
   change the ARC default.

## Kernel divergence policy (maintainer, 2026-08-18)

ARC no longer tracks the acp-kernel author's upstream as a moving target:
the pinned copy is inlined into the shipped bundle, which already makes it a
vendored fork in fact. Local kernel modification is therefore ALLOWED when a
measured benefit exists, under this mechanism:

1. **Seam-first still wins**: when an ARC-side fix is semantically equivalent
   (e.g. the sequential batch application), keep it ARC-side — zero
   divergence beats documented divergence.
2. Kernel changes go through **pnpm patchedDependencies** (`pnpm patch
   acp-kernel`), so every delta is an explicit, re-appliable patch rather
   than an in-place edit.
3. Every patch is logged in `docs/kernel-divergences.md` (what / why /
   evidence / regression test / re-evaluation note for the next kernel
   upgrade), mirroring the DSH vendor divergence-log convention.
4. A regression test pins each divergence; `npm run check` must stay green.
5. The §4b upgrade SOP gains one step: re-apply or consciously drop each
   logged patch.

Current logged divergences: none (the batch protected-zone quirk is handled
ARC-side by protocol-correct sequential application; an upstream
per-range-protection-recomputation issue/PR with our fixture remains a
goodwill item, not an ARC requirement).

## Noise budget (related, enforced by tests)

Since 0.2.0-beta.9 the default system-prompt guidance is likewise the compact template (~2.7K chars vs ~7K, decision C / RQ6 v3: equal measured retention). Since 0.2.0-beta.4 the default nudge is compact (< 1,000 chars, tested):
the frame carries the percentage and advisory tone, the philosophy and
HOW-TO-COMPRESS rule texts live once in the system prompt, and the range
table shows the top suggestions with a one-line batch footer. Kernel
warnings with long id enumerations are capped in tool results.

Since 0.2.0-beta.5 that batch footer also carries the RQ2 cache-placement
note (single range → prefer the NEWEST suggested one; compressing every
suggested range in one call is always cheapest) — guidance text only, no
behavior; the nudge still fits the < 1,000-char budget.
