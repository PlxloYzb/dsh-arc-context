# Preset integration and experiments

## Provider substitution in the original preset realm

The ARC bundle mounts one host-plane bridge plugin. Presets retain their
native isolated Basic fallback. On `agent/created` the bridge patches the
mounted composition through official Include semantics — the official Basic
row is disabled by its package-name guard and the ARC engine row joins the
same isolate group — so ARC provides compaction inside Basic's original realm.

A normal Harness preset contains both patterns below:

```yaml
isolate:
  compaction: true

- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
```

Bridge matching therefore depends on the official row identity (id plus
package name guard) rather than constructor identity across package copies.
The untouched tree remains exactly:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

After the swap the effective tree (in memory only — the file is never
written) is:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      disabled: true

    - id: compaction-arc
      name: 'cordis:dsh-arc-context'
      config: { ...bridge-validated ARC config... }

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

Official Harness documentation establishes the boundary: bundles contribute a
profile patch layer, while isolated services are independent instances. Bare
package names inside presets resolve against the host composition, not a
`node_modules` directory beside the preset. The bridge's engine row avoids
bare-name resolution entirely: `cordis:dsh-arc-context` resolves through the
Loader's public builtin registry, populated by app-boot itself for
`cordis:group` and `cordis:include`.

Cordis owns both directions. The builtin registration and the config patches
are effects owned by the bridge fiber; the engine row's fiber is owned by the
preset's own entry tree. Process shutdown retracts both. Ordinary package
removal deletes the bundle row; the rollback withdraws the engine row,
re-enables Basic, and the next boot mounts the untouched original. See
[`reversible-install-design.md`](reversible-install-design.md).

## Audit

```bash
dsh-arc-presets audit [preset-root]
```

The default root is `$DSH_HOME/.agent-presets`, or `~/.dsh/.agent-presets`
when `DSH_HOME` is absent. A different root can be passed as the second
argument.

`audit` reports an official Basic row as bridge-patchable (PASS). An isolated
`compaction` realm with no known Basic/ARC row is FAIL: ARC does not guess how
to replace an unknown backend. A preset without an isolated compaction realm
resolves host-plane compaction and is reported as NOTE — the bridge does not
intervene there.

The final product intentionally exposes no migration command and no restore
command: the bridge never writes preset files, so there is nothing to migrate
or restore. Ordinary install and uninstall perform no preset write.

`arc_status` resolves preset-isolated ownership through the official
`AgentPresets.serviceFor()` API. Governor request/pre-step/error hooks fail
loudly if an unknown backend executes in the same scope.

## Future experiments

Do not create permanent `*-arc`, `*-basic`, or `*-nocomp` presets in the real
Harness home. Give every arm an isolated temporary home and profile:

```bash
export DSH_HOME="$(mktemp -d /tmp/dsh-arc-exp.XXXXXX)"
dsh plugin --profile arc add /absolute/path/to/dsh-arc-context
mkdir -p "$DSH_HOME/.agent-presets"
cp -R /absolute/path/to/router-standard "$DSH_HOME/.agent-presets/router-standard"
dsh-arc-presets audit "$DSH_HOME/.agent-presets"
dsh --profile arc --dump-config
```

Basic and no-compaction controls use separate temporary homes without the ARC
bundle. Never put ARC and Basic into the same arm. Preserve commit SHA, DSH
version, preset SHA, patch, provider/model, raw input/output/cache-read fields,
quality rubric, compaction events, and a sanitized mux artifact in the run
manifest. Delete only the temporary home after evidence export.
