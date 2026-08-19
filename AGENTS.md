# dsh-arc-context — Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**dsh-arc-context** is Adaptive Reversible Context (ARC) for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), delivered as a `CompactionEngine` backend. It independently evolves the MIT-licensed `billion-context-dsh` port, retains model-driven ARC, and adds provider-aware output governance plus a local reversible emergency fuse. The compression core [acp-kernel](https://github.com/ranxianglei/acp-kernel) remains pinned and inlined.

Normal checkpoints remain model-written. The product bundle enables an
output-reserve-aware Governor; its emergency automation is extractive,
bounded, local, and reversible, never a second LLM summarizer.

### Tech Stack

| Category | Technology |
|---|---|
| Language | TypeScript (strict, ESM, `.ts` import suffixes) |
| Build | tsup (bundles, **inlines acp-kernel**; `@deepseek-ai/*` stays external) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Deps | `acp-kernel` (inlined at build); peer: `@deepseek-ai/dsh-compaction`, `@deepseek-ai/cordis` |
| Host | DeepSeek Harness (composition row `name: 'dsh-arc-context'`) |

## 2. Architecture — module map

```
src/
├── index.ts        # AcpCompactionEngine (CompactionEngine backend) + wiring
├── messages.ts     # M1: session events ↔ acp-kernel CoreMessage projection
├── state.ts        # M2: per-session kernel state
├── region.ts       # M5: durable region transaction + log-rebuilt ledger + surface range solving + recursive effective sources
├── tools.ts        # M3: compress / decompress / search_context / arc_status + model-checkpoint safety appendix
├── nudge.ts        # M4: ARC-template nudge rendering (kernel decides WHEN, ARC owns the copy — compact defaults, no per-nudge rule repetition)
├── system-prompt.ts# M4: one-time ARC guidance section
├── prompts.ts      # M4: configurable prompt templates + render/validate (config.prompts)
├── config.ts       # kernel config assembly (thresholds + coreOverrides)
├── governor.ts     # opt-in output-reserve-aware late nudge policy
├── fallback.ts     # governor model-free reversible emergency cold-storage
├── window.ts       # auto context-window detection (LLM runtime probe, fallback 128000)
├── bridge.ts        # host-plane in-realm Basic→ARC row swap via official Include patch semantics
└── commands.ts     # M4: /arc slash command
```

Design decisions (see docs/dsh-porting-verification.md for the full evidence):

1. **Durable surface model** — DSH has NO in-memory message rewrite hook (`llm/stream` is read-only, `deriveMessages` is a pure projection). All compression is a durable `surfaceOp: { op: 'replace' }`; originals stay in the append-only log (decompress/search rebuild from the log).
2. **Seq is the ref** — no markup ref tags; the nudge's range table carries surface seqs.
3. **No automatic summarization** — default mode's `compactIfNeeded` returns null; nudges are advisory, never imperative (default copy aligned with kernel/pi: efficiency note, not "suggestion, not a requirement"; the emergency tier alone says "compress now"). Opt-in Governor mode owns its host `agent/pre-step` / `agent/request-error` boundaries and may archive one old balanced span with a local extractive checkpoint, never an LLM summarizer.
4. **Model-driven summaries** — the model writes the summary via `compress`; no second LLM summarization call.
5. **`acp-kernel` pinned to an exact version** (e.g. `"acp-kernel": "0.0.24"`, NEVER `^`). It is inlined by tsup; a caret range breaks reproducibility.

## 3. Hard-won rules (from v0.1.1 long-session battle)

These are NOT style preferences — each cost a live-session bug:

1. **Token estimation MUST use `defaultCountTokens`** (CJK-aware: 1 char/token for CJK, 4 chars/token otherwise) — NEVER `estimateTokensFast` (flat 4 chars/token). This is the billion-context-pi algorithm.
2. **Nudge usage MUST prefer `sessionProjections.contextPressure.projectedTokens`** (matches UI context-occupancy display, includes fixed overhead) — NEVER `.totalTokens` (request+response pressure; observed 230% vs ~20% real). ARC then makes that provider-anchored reading compression-aware: `effectiveProjectedTokens = max(0, projectedTokens − sum(rebuildBlockLedger(session.events).shadowedTokenCount))`; this uses the rule-6 legacy-zero backfill and is shared by nudge, `arc_status`, and Governor pressure. The denominator/window is unchanged; an empty ledger returns the projection exactly, a missing projection keeps the token-meter/character fallback chain, and an underflow emits debug logging before clamping to 0. Displayed percentage is capped at 100. **Fixed in 0.2.0-beta.6 (2026-08-18)**: task C proved the host projection itself does not consume shadow price (six 86–94% emergency artifacts; the offline fixed-reader replay suppresses one and downgrades five). The beta.6 isolated live replay stayed within 13/15 calls; its six later emergency nudges remained genuinely above the 85% effective line during an unusually long model tool loop, while `arc_status` reported the same corrected reader (`research/results/projection-subtraction-results.json`, `research/results/nudge-overpressure-fix-verification.json`).
3. **Nudge range table MUST be computed from the surface** (`buildCompressibleSeqRanges`), NOT from kernel `compressibleRanges` — the kernel ref map drifts after surface replacements in long sessions, hiding large tool results and producing `end < start` ranges.
4. **Range solving is shrink-then-expand** — `resolveSurfaceRange` shrinks edges inward to balanced cuts; if that collapses (a lone tool message), it EXPANDS outward to the smallest balanced tool-call/result pair. A model compressing a single "consumed tool output" is the norm, not the error.
5. **Test fixtures MUST mirror real DSH structures** — a real tool-result block is `{ type: 'tool-result', toolCallId, content: ContentBlock[] }` (nested), NOT `{ callId, output }`. `extractText` recurses into nested `content`. A wrong fixture silently passes while production breaks (this exact mismatch hid the seq-without-ref bug).
6. **Ledger is log-rebuilt** — `rebuildBlockLedger` reads `compaction/summary` events; a `shadowedTokenCount: 0` entry is BACKFILLED from the shadowed originals in the log (legacy blocks must still report real reclaimed tokens).
7. **Stale seqs are recovered, not errors** — a compress range whose edges were shadowed by an earlier compression (old nudge table / old compress result) is remapped to the still-live content of the requested span (`recoverStaleRange` in `resolveSurfaceRange`); a fully shadowed span throws `AlreadyCompressedRangeError`, which `handleCompress` reports as "already compressed" with the covering block ids. Block checkpoint nodes are NEVER folded on a stale reference — distillation (tier 2/3) stays an explicit act on a LIVE checkpoint seq. Invented/other-session seqs (not in the log) still fail with arc_status guidance. Prompt-only guidance proved insufficient: the engine must absorb the stale reference.
8. **Governor capacity is input budget, not raw window percentage** — when `adaptiveGovernor.enabled`, the pressure denominator is `contextWindow - outputReserve - safetyMarginTokens`. `maxOutputTokens:auto` means 32K only when the conversation has no explicit output intent; durable `request/header.adapterDefaults.maxTokens` distinguishes a provider-filled 384K default from caller intent, and an explicit long-output cap is preserved while its larger reserve moves pressure lines earlier. A numeric policy remains a hard cap. The request value is installed through `agent/request` (never by mutating frozen `llm/stream` requests), and growth-only nudges are disabled. If the model ignores the late nudge, the engine's own pre-step listener archives one oldest balanced span before request derivation; canonical provider overflow gets one retry only after `surface.replaceGeneration` proves durable progress. Do not rely on another compaction service to call the compaction seam: realm-local Basic may be `auto:false` or may shadow `ctx.compaction`. Same-realm backends must not coexist (`ctx.compaction` registration rejects them). The checkpoint is bounded/local/reversible and makes no LLM call. Its extractor must retain more than the generic eight-signal preview: narrow uppercase `KEY = VALUE`, explicit FACT/DECISION/INVARIANT/CANARY lines, narrow code-engineering record prefixes, and byte-exact natural-language lines whose normalized template is rare rather than dominant inside a repetitive event are preserved before the global 24K cap. Random opaque pairing proved head/tail alone lost 18/48 facts; unlabelled supersession pairing proved structured-only extraction retained only 3/12 current facts. Keep this mode opt-in while production evidence accumulates.
9. **Compaction shadow price MUST use the host token meter** — `compaction/summary.shadowedTokenCount` is consumed by the bounded surface projection as an exact subtraction claim, not merely shown in status. Never price Governor fallback replacements with `defaultCountTokens` when `ctx.tokenMeter.measure(session).nodes` is available: the kernel CJK-aware estimator can exceed the host heuristic, drive `messageTokens` negative, and abort the turn before the provider request. A missing/invalid meter price fails the fallback safely; minimal hosts without token meter retain the local estimator fallback.
10. **A real request projection outranks an advisory window probe** — with `autoModelContextLimit`, `sessionProjections.contextPressure.contextWindow` is adapter-anchored evidence and must be checked before the per-route `resolveModelInfo` cache. A first-step probe can be provisional or stale (the 384K live test observed 262,144 there while the official request projection reported 1,000,000); once the projection exists it corrects the cache. Explicit `modelContextLimit` still wins, and `autoModelContextLimit:false` still keeps the fixed fallback behavior.
11. **The preset bridge swaps Basic for ARC in-realm through official patch semantics** — the bundle mounts `dsh-arc-context/bridge`, which publishes the engine class in the public Loader builtin registry (`ctx.loader.builtins`, the same dict app-boot uses for `cordis:group`) and, on every `agent/created`, addresses the standing mount via the public `standingMountFor()` and appends guarded Include patches to its live config object (mutated IN PLACE — the object identity keys the harness-base record for bare `@deepseek-ai/*` imports). The patches disable the official `compaction-basic` row (package-name guard) and insert `cordis:dsh-arc-context` into the untouched `isolate.compaction` group; `fiber.update(config, true)` re-reads, re-applies, and reconciles transactionally. **Two sequential updates are mandatory**: `EntryGroup.update` force-restarts unchanged sibling rows concurrently, so retiring Basic and mounting ARC in one update races Basic's re-construction against the engine's realm registration (the rollback reverse-race is real too). Rollback runs the two phases backwards. Realm membership for verification walks the impl fiber's CONTEXT PROTOTYPE chain (entry contexts are chained with `setPrototypeOf`, not `fiber.parent`) — `fiber.parent.fiber` jumps straight to the loader root and never matches. Row ids, group nesting, command/pruner relationships, and preset bytes remain unchanged; unknown third-party backends are left untouched by the name guard. Ownership uses `AgentPresets.serviceFor()` for isolated preset services and the ARC structural brand for facade/cross-module identity.
12. **Implement the complete official compaction seam** — `compactIfNeeded` owns automatic policy; `compactRegion` creates a bounded local reversible checkpoint for an exact balanced range; `compactNow` uses `runMaintenance`, a `turn:null` lifecycle, command correlation, selected-span revalidation, failure closure, and durability flush. The model-facing `compress` tool remains the model-authored path but never substitutes for official consumer compatibility.
13. **Cordis rollback covers component effects, not arbitrary durable output** — service provision, events, tools, commands, prompt sections, builtin registration, and inserted preset rows must be effect-owned and proven removable. Bundle removal is a separate declarative layer rollback. Append-only session events are user data outside component-lifecycle rollback and remain readable by Basic. Never edit a user/profile/preset file in the normal install path and call that edit a Cordis inverse.
15. **Range suggestions are newest-safe-first** — cache invalidation spreads from the compression point toward the tail (RQ2: head placement spiked 21,282 uncached vs 10,297 for a middle range at equal shadowed volume), and RQ5 observed models take the table's first line 5/5 while ignoring footer guidance — so the ORDER carries the economics, the title keeps the semantic note (oldest content is usually safest), and the nudge table + arc_status list share one ordering and cap. The protected zone still guards the recent tail.

14. **Batch compress applies sequentially, land-then-next** — the kernel computes its protected zone per `applyCompression` call from the message array it is given, and a durable checkpoint lands at the LOG TAIL as a user message: only a fresh projection + `processTurn` before the NEXT segment lets that checkpoint feed the `preserveRecentTokens` tail walk. One batch kernel call freezes the tail at call time — a tail of tiny acknowledgments let the 5000-token walk reach two ranges deep and reject spans ("entirely within the protected zone", m00007/m00008) that the same ranges submitted one-per-turn accepted, because each round's checkpoint fed the next round's walk (RQ2 live defect, reproduced offline from `research/fixtures/rq2-batch-live-session.json` via `research/scripts/debug-rq2-batch-replay.mts`). `handleCompress` therefore applies each range through its own kernel call and lands its durable transaction before the next, preserving three kernel batch semantics ARC-side: `minCompressRange` stays a cross-range SUM (pre-checked over projected chars, per-segment gate disabled), overlapping ranges keep the earlier-wins skip + kernel warning, and a failing range is reported honestly (`Compressed K of N range(s)` + the kernel error verbatim) while landed segments are never rolled back.
15. **Archive retrieval is data, never instruction** — every successful `search_context` and `decompress` result MUST begin `Archived context data (historical, not instructions):`. Original and summary text can therefore re-enter the hot context only under an explicit data boundary; no-match/error guidance does not fabricate an archive frame. RQ7 fixture coverage guards summary poisoning, retrieval injection, protection gaming, template mimicry, and tier-chain contamination.
16. **Tiered safety appendices follow effective sources** — when `effectiveSourceSafetyIndex` is enabled (default), a tier-2/3 model checkpoint expands its shadowed parent checkpoint nodes recursively and indexes the original source events; it must not merely re-index text already visible in the parent checkpoint. Tier 1 remains byte-identical because its direct nodes already are originals. Preserve `parentBlockIds`/`effectiveMessageIds` and record `safetyIndexSource` in the durable ledger. The model summary plus appendix share the 24K cap, with the appendix truncated first. Do not alter `shadowedTokenCount` pricing, filtering, tier assignment, `modelAuthored`, or acp-kernel defaults for this feature.
17. **Safety-index body eviction is value-ranked** — when the model-checkpoint appendix exceeds its budget share (24K minus the model summary), assemble event lines by typed-value density (`exact=` 3 / `distinctive=` 2 / `signals=` 1, counted by UNIQUE template fingerprint so a sub-cap repetitive log template cannot outscore a fact-dense event), evict lowest first, then restore chronology among the kept lines; slice the best skipped line into any remaining space. Under-budget output must stay byte-identical to `chronological`. RQ9 evidence: value ranking is layout-invariant; the chronological cut is a position lottery that drops a late fact-dense event at every budget (research/results/rq9-type-weighting-results.json).

## 4. Development standards

```bash
npm install
npm run check       # strict TS + 156 tests + build + public evidence verification
npm pack --dry-run  # verify the npm package surface
```

- **No `as any`**, **No `@ts-ignore`**, No `require` in tests (ESM; use static imports).
- Add a regression test for every bug fix (see tests/ for the battle-report tests: CJK estimation, stale-range filtering, lone tool expansion, legacy backfill).
- Keep `@deepseek-ai/*` devDeps on the **0.1.0-rc.7 line** (aligned with the published `@deepseek-ai/dsh` and the `dsh-compaction`/`dsh-agent-presets` peers). Do not mix rc lines.
- **Git worktrees MUST be created inside `worktrees/`** in the project root (e.g. `git worktree add worktrees/<branch> <branch>`). The `worktrees/` directory is gitignored and never pushed. Never create worktrees outside the project.
- **Docs must stay in sync with every PR** — before opening a PR, review the diff against the documentation: any behavior the change alters must match what the docs describe, and docs that state the old behavior must be updated in the same PR. A PR that changes behavior without touching docs is incomplete.
- **Feature work MUST document itself** — every feature (any behavior addition or change) must add an explanation of the new capability in the relevant docs: user-facing config/options in `README.md` / `README.en.md`, install-time composition options in `docs/INSTALL.md`, design decisions in `docs/*-design.md`, and the module map / hard-won rules in `AGENTS.md` itself. Precedent: the `config.prompts` feature shipped its README section, INSTALL note, config table row, and design doc in the same PR.

### Commit messages

The convention applies to the **squash-merge subject on main**, which IS the PR title (main is branch-protected; see §5). **Commits inside a PR are free-form** — only the final squash subject is constrained. Single-line subject, prefix by change kind (the description after the prefix is free-form, keep it informative):

- `(feat) <summary>` — feature work (e.g. `(feat) tier-2/3 block distillation — …`)
- `(fix) <summary>` — bug fixes
- `(refactor) <summary>` — internal restructuring without behavior change
- `(test) <summary>` — tests only
- `(chore) <summary>` — tooling / process (CI, deps, scripts)
- `docs: <summary>` — documentation only (README, docs/, AGENTS.md)
- `release vX.Y.Z` — the release commit, exactly as in §5 (unchanged)

The PR title is enforced by CI (`.github/workflows/pr-lint.yml` → `scripts/check-pr-title.mjs`), since a squash merge turns it into the main-branch commit (e.g. `(feat) guide multi-segment batch compress + regression test`). Contributor guidance lives in CONTRIBUTING.md. PR merges stay human-only (§5).

## 4b. acp-kernel upgrade policy (the kernel WILL move on)

`acp-kernel` is pinned **exactly** (e.g. `0.0.24`, never `^`) because tsup inlines it — a caret range makes the resolved version drift when the lockfile regenerates, breaking reproducible builds. But pinning is **not** freezing: upgrades are a controlled, manual process.

**When to check:** on any feature work, or monthly — `npm view acp-kernel version`.

**Upgrade SOP (each step gates the next):**

1. `npm view acp-kernel versions` — pick the target. Read its changelog / git diff for breaking changes.
2. Watch these hot spots (kernel changes here have bit us before):
   - `defaultCountTokens` / tokenizer behavior (CJK estimation, `createBpeTokenizer`) — tests/assert 100 CJK = 100 tokens
   - `CompressionState` shape (`messageRefs`, blocks) — `state.ts`, `region.ts` read it structurally
   - ref assignment / `compressibleRanges` — we deliberately self-compute the range table, so drift here is absorbed, but confirm
   - `CoreMessage` / `NudgeDecision` types — `messages.ts`, `nudge.ts`
3. Bump the exact version in `package.json`, run `npm install` (refreshes lock), then `npm run typecheck && npm test && npm run build`.
4. **The test suite is the safety net**: 161 tests cover the battle-hardened behaviors plus Governor policy, cancellation, concurrency, 100-session soak, restart, durable-log migration, bridge takeover/rollback/fail-loud behavior (integration-tested against the real published Loader/Include/Group packages), preset-isolated ownership, complete manual/region seam behavior including persistence failure, backend conflict rejection, request/file noninterference, the batch sequential-application contract (fixture replay, cross-range SUM gate, overlap skip, honest partial-failure reporting), RQ7's seeded adversarial fixture bank, and RQ4 effective-source appendix regression coverage. Any kernel behavior change that breaks one of those turns red here — do NOT release on red.
5. Optionally enable new kernel features deliberately (e.g. `createBpeTokenizer()` behind a config flag) — never adopt silently.
6. Release per the workflow below (bump own version, publish, `gh release create`).

If a kernel major version breaks the seam contracts, treat it as a porting task: re-verify against docs/dsh-porting-verification.md before shipping.

## 5. Release workflow

Pre-flight (ALL must pass): `npm run check && npm pack --dry-run`.

1. Bump version: `npm version <patch|minor|major> --no-git-tag-version` (bug fixes → patch).
2. Update version references in README, docs, changelog, and evidence manifest.
3. Publish with `npm publish`; prerelease channels use `npm publish --tag beta`.
4. Commit `release vX.Y.Z` (package.json + package-lock.json + docs), push.
5. Create a GitHub prerelease/release with notes listing fixes and live verification data; sanitized raw mux evidence is a separate artifact.
6. GitHub Pages rebuilds automatically (workflow `pages.yml`).

> PR merges are **human-only**. The Agent MUST NEVER merge any PR.
>
> **`main` is branch-protected**: direct pushes are blocked — every commit, including `release vX.Y.Z`, lands via a PR that passed the required checks (`ci`, `pr-title`). No reviewer approval is required (solo maintainer). See CONTRIBUTING.md.

## 6. Upstream & attribution

- Always credit upstream in README/docs: **billion-context-pi**, **acp-kernel**, **opencode-acp** (ranxianglei, MIT) and **DeepSeek Harness** (DeepSeek AI).
- Do not change kernel defaults without evidence — the kernel decision defaults match billion-context-pi (nudge window 45%–75%, emergency 95%, `defaultCountTokens`); ARC's deliberate deviations (nudge max 0.70, emergency 0.85) and the first-class tuning knobs are inventoried with their evidence and protocol in docs/kernel-tuning.md. Nudge COPY is ARC-owned compact templates (the kernel-rendered per-nudge rule repetition was retired as transcript noise — tests/prompts.test.ts enforces the <1K-char budget).
- Keep the Beta notice prominent (project and host are both public beta; not for production).
