# Reversible provider substitution

## System boundary

Cordis tracks a component's context mutations through `ctx.effect()`. Services, listeners, tool registrations, commands, prompt sections, child fibers, and the bridge's builtin registration all carry disposers. Preset and profile files are outside that lifecycle boundary, so ARC never writes them during normal install or uninstall.

## Package roles

One npm package exports two Cordis plugins:

- `dsh-arc-context/bridge` is a host-plane Loader policy;
- `dsh-arc-context` is the `CompactionEngine` provider mounted inside the preset's original compaction realm.

The Web bundle mounts only the bridge. Users still install and remove one package.

## Loader contract (published 0.1.0-rc.8 surface — no host patch required)

The bridge uses four public behaviors of the published host:

1. **Loader builtin registry** — `ctx.loader.builtins` is the same public dict app-boot itself uses to provide `cordis:group` and `cordis:include`. The bridge publishes the engine class as `dsh-arc-context`, so a composition row named `cordis:dsh-arc-context` mounts the engine with no module-resolution assumptions.
2. **Include runtime patches** — `Include.Config.patches` are "runtime patches applied after reading the file"; every Include-config update re-reads the composition, re-applies the patches to a clone, and reconciles the tree transactionally.
3. **`agent/created`** — the public agent lifecycle event; the standing preset mount of the agent's scope already exists when it fires.
4. **`standingMountFor(agent.ctx)`** — the public export of `@deepseek-ai/dsh-agent-presets` that addresses one agent's standing preset mount (its Include fiber).

On every agent creation the bridge appends two guarded patches to the mount's live Include config object — mutated in place so the config keeps its object identity, which is the key the harness-base record uses for bare `@deepseek-ai/*` imports — and calls `fiber.update(config, true)`:

- `{ id: compaction-basic, name: '@deepseek-ai/dsh-compaction-basic', disabled: true }` — the name guard matches only the official Basic row, whatever the row id or nesting;
- `{ id: compaction, insert: [{ id: compaction-arc, name: 'cordis:dsh-arc-context', config }] }` — the engine row joins the untouched `isolate: { compaction: true }` group.

Because the engine row lives inside the original group, ARC provides `ctx.compaction` in exactly Basic's realm: `dsh-command-compact` and the local tool-result pruner keep resolving the same capability key without a bridge service or second backend.

## Two-phase ordering

`EntryGroup.update` starts every child entry concurrently — including unchanged siblings, which are force-updated. Retiring Basic and mounting ARC in one update therefore races Basic's re-construction against the engine's realm registration. The bridge applies the swap as two sequential Include updates (the Include's own apply queue serializes them): first retire Basic, then mount ARC into the vacated realm. Rollback runs the same two phases backwards.

## Compaction seam

ARC implements all three official operations:

- `compactIfNeeded()` owns pressure and confirmed-overflow policy;
- `compactRegion()` creates a bounded local reversible checkpoint for the exact balanced range without an auxiliary LLM call;
- `compactNow()` enters `runMaintenance()`, records a standalone `turn: null` bracket, carries `sourceCommandId`, revalidates the selected span, closes on failure, and flushes through `ctx.sessions` when available.

The model-facing `compress` tool remains the model-authored checkpoint path; the standard seam uses the deterministic local path so `/compact` and other official consumers do not depend on model tool behavior.

## Uninstall

`dsh plugin --profile web remove dsh-arc-context` removes the dependency and bundle row. Bridge disposal first withdraws the inserted engine row (Basic stays disabled), then re-enables the official Basic row, and finally removes the builtin registration. On the next boot — or any restart without the package — the unchanged preset imports Basic normally. Durable session events remain user data and are readable by either provider.

## Host prerequisite

None beyond the published `0.1.0-rc.8` line. The earlier `Loader.registerResolver()` upstream proposal is archived under `dsh-arc-context-upstream/docs/0.1.0-beta.1/loader-resolver-upstream/`; if upstream ever ships an equivalent generic seam, the bridge can migrate onto it without changing the composition semantics described here.
