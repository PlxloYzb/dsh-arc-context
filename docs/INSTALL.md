# 安装、迁移与回滚

## 前提

- Node.js 20+
- DeepSeek Harness `0.1.0-rc.8`（已发布 npm 线；不需要宿主补丁或未发布 seam）
- 同一 Cordis realm 中只能有一个 `ctx.compaction` provider

## Bundle 安装

同时启用 web 界面与 cli 终端（cli 终端对应 `headless` profile；`dsh
plugin --profile <name> ...` 可推广到任意 profile）：

```bash
dsh plugin --profile web add dsh-arc-context        # web 界面
dsh plugin --profile headless add dsh-arc-context   # cli 终端
```

`dsh plugin` 把参数转发给对应 profile 里的 pnpm，装包后自动 reconcile
`dsh.profile.bundles`：凡是声明 `dsh.bundle` 的依赖包都会加入该 profile 的
bundle 层栈，卸载时同步移出（参见 `dsh plugin` 的 reconcile 逻辑）。

`add` 的效果：按包名重新解析并写入依赖（首次安装、或把本地
tarball/`file:` 依赖切回 npm 注册表版本时用 `add`），随后 reconcile 自动把
ARC 加入 bundle 层，重启即挂载 bridge。`up`（pnpm update）则只在已声明的
范围内更新到允许的最新版，同样触发 reconcile。

## 升级

```bash
dsh plugin --profile web up dsh-arc-context
dsh plugin --profile headless up dsh-arc-context
```

重启后新版本生效。

package bundle 插入 `dsh-arc-context/bridge`。Bridge 把引擎类注册进 Loader
公共 builtin registry，并在每个 `agent/created` 后对该 agent 的 standing
preset 挂载执行域内换行：先禁用官方 `compaction-basic` 行（`name` 守卫只匹配
官方 Basic），再把 `cordis:dsh-arc-context` 行插入未改动的 `compaction`
isolate 组。ARC 因此在 Basic 原来的 preset realm 中启动，兄弟行（`/compact`
command、tool-result-pruner）自动绑定到 ARC。全程零文件写入。

## 本地 tarball 验证

```bash
npm ci
npm run check
npm pack
npm install --prefix ~/.dsh/profiles/web ./dsh-arc-context-0.2.0-beta.15.tgz
npx @deepseek-ai/dsh --profile web add ./dsh-arc-context-0.2.0-beta.15.tgz   # 或经 dsh plugin 按 tarball 安装
```

不要把 `research/` 作为运行时依赖；它不会进入 npm tarball。

## 手工组合

```yaml
- insert:
    - id: compaction-arc-bridge
      name: 'dsh-arc-context/bridge'
      config:
        adaptiveGovernor:
          enabled: true
          maxOutputTokens: auto
          safetyMarginTokens: 32768
          nudgeAtEffectiveCapacityPct: 0.75
          emergencyAtEffectiveCapacityPct: 0.90
          emergencyFallback: true
```

`modelContextLimit` 通常省略：ARC 优先采用真实 session projection，其次采用 model-info probe，最后回退 128K。只有部署方明确知道 route 窗口时才写死：

```yaml
      config:
        modelContextLimit: 1000000
        adaptiveGovernor:
          enabled: true
          maxOutputTokens: auto
```

## 输出策略

- `maxOutputTokens: auto`：没有显式输出意图时 32K；显式上限保持不变。
- `maxOutputTokens: 32768`：运维硬上限，任何更高请求都会被 cap。

压力线由同一公式派生，不需要历史预测器：

```text
effectiveInput = contextWindow - outputReserve - safetyMargin
normal         = effectiveInput * 0.75
emergency      = effectiveInput * 0.90
```

## 从 Basic 迁移

1. 停止新请求并安装 bundle。
2. 重启。首个 agent 创建时 bridge 在 preset 自己的 compaction 隔离域内完成
   换行；preset YAML、row id、group、isolation、command 和 pruner 均不改变。
3. 可选运行 `dsh-arc-presets audit`；官方 Basic 行应为 PASS（bridge-patchable）。
4. 调用 `arc_status`，确认 `ARC backend ownership: ACTIVE`；继续一个短 turn。
5. 观察原始三项 token、compaction event 和最终质量信号。

测试已覆盖 Basic → ARC durable log 继续读取，不需要改写历史 session。

## 从 billion-context-dsh 迁移

把 composition row 的 package name 改为 `dsh-arc-context`，id 建议改为 `compaction-arc`。ARC block、surface seq、append-only event 和工具协议保持兼容。产品 bundle 默认启用 Governor；如需先做纯兼容迁移，可显式设：

```yaml
adaptiveGovernor:
  enabled: false
```

## 回滚到 Basic（普通卸载）

1. 停止新请求。
2. 执行 `dsh plugin --profile <name> remove dsh-arc-context`。
3. 重启并继续原 session。bridge fiber 卸载时先撤回插入的引擎行、再重新启用
   官方 Basic 行（两阶段反向，避免 realm 注册竞态）；preset 文件从未改变，
   重启也会从原始 composition 挂载。

无需运行任何 restore 命令。bridge 从不写 preset 文件，也就没有备份需要恢复。

ARC 不删除被遮蔽原文；测试已覆盖 ARC → plain Basic 的 durable log 可读性。Basic 不提供 ARC 的 `search_context` / `decompress` 工具，因此回滚前如需恢复某个 block，可先在 ARC 中解压。

## 验收

至少验证：

- `arc_status` 可调用，且 backend ownership 为 `ACTIVE`；
- `dsh-arc-presets audit` 为全 PASS（已有 ARC 或官方 Basic 行可被 bridge 换行）；
- `/compact` 在有可压缩历史时产生 ARC local reversible checkpoint；
- 普通请求无显式意图时 header 为 32K；
- 其他 request 字段未改变；
- 安全区没有 compaction；
- 同 realm 不存在第二个 compaction backend；
- 一次 abort 不产生持久事务；
- 需要时 `search_context` / `decompress` 可恢复原文。

## 故障诊断

- **preset … does not mount the official compaction-basic row**：该 preset 使用了
  第三方 compaction backend 或外来结构；bridge 保持其原样，检查
  `dsh-arc-presets audit` 输出。
- **in-realm ARC takeover failed and rolled back**：插入行启动失败（事务化回滚
  已恢复 Basic）；检查 bridge config 校验错误与同 realm 冲突。
- **窗口明显错误**：优先检查 `sessionProjections.contextPressure.contextWindow`；必要时临时写死 `modelContextLimit`。
- **长输出被截断**：确认调用方的显式 `maxTokens` 没有被 adapter 标记为默认值；使用 `auto` 而不是数字硬上限。
- **provider overflow**：ARC 应先在 pre-step 保险丝缩减；规范 `CONTEXT_WINDOW_EXCEEDED` 只在 durable progress 后授权一次 retry。
