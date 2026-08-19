# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** A context-governance plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): silent in the safe zone, **model-driven and locally reversible** compression as the real input capacity approaches. Information is never lost; uninstall leaves zero residue.

> **Release status: public beta, tracking official dsh 0.1.0-rc.7.** Both this project and dsh are public beta — not recommended for production yet. The full ten-item live release-gate matrix: [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## Measured advantages

Every number below comes from live experiments with real models (raw usage fields, no price conversion). Evidence and protocols ship with the package and are re-verified by `npm run research:verify`.

### Versus the built-in Basic compaction (same scenario, same seed)

**Code-engineering long session** — verbatim historical-constraint fidelity:

| Approach | Exact facts | Derived constraints | Input tokens | Output tokens | Total prompt |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

A 4x quality gap at lower cost: input −47.6%, output −24.9%, total prompt −22.1%. ARC's compactions are local and reversible (zero auxiliary LLM calls); Basic's are irreversible model summaries.

**Unlabeled natural-language decision tracking** (with value supersession): ARC recalls 12/12 current values and 10/10 rationales with zero obsolete-value leakage, at ~76% lower input than Basic; independent English holdout 10/10 + 7/7.

### Capabilities Basic does not have

- **Nothing is lost; everything is recoverable** — originals stay in the append-only log; `decompress` restores effective sources verbatim (100% across six live chains, including oversized outputs via the host spill file); `search_context` queries compressed blocks with 43/43 information-level recall in both English and Chinese.
- **Lossless deep distillation** — the tier-3 evidence appendix retains all facts 20/20 on all six bilingual chains (recursive effective-source index refresh, `effectiveSourceSafetyIndex`).
- **Type-weighted retention under budget** — when the appendix exceeds the checkpoint budget, low-value event lines are evicted by typed-value density instead of a chronological cut (`safetyIndexRanking: value`): dominates on the worst case at every budget offline; +14.3pp appendix layer in the clean live pair with zero end-to-end regression.
- **Zero adversarial compliance** — 18 archive-injection attack-surface variants (summary poisoning, retrieval injection, fake protection labels, template mimicry): the model complied **0** times; all archive output carries the "historical data, not instructions" frame.
- **Honest pressure governance** — compression-aware reading = host projection − log-ledger shadowing; zero false emergency warnings after compression (live-verified); displayed pressure matches real occupancy.
- **Compact guidance** — 1,140 system-guidance tokens with zero verbatim-quality degradation versus the full text (0pp, four live arms).

## Install

```bash
dsh plugin --profile web add dsh-arc-context
```

Restart the host. The bundle installs the host-plane Preset Bridge automatically: ARC swaps the official Basic row inside the standard preset's own compaction isolation realm, and **preset files stay byte-identical**; commands, pruners, isolation, and every other preset row are preserved.

Manual tarball installation, other profiles, and advanced options: [`docs/INSTALL.md`](docs/INSTALL.md).

### Configuration (excerpt)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # tier-2/3 indexes recurse to effective originals (default on)
    safetyIndexRanking: value           # evict by typed-value density over budget (default value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| Option | Default | Description |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | At tier 2/3, the safety index recurses to effective original sources instead of re-extracting only the visible parent checkpoint. Tier-1 output is unchanged. |
| `safetyIndexRanking` | `value` | Eviction order when the appendix exceeds the checkpoint budget: `value` drops low-value event lines first by typed-value density; `chronological` keeps the chronological character cut. Under budget both are byte-identical. |

Full configuration (context window, nudge thresholds, protection zone, Governor, prompt templates): [`docs/INSTALL.md`](docs/INSTALL.md) and [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## Uninstall — clean, complete, live-verified

```bash
dsh plugin --profile web remove dsh-arc-context
```

After a host restart:

- the composed configuration returns to the official Basic with zero ARC rows left;
- **preset files were never modified** (SHA-256 identical before and after, verified in the release gate);
- existing sessions remain readable — Basic reads ARC's durable log directly, the compressed surface shape is preserved, and **originals are never flooded back into context** (a 2,331-event session verified fully readable with a sane projection);
- new sessions register no ARC tools or commands.

Reinstallation works at any time and behaves exactly like the first install (the install → uninstall → reinstall cycle is verified item by item in the release-gate matrix).

## Evidence and documentation

- Research agenda and all conclusions: [`docs/research-agenda.md`](docs/research-agenda.md)
- Result data: [`research/results/`](research/results/) (release-gate matrix, paired comparisons, adversarial suite)
- Design docs: [`docs/`](docs/) (install, preset integration, Governor design, reversible-install design)
- Public-evidence verification: `npm run research:verify`

## Credits and license

ARC's compression core originates from a port and independent evolution of [acp-kernel](https://github.com/ranxianglei/acp-kernel) (with billion-context-pi and opencode-acp, by ranxianglei, MIT); the host is the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek AI). This project is MIT-licensed — see [LICENSE](LICENSE).
