# Release checklist

> Current release gate: `research/results/release-verification-0.2.0-beta.12.json`
> (all ten items cleared). Unchecked boxes are the remaining steps.

## Code gate

- [ ] `npm ci`
- [x] `npm run check`（0.2.0-beta.9，158/158）
- [x] `npm pack --dry-run`（等价实包 `npm pack` 已通过 prepack；tarball SHA-256 见 release verification）
- [x] tarball 只含 dist、bundle patch、README、LICENSE、NOTICE
- [ ] Node 20 clean install smoke

## Product gate

- [ ] branded Basic is substituted before its fiber is created; no second backend starts
- [ ] live takeover verified on a real web profile of the published DSH (`dsh plugin --profile web add dsh-arc-context` → ARC backend ownership ACTIVE, uninstall → Basic restored)
- [ ] install, in-realm bridge takeover, uninstall, and Basic restoration tested from a clean profile
- [ ] `acp_status`, `search_context`, `decompress`, and `compress` smoke
- [ ] `dsh-arc-presets audit` passes for every shipped preset
- [ ] official and maintained preset files are byte-identical across ARC mount
- [ ] after uninstall `/acp` is absent and native `/compact` remains
- [ ] `/compact` with useful history lands an ARC local reversible checkpoint
- [ ] `acp_status` reports `ARC backend ownership: ACTIVE`
- [ ] absent output intent resolves to 32K
- [ ] explicit long-output intent remains unchanged
- [ ] disabled mode and request noninterference remain green

## Evidence gate

- [ ] `research:verify` passes
- [ ] report numbers match result JSON
- [ ] no credentials, cookies, API keys, or personal production data
- [ ] invalid runs remain labelled invalid/counterexample
- [ ] claims distinguish request-cap acceptance from actual long-body generation

## Repository and registry

- [ ] create `PlxloYzb/dsh-arc-context`
- [ ] enable branch protection and required CI
- [ ] confirm npm name ownership/availability
- [ ] configure npm trusted publishing or scoped automation token
- [ ] configure provenance/signing
- [ ] add issue templates and discussions policy
- [ ] publish `0.2.0-beta.13` to npm
- [ ] attach sanitized raw-evidence artifact separately from npm
- [ ] create GitHub prerelease and copy evidence summary

## Promotion to stable

- [ ] public canary across multiple real repositories and free-form sessions
- [ ] observe install/rollback on supported DSH versions
- [ ] no unresolved data-loss, negative projection, or retry-loop defect
- [ ] define telemetry schema before collecting anything; default remains local-only
- [ ] document any workload where Basic remains preferable
