# Adaptive Context Governor — Flash validation record

## Scope

This record separates three evidence classes:

1. historical production-shaped ACP/Basic runs used to form the hypothesis;
2. offline replay used only to select thresholds;
3. new live calls to `deepseek-v4-flash` on a synthetic, non-sensitive 1M-window
   pressure workload.

No price conversion is used. Cost evidence is only provider-returned uncached
input, output, and cache-read tokens.

## Historical finding that motivated the governor

On the earlier 10-stage ~500K workload, no-compaction used 455K uncached input
with 0.991 cache hit and full probes. ACP used 558–673K and 10–15 compaction
transactions; early Basic used 854K and 11 checkpoints. At the 13-stage edge,
no-compaction reached 792K and terminated after max-context failures, while
default Basic recovered only after one rejected request. The provider route's
256K completion reserve was the hidden geometry behind that early rejection.

These runs are not treated as a paired comparison with the new synthetic run;
they establish the failure mechanism and the need for a later, reserve-aware
policy.

## Live synthetic Flash results

Governor configuration:

```yaml
adaptiveGovernor:
  enabled: true
  maxOutputTokens: 32768
  safetyMarginTokens: 32768
  nudgeAtEffectiveCapacityPct: 0.75
  emergencyAtEffectiveCapacityPct: 0.90
  emergencyFallback: true
```

For the detected 1,000,000-token window this yields an effective input limit
of 934,464, a normal nudge at 700,848 and an emergency line at 841,017.

| Run | Stages | Uncached input | Output | Cache read | Cache-read fraction | Compactions | Final recall | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| synthetic-safe-governor-01 | 10 | 492,079 | 3,106 | 5,495,424 | 0.918 | 0 | 30/30 | 0 |
| synthetic-boundary-governor-01 | 13 | 835,010 | 6,197 | 9,629,184 | 0.920 | 1 | 39/39 | 0 |
| synthetic-fallback-governor-01 | 15 + trigger | 974,976 | 6,234 | 17,056,896 | 0.946 | 1 local | 45/45 | 0 |

Both recorded request-header changes carried `maxTokens: 32768`. The largest
single assistant output was 689 tokens in the safe run and 1,744 tokens in the
boundary run.

Those historical runs used the numeric 32K policy. The productized default is
now `maxOutputTokens:auto`: it produces the same 32K header when the caller
expressed no output intent, but preserves an explicit long-output cap and moves
the effective-capacity lines earlier. Numeric 32K remains available as a hard
operator ceiling.

The safe run ended at 456,608 projected tokens and produced no nudge-driven
compression. In the boundary run, stage 11 ended at 660,666. The next stage
crossed the 700,848 line and produced one model-driven batch transaction:

- one block, 49 shadowed surface nodes;
- 603,572 estimated tokens reclaimed;
- 1,650-character model-written checkpoint;
- post-stage pressure 11,475 projected tokens;
- final stage and recall probe completed at 71,485 projected tokens;
- zero provider/turn, tool, or compaction errors.

This is the behavior the hypothesis predicted: no safe-zone cache rewrite,
then one late batch instead of 9–16 repeated transactions.

## Emergency fallback evidence

The model-free emergency fallback was added after the live threshold runs. The
first forced 15-stage attempt produced an important negative result: the
session reached 898,759 projected tokens (above the 841,017 emergency line) but
landed no block. The cause was architectural rather than threshold tuning:
`CompactionEngine` only registers the service seam; Basic installs its own
automatic listeners. In this composition the realm Basic was `auto: false`, so
nothing invoked ACP's `compactIfNeeded`.

The fix makes Governor own the two reachable host boundaries:

- `agent/pre-step` checks pressure and lands the replacement before delegating,
  so request derivation sees the reduced surface;
- `agent/request-error` handles canonical `CONTEXT_WINDOW_EXCEEDED` and returns
  `retry` only after `surface.replaceGeneration` proves durable progress, at
  most once per proposed step.

Two regression tests exercise those boundaries in addition to the transaction
tests. The suite now verifies that the fuse:

- waits below the 841,017 pressure line;
- accepts a provider-confirmed `context-overflow` trigger;
- preserves the recent five surface nodes and latest user message;
- writes one durable ACP block with provider `local` and model
  `adaptive-governor-extractive-v1`;
- indexes head/tail, salient identifiers, paths/errors, and tool-call arguments;
- refuses a transaction that would not reduce estimated tokens;
- leaves all originals searchable/decompressible;
- makes no LLM request.

The already-paid 898,759-token session was then resumed with one short trigger,
making the live test incremental rather than rebuilding another 900K context.
At the start of turn 18, before the first post-trigger request, the fuse landed:

- compaction id `cde1d0de-09b0-4a0d-803c-cd90ae2a748e`;
- 64 shadowed surface nodes, seqs 7..3681;
- 753,933 estimated tokens reclaimed;
- a 23,174-character bounded extractive checkpoint;
- provider `local`, model `adaptive-governor-extractive-v1`;
- `usage: null`, `llmStreamCall: null`, and no auxiliary request header — the
  compaction itself consumed no model call.

The projected pressure moved from 898,759 to 150,628 immediately around the
transaction. The next real Flash prompt reported 9,426 uncached input + 8,064
cache-read = 17,490 prompt tokens. The model then used `acp_status`,
`search_context`, and `decompress`; the final prompt was 33,949 tokens and the
session ended at 34,857 projected tokens. The continuation added 25,803
uncached input, 1,640 output, and 61,440 cache-read tokens in total. Those tokens
belong to the four ordinary agent/tool-loop requests; the fallback transaction
itself had no API usage.

All 45 S01–S15 canaries were present in the deterministic checkpoint and all 45
appeared in the final model response. There were zero tool, compaction,
provider, or turn errors. This proves live reachability, surface reduction,
API-call avoidance, and bounded-index recall for this synthetic marker task. It
does **not** prove that an extractive checkpoint equals a semantic model summary
on arbitrary production reasoning; randomized, non-derivable probes and paired
multi-seed arms remain necessary for that claim.

## Randomized paired falsification and repair

The predictable stage canaries above are useful for lifecycle verification but
can be guessed from their naming pattern. A second experiment therefore used
48 SHA-256-derived opaque values placed at head, one-third, two-thirds, and tail
positions across four 80K-character synthetic stages. The final prompt supplied
only the keys and requested all exact values plus three cross-stage derived
concatenations. It prohibited tools/files at answer time.

To keep the experiment budget-bounded, pressure geometry was scaled rather
than rebuilding another 1M prompt: Governor used an explicit 160K policy window
(effective input 94,464; normal 70,848; emergency 85,017), while the existing
Basic-early arm used its 0.08 route threshold (~80K). Both arms received the
same seed-01 stages, model, reasoning effort, preset tool shape, and answer key.

The first Governor result was a deliberate falsification success, not a result
to hide: its generic head/tail + eight-signal index retained only 30/48 facts
and 0/3 derived answers. Basic retained 48/48 and 3/3. Inspection showed each
large user event held twelve opaque assignments; the index kept the tail facts
but dropped nine middle/head records from each archived stage.

The local extractor was changed to preserve explicit structured records before
the 24K global cap, with a regression test containing more than eight facts in
one event. Re-running the **same** seed produced:

| Arm | Exact / derived | Compactions | Uncached input | Output | Cache read | Cache-read fraction |
|---|---:|---:|---:|---:|---:|---:|
| Governor v1 (counterexample) | 30/48 + 0/3 | 1 local | 163,440 | 4,873 | 339,456 | 0.675 |
| Governor v2 | 48/48 + 3/3 | 1 local | 164,010 | 4,087 | 341,120 | 0.675 |
| Basic early, session loop only | 48/48 + 3/3 | 3 model | 220,252 | 1,674 | 172,800 | — |
| Basic early, **all-in** | 48/48 + 3/3 | 3 model | 305,018 | 9,117 | 194,944 | 0.390 |

Basic all-in adds the provider-returned usage embedded in its three
`compaction/summary` events to the ordinary session projection. Those hidden
from the session strip but now directly observed auxiliary calls contributed
84,766 uncached input, 7,443 output, and 22,144 cache-read tokens. No price
conversion or estimate is used.

At equal seed-01 quality, Governor v2 used 46.2% less uncached input and 55.2%
less output than Basic all-in, but 75.0% more cache-read tokens. Total prompt
tokens (uncached + cache read) were nearly equal: 505,130 versus 499,962
(Governor +1.0%). The raw result is therefore a work-shift, not a claim that
cache reads are free: Governor trades model-summary work for a much warmer
prefix and one reversible local block; Basic makes three semantic summary calls.

Because v2 was designed after seeing seed-01, one new structural holdout used
an independent seed and `INVARIANT KEY: VALUE` syntax. Governor again returned
48/48 + 3/3, used 163,721 uncached input / 3,515 output / 340,736 cache read,
made one local compaction, and recorded zero errors. Usage and cache fraction
were stable within a fraction of a percent, so the sequential rule stopped
without paying for a second Basic arm. This is an engineering holdout, not a
multi-seed confidence interval.

## Code-engineering holdout and product hardening

The next holdout moved beyond archive-only recall. A synthetic Node repository
started with four unimplemented release-policy functions. Across four pressure
stages the agent had to edit the repository, run targeted tests, retain 24
code-policy proofs distributed through CI-noise payloads, and finally produce
all proofs plus four cross-stage derivations without tools or files.

The first generated fixture was invalid for the predeclared exact-record
grammar: arbitrary character cuts glued three stage-3 records into the middle
of CI log lines. It returned 21/24 + 2/4, and inspection found all missing keys
at those malformed boundaries. No plugin code was changed in response. The
generator was fixed to assert 24 standalone records, a fresh seed was generated,
and only that seed is treated as the valid holdout.

Valid seed-02 used `deepseek-v4-flash`, a 130K scaled policy window, and
`maxOutputTokens:auto`. Results:

| Quality / usage | Result |
|---|---:|
| Repository tests | 4/4 passed |
| Exact code-policy proofs | 24/24 |
| Cross-stage derivations | 4/4 |
| Final-turn tool calls | 0 |
| Uncached input | 121,146 |
| Output | 23,234 |
| Cache read | 934,656 |
| Compactions | 2 local reversible blocks |
| Provider / turn / compaction errors | 0 |

Both request-header snapshots carried `maxTokens:32768` with no adapter-default
marker, directly verifying ordinary auto behavior in the real host. The run
made 32 engineering tool calls across the four work stages; its two local
blocks archived 26 / 29 surface nodes and 33,960 / 36,065 estimated tokens.
Both recorded `usage:null`, so there was no auxiliary summarizer API call.

Product hardening also expanded the deterministic suite to 134 tests. New host
cases cover auto versus numeric output policy, adapter-default provenance,
explicit 64K pressure geometry, request-field noninterference,
abort-without-write, independent concurrent sessions, a 100-session
cancellation / overflow / restart / tool-pair soak, fresh-engine continuation
from the durable ledger, Basic↔Governor durable-log migration/rollback,
same-realm compaction-backend rejection, and the existing canonical overflow
once-only retry. Cordis rejects two `ctx.compaction` providers in one realm, so
a Basic and Governor backend cannot silently double-register there.

### Paired Basic code-engineering arm

The identical valid seed-02 fixture was then run through Basic early. Project
tests still passed, but the final no-tool probe retained only 6/24 exact proofs
and 0/4 derivations, versus Governor's 24/24 and 4/4. Basic's two model-written
summaries carried provider usage, so the comparison can be all-in without any
token estimation:

| Arm | Exact / derived | Uncached input | Output | Cache read | Total prompt |
|---|---:|---:|---:|---:|---:|
| Governor | 24/24 + 4/4 | 121,146 | 23,234 | 934,656 | 1,055,802 |
| Basic, all-in | 6/24 + 0/4 | 231,315 | 30,940 | 1,124,224 | 1,355,539 |

Governor used 47.6% less uncached input, 24.9% less output, 16.9% less cache
read, and 22.1% fewer total prompt tokens while producing the stronger answer.
This is one paired engineering run, not a universal model-quality claim.

## Unlabelled semantic supersession falsification

A separate Chinese fixture removed `KEY=VALUE` labels and embedded twelve
evolving production decisions in ordinary meeting prose. The final turn asked
for only the current state, ten change rationales, and no obsolete leakage.

Governor v1 failed this domain: 3/12 current fields and 3/10 rationales. Basic
returned 12/12 and 10/10 with no obsolete contamination. That counterexample
showed that structured-record extraction was insufficient for ordinary prose.

The local checkpoint was therefore extended with a language-neutral,
extractive distinctive-line path. It normalizes URLs, long ids, and numbers
only to count repeated templates, discards dominant boilerplate, and retains
the byte-exact rare lines. Re-running the same seed and then one unseen English
holdout produced:

| Arm | Current | Rationale | Obsolete | Uncached input | Output | Cache read |
|---|---:|---:|---:|---:|---:|---:|
| Governor v1 | 3/12 | 3/10 | 0 | 94,124 | 4,423 | 141,568 |
| Basic, all-in | 12/12 | 10/10 | 0 | 112,208 | 7,557 | 209,664 |
| Governor v2, same seed | 12/12 | 10/10 | 0 | 26,970 | 3,564 | 210,432 |
| Governor v2, unseen English holdout | 10/10 | 7/7 | 0 | 112,336 | 2,274 | 73,088 |

At equal same-seed semantic quality, Governor v2 used 76.0% less uncached
input, 52.8% less output, 0.4% more cache read, and 26.2% fewer total prompt
tokens than Basic all-in. The independent holdout passed the predeclared
sequential stop, so no second paid Basic arm was run.

## Runtime falsification and 384K output-intent path

Two live failures exposed host-integration bugs and are retained as invalid-run
evidence rather than silently discarded.

First, the emergency block originally priced `shadowedTokenCount` with ACP's
CJK-aware estimator. The host subtracts that field using its own surface-token
protocol, so a 30,372-token claim against a 28,493-token message surface made
`messageTokens` negative and stopped the next request. The fallback now prices
the exact selected seqs with the host `tokenMeter`, and prices its replacement
message through the same service. A regression test fixes this protocol
boundary; the subsequent valid semantic runs had no projection error.

Second, an explicit `maxTokens:393216` request was accepted by the provider on
the first turn but the next local pre-step rejected it against a cached 262,144
model-info probe, even though the provider-anchored session projection reported
a 1,000,000 context window. Window precedence is now explicit operator config,
then real session projection, then advisory probe cache, then default. The live
rerun carried `maxTokens:393216`, was not marked as an adapter default, completed
both turns, and recorded 94 uncached input / 33 output / 4,096 cache read with
zero errors. This verifies preservation and acceptance of the 384K cap; it does
not claim that a 384K response body was generated.

## Decision

For a 1M Flash production route, the current best candidate is Governor mode,
not default ACP growth nudges and not default Basic alone:

- passive below the real danger region;
- provider-safe output reservation;
- one late model-written reversible batch when the model cooperates;
- one model-free reversible cold-storage fuse if it does not;
- no hidden Basic summarizer call.

The evidence now supports publishing the feature as an opt-in **Beta / release
candidate** and using it as the preferred Basic replacement on the tested Flash
route. It has paired quality wins, equal-quality token wins, an independent
semantic holdout, live 384K intent preservation, durable migration/rollback,
request noninterference, and a 100-session deterministic soak.

It should not yet be labelled universal stable/GA: the paired results are still
synthetic, the 384K run validates the request cap rather than a full 384K body,
and the genuine provider-rejection hook remains integration-tested rather than
observed after a live rejection. Further paid synthetic expansion is no longer
the highest-value step. Publish with Governor opt-in, Basic off in the same
realm, a documented rollback path, and gather public canary evidence before
promoting the default.

## Preset in-realm takeover release gate

Standard, `anchored-standard`, and `router-standard` retain their official
isolated Basic fallback. The preset bridge swaps that row in-realm through
official Include patch semantics — the official Basic row is disabled by its
package-name guard and the ARC engine row joins the untouched
`isolate.compaction` group — so row ids, group nesting, commands, pruner, and
preset files remain unchanged. `dsh-arc-presets audit` reports the maintained
presets bridge-replaceable.

Ownership addressing uses the official `AgentPresets.serviceFor()` read path
plus the ARC structural brand (Cordis preset scope resolution can return a
forwarded service facade — identity checks must go through the brand, never
constructor identity). Prior-generation Flash runs under the same ownership
contract reported:

| Preset | ARC ownership | Resolved backend | maxTokens | Uncached input | Output | Cache read | Errors |
|---|---|---|---:|---:|---:|---:|---:|
| anchored-standard | ACTIVE | dsh-arc-context | 32,768 | 6,350 | 1,823 | 12,544 | 0 |
| router-standard | ACTIVE | dsh-arc-context | 32,768 | 1,216 | 217 | 27,008 | 0 |

Router's first-turn catalog is intentionally reduced to shell/editor, so its
status probe was issued after one deliberate promotion tool call. This is a
tool-visibility property of the preset, not a backend ownership failure.

The 2026-08-18 live gate (published 0.1.0-rc.7 host, isolated home, scnet
GLM-5.2 real turns) re-verified the bridge generation end to end: install
composes the bridge row, a fresh session reports ACTIVE ownership with the
window auto-detected, the model authors a compress checkpoint with full
durable compaction events, `search_context`/`decompress` recover shadowed
content, uninstall restores Basic, and the standard preset file stays
byte-identical throughout. Full data: `research/results/preset-bridge-results.json`.

The bridge targets preset-mounted hosts. Hosts without agent-presets (the
headless composition, root-plane compaction) boot unchanged with the bridge
inert — it logs one orientation line and leaves the root-plane backend alone.

## Repeated-template and archived-instruction falsification

A new fixture placed twenty exact numeric decisions behind several repeated
natural-language templates and embedded one historical imperative instruction.
Governor v1 retained none of the decisions, copied the imperative into the hot
checkpoint, returned 0/20 values + 0/20 dependencies, omitted `SAFE_FINAL_ONLY`,
and repeated the injection marker while refusing the valid task.

The fix made the checkpoint explicitly treat excerpts as untrusted archive
data, omitted imperative-looking lines from the hot index (originals remain
searchable/decompressible), raised the repeated-template allowance to the
global 48-line budget, and ranked candidate lines by template rarity before
restoring chronology. Same-fixture v2 returned 20/20 + 20/20, the safe marker,
no injection-string contamination, and zero errors. Uncached input fell from
225,216 to 196,050 and output from 6,516 to 2,284; cache read moved from 98,304
to 127,744, leaving total prompt tokens nearly unchanged.

## ScNet / GLM-5.2 cross-provider falsification

The ScNet Anthropic-compatible route reports a 1,000,000 context window. The
adapter smoke completed with ARC ownership active, a 32,768 ordinary request,
10,381 / 176 / 16,000 API tokens, and zero errors. A second run preserved an
explicit 131,072 cap with 610 / 15 / 3,072 and zero errors.

On the same unlabelled semantic seed, the first GLM ARC run exposed that a
chronological first-N distinctive index let medium-frequency noise consume its
budget; it scored 10/12 + 10/10. Rarity-first ranking restored 12/12 + 10/10
with zero obsolete leakage. The paired GLM result was:

| Arm | Quality | Uncached input | Output | Cache read | Total prompt |
|---|---:|---:|---:|---:|---:|
| ARC | 12/12 + 10/10 | 179,616 | 8,625 | 78,848 | 258,464 |
| Basic all-in | 12/12 + 10/10 | 241,319 | 11,059 | 80,384 | 321,703 |

ARC used 25.57% less uncached input, 22.01% less output, 1.91% less cache read,
and 19.66% fewer total prompt tokens at equal scored quality.

The first GLM code holdout then found a different model-dependent failure:
GLM voluntarily called `compress`, but its model-written summary omitted all six
stage-1 proofs, producing 18/24 + 1/4 despite project tests passing. ARC now
augments every model-written checkpoint with the same bounded, redacted, exact
local safety index and prices the range with the host token meter. Same-seed v2
returned 24/24 + 4/4, project tests 4/4, no final-turn tools, and zero errors.
The sequential rule therefore stopped without paying for a GLM Basic code arm.

## Final clean-install gate

### 0.2.0-beta.2 (bridge generation, published rc.7 host)

Installed from the packed tarball into a brand-new isolated `DSH_HOME`,
independently for `web` and `headless`. The web profile composed the bridge
row; a fresh session mounted the untouched `standard` preset and reported
ACTIVE ARC ownership with the context window auto-detected from
scnet/GLM-5.2; the model invoked `acp_status` and authored a `compress`
checkpoint (full `compaction/start→summary→end` durable bracket, protected
zone enforced); `search_context` and `decompress` recovered shadowed content;
`dsh plugin remove` plus restart left only Basic (the ARC-era session with
its compaction events stayed fully readable under Basic, and a fresh turn
reported no ACP tools); the standard preset file stayed byte-identical across
install, takeover, compression traffic, uninstall, and reinstall. The
headless profile — a host without preset mounts — booted unchanged with the
bridge inert and completed a real model turn through Basic. Full data:
`research/results/preset-bridge-results.json`.

### 0.1.0-beta.1 (resolver generation — historical record)

The `0.1.0-beta.1` tarball was installed into a second brand-new `DSH_HOME`,
independently for `web` and `headless`. Both composed ARC with the Governor
defaults and root Basic disabled. The Web app booted on an isolated port,
runtime peer imports resolved, the preset audit returned two PASS rows, and
fresh sessions mounted both maintained presets without any post-install user
command. Runtime dependency audit reported zero vulnerabilities.

The earlier clean-install run exposed a rollback defect: `dsh-web-app` keeps
root Basic disabled and presets had been permanently changed to require host
ARC. A zero-write Include overlay closed the immediate defect but depended on
private config interception; that generation then replaced it with a public
Loader resolver contract (never shipped by upstream — archived under
`dsh-arc-context-upstream/docs/0.1.0-beta.1/loader-resolver-upstream/`). A
fresh Web install→session→remove→restart run observed `/acp` + `/compact`
and ACTIVE preset-isolated ARC while installed, then only `/compact` after
removal. A separate synthetic live session invoked the official `/compact`,
which archived four history items as one ARC local reversible checkpoint
with no auxiliary summarizer call. The 0.2.0 bridge generation carries the
same seam behavior forward on the unmodified published host.
