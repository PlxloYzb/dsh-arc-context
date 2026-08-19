# Adaptive Context Governor design

## Status

Experimental and opt-in. The governor changes ACP's pressure policy but keeps
the durable block format, search, and decompression. Normal compression remains
model-written; the emergency fallback is a bounded local extractive index.

## Problem

Two independent limits decide whether a request fits:

```text
input tokens + reserved output tokens <= provider context window
```

Pressure policies that compare input only with a percentage of the raw context
window ignore the completion reserve. Conversely, an eager fixed-growth policy
can compress far below the real danger line, rewrite the surface many times,
and repeatedly invalidate the provider's cached prefix.

Production measurements on a 1M DeepSeek route exposed both failure modes:

- the adapter reserved 256K output although observed per-request output stayed
  below 9K, so a ~793K input was rejected before a nominal 800K Basic line;
- the ACP 50K growth branch kept the surface around 10-15% but paid repeated
  cache-rebuild cost on sessions that would have completed below 50%.

## Policy

Governor mode derives an effective input limit:

```text
effectiveInputLimit = contextWindow - maxOutputTokens - safetyMarginTokens
```

It then:

1. resolves one output reserve from durable conversation intent. `auto` uses
   32K only when no explicit `maxTokens` exists, preserves explicit long-output
   intent, and ignores adapter-materialized defaults as intent; a numeric value
   remains a hard operator cap. The result is installed through `agent/request`;
2. disables growth-only nudges;
3. injects the normal ACP nudge at
   `effectiveInputLimit * nudgeAtEffectiveCapacityPct`;
4. injects the emergency ACP nudge at
   `effectiveInputLimit * emergencyAtEffectiveCapacityPct`.
5. if the model ignores that line, or a provider confirms true overflow,
   archives one oldest balanced range as a reversible ACP block using a bounded
   local extractive checkpoint — no second LLM request.

The fuse owns its invocation boundary. `CompactionEngine` registers a service
but does not install Basic's automatic listeners, and an ACP host service can
coexist with a realm-local Basic service configured with `auto: false`. The
Governor therefore runs its pressure check in its own `agent/pre-step`
listener **before** delegating, so a replacement is visible to downstream
request derivation. Canonical provider overflow enters through
`agent/request-error`; it returns `retry` only after
`session.surface.replaceGeneration` advances, and only once per proposed step.

The model chooses the range and writes the normal summary. Only the emergency
fallback chooses the largest old balanced span; its checkpoint explicitly says
it is an index, captures head/tail plus salient identifiers/paths/errors, and
directs the model to search/decompress. Original content always remains in the
append-only log.

The extractor has two layers. A generic layer keeps head/tail plus a bounded
set of identifiers, paths, URLs, and operational signals. An exact-record layer
then preserves up to 64 explicit FACT/DECISION/REQUIREMENT/INVARIANT/CANARY/
NEEDLE lines, narrow uppercase `KEY = VALUE` assignments, and narrow code
records (CONSTRAINT, FILE_ANCHOR, SYMBOL_ANCHOR, TEST_ORACLE,
ERROR_FINGERPRINT, COMMAND, ROLLBACK) per event before
the global 24K-character cap. This is intentionally narrower than indexing
every colon/equal line: it retains non-derivable constants without filling the
checkpoint with ordinary logs. The layer was added only after a randomized
live counterexample falsified the generic extractor (30/48 opaque facts).

## Defaults

| Setting | Default |
| --- | ---: |
| enabled | false |
| maxOutputTokens | `auto` (32K ordinary reserve; explicit intent wins) |
| safetyMarginTokens | 32768 |
| nudgeAtEffectiveCapacityPct | 0.75 |
| emergencyAtEffectiveCapacityPct | 0.90 |
| emergencyFallback | true (only meaningful when governor is enabled) |

For a 1M window with no explicit long-output request these defaults produce:

- effective input limit: 934,464;
- normal nudge: 700,848;
- emergency nudge: 841,017.

An explicit 128K request uses that reserve instead of 32K: the effective input
limit becomes 836,160, the normal line 627,120, and the emergency line 752,544.
This is stateless geometry, not a predictor. DSH's durable request header marks
adapter-filled `maxTokens`, so a provider's 384K default can be distinguished
from caller intent without a numeric heuristic.

The thresholds began as offline-replay hypotheses. Live Flash validation on a
synthetic 1M-window workload then observed: no compression through ~456K; one
batched model-driven block when the next turn crossed the 700,848 normal line;
32,768 in every recorded request header; zero tool/provider errors; and 39/39
final canary recall after compression. A continued 898,759-token session then
forced the model-free fuse: it archived 64 nodes / 753,933 estimated tokens,
recorded provider `local` and model `adaptive-governor-extractive-v1` with no
LLM usage, and reduced the first post-fuse provider prompt to 17,490 tokens.
The final model response reproduced all 45 checkpointed canaries after
status/search/decompress, with zero errors. Raw paths and the evidence boundary
are recorded in the validation document.

A scaled, randomized seed-01 comparison then found the generic local index was
not sufficient: Governor v1 returned 30/48 exact facts while Basic returned
48/48. The exact-record layer repaired Governor to 48/48 + 3/3 derived answers
with one local block and no auxiliary call. A held-out seed using `INVARIANT
KEY: VALUE` syntax also returned 48/48 + 3/3. This falsify-fix-holdout sequence
is stronger evidence for the extractor than the earlier predictable canaries,
while still not substituting for broad production-domain trials.

A subsequent code-engineering holdout exercised four actual repository edits,
32 tool calls, test execution, 24 exact code-policy records, and four derived
cross-stage answers. With `maxOutputTokens:auto`, every recorded request header
used 32,768, two local reversible blocks made no LLM call, all four project
tests passed, and final recall was 24/24 + 4/4 with no final-turn tool access.

## Why no predictor yet

A growth forecaster adds state, tuning parameters, and more ways to act too
early. Offline replay shows a stateless effective-capacity line already removes
all nudges from the safe ~500K workload and needs at most one nudge on the
existing 744-790K boundary traces. Scientific sequencing therefore tests this
simpler policy first. Prediction should be added only if live traces show it is
necessary.

## Emergency fallback boundary

The fallback is a reliability fuse, not a replacement for semantic summaries.
It runs only at emergency pressure or confirmed overflow, preserves five recent
surface nodes and the latest user message, and refuses a replacement that would
not shrink token count. Its local index is capped at 24K characters. Alongside
head/tail, narrow structured records, ids, paths, and errors, it retains up to
48 byte-exact natural-language lines whose normalized template is rare rather
than dominant inside one repetitive event. The fingerprint normalizes ids, numbers, and URLs only
for frequency counting; retained prose is never rewritten. This preserves
unlabelled decisions without pretending to summarize arbitrary prose. Exact old
details remain available from durable originals through `search_context` and
`decompress`.

The transaction's `shadowedTokenCount` is priced from the host token meter's
exact surface nodes. This field is an accounting claim consumed by the bounded
surface projection, not a display-only estimate. Falling back to ACP's
CJK-aware counter while a host meter is present can over-subtract and make the
projection negative, so a missing meter price aborts the fallback safely.

## Non-goals

- The governor does not pretend its emergency extractive index is a semantic summary.
- It does not make ACP and `compaction-basic` the same backend.
- It does not promise that 32K output is correct for every task: auto treats it
  only as the ordinary default and preserves explicit long-output intent; a
  numeric policy is available when an operator deliberately wants a hard cap.
- It does not turn historical replay into a live-performance claim.
