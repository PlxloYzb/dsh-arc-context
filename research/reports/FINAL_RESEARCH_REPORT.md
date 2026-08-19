# 自适应可逆上下文管理器：阶段性科研与验证报告

## 结论

本轮已经从“比较 ACP 与 Basic”推进到一个可运行的新候选：
**Adaptive Reversible Context Governor**。

它不是第三种摘要器，而是四层控制器：

1. **输出预留治理**：把 provider adapter 的 256K 默认输出预留限制为 32K；
2. **安全区静默**：取消每增长 50K 就 nudge 的早期策略，避免无意义地破坏 KV cache；
3. **晚期批量 ACP**：按扣除输出预留和安全余量后的有效输入容量，在 75% 时提醒模型一次性批量压缩；
4. **可逆紧急保险丝**：模型忽略提醒、到达 90% 紧急线或 provider 确认溢出时，不调用第二个 LLM，而是把最旧的平衡范围写入同一个 ACP 可逆块，以本地抽取索引作为 checkpoint；原文仍可搜索和解压。

就现有证据，**它已经表现出比默认 ACP 和默认 Basic 更合理的生产几何**：
安全区不动作，边界区只做一次晚期大批量可逆压缩，同时修复导致 793K 输入提前撞墙的输出预留问题。

它还不是“已经统计学毕业”的版本。正常路径和紧急 pressure 保险丝都已完成真实 Flash/host 验证；尚未观察到的是 provider 已拒绝后才进入 `agent/request-error` 的恢复路径——主动保险丝在拒绝前成功，正是生产期望结果。

---

## 一、原始假设从哪里来

历史生产形态实验的关键事实：

| 形态 / 负载 | 输入 | 输出 | 缓存命中 | 压缩 | 结果 |
|---|---:|---:|---:|---:|---|
| 无压缩，hp ~500K | 454,548 | 59,651 | 0.991 | 0 | 全探针通过 |
| ACP only，hp | 557,974–672,654 | 76,735–103,789 | 0.949–0.959 | 10–15 事务 | 全探针通过，但输入 +23%–48% |
| Basic early，hp | 854,449 | 62,477 | 0.933 | 11 事务 | 早压最贵 |
| 无压缩，hp2 边界 | 744,409 | 74,831 | 0.994 | 0 | 792K 时终端失败，末轮 0/12 |
| Basic default，hp2 | 761,153 | 73,774 | 0.993 | 1 事务 | 先 max-context 错误，再救回 |
| ACP only，hp2 | 1,083,873 | 110,145 | 0.927 | 16 事务 | 稳定，但输入高且一次探针瞬时 8/12 |

历史 Basic 运行的摘要器 usage 未落盘，所以那些输入/输出只是下界；不能用估算冒充 API 事实。本轮 rc.6 随机配对中，`compaction/summary` 已直接携带 provider-returned usage，后文 all-in 数字将其逐项相加，不再是估算。

根因不是“窗口只有 800K”，而是请求校验满足：

```text
input + reserved output <= provider context window
```

历史 adapter 默认 `maxTokens=256000`。因此约 793K 输入再加 256K 预留，会超过 1,048,576，即使模型实际单次输出从未超过 9K。

由此得到科研假设：

- 先把无依据的超大输出预留缩到 32K；
- 在 ~500K 安全区保持完全静默；
- 只在接近真实输入预算时做一次大批量 ACP；
- 不再依赖 Basic 的隐藏 LLM 摘要器和“撞墙后恢复”。

---

## 二、策略公式

默认参数：

```yaml
adaptiveGovernor:
  enabled: true
  maxOutputTokens: 32768
  safetyMarginTokens: 32768
  nudgeAtEffectiveCapacityPct: 0.75
  emergencyAtEffectiveCapacityPct: 0.90
  emergencyFallback: true
```

对于 DSH 探测到的 1,000,000 窗口：

```text
effectiveInputLimit = 1,000,000 - 32,768 - 32,768 = 934,464
normalNudge        = 934,464 × 0.75 = 700,848
emergency          = floor(934,464 × 0.90) = 841,017
```

32K 不是拍脑袋的输出截断：历史 Flash 全部请求最大输出 <9K；本轮新 run 的最大 assistant 单次输出分别为 689 和 1,744 token。32K 仍有大幅余量。

---

## 三、新的真实 Flash 验证

由于既有生产 fixture 包含配置、值班、账单和事故类材料，本轮没有把它再次发送给外部 API；改用完全合成、无生产和个人数据的压力文本。它隔离验证的是上下文控制器本身，不把合成任务冒充生产质量基准。

模型仅使用 `deepseek-v4-flash`，reasoning effort 为 max。

| run | 阶段 | API 未缓存输入 | API 输出 | API 缓存读取 | 缓存读取占比 | 压缩 | 最终回忆 | 错误 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| synthetic-safe-governor-01 | 10 | 492,079 | 3,106 | 5,495,424 | 0.918 | 0 | 30/30 | 0 |
| synthetic-boundary-governor-01 | 13 | 835,010 | 6,197 | 9,629,184 | 0.920 | 1 | 39/39 | 0 |
| synthetic-fallback-governor-01 | 15 + 短触发 | 974,976 | 6,234 | 17,056,896 | 0.946 | 1（local） | 45/45 | 0 |

所有可见的 `request/header` 变更事件都记录了：

```json
{"provider":"deepseek-official","model":"deepseek-v4-flash","maxTokens":32768}
```

### 安全区

- stage 10 后 projectedTokens = 455,901；
- 最终状态询问后 projectedTokens = 456,608；
- 0 nudge-driven compaction；
- 0 provider / tool / compaction error；
- 30/30 金丝雀逐字回忆。

这验证了最重要的反事实：**新策略不会像默认 ACP 一样在安全区每增长 50K 就反复改写 surface。**

### 边界区

- stage 11 后 projectedTokens = 660,666；
- stage 12 新输入使请求跨过 700,848 普通线；
- 模型只执行 1 次 `compress`；
- 单块遮蔽 49 个 surface nodes，回收估算 603,572 token；
- 模型摘要 1,650 字符；
- stage 12 结束后 projectedTokens = 11,475；
- stage 13 和最终回忆正常完成；最终 projectedTokens = 71,485；
- 39/39 金丝雀逐字回忆；
- 0 provider / turn / tool / compaction error。

这与离线假设一致：**不是 9–16 次早压，而是 1 次晚期大批量可逆压缩。**

---

## 四、紧急保险丝

正常 ACP 依赖模型调用 `compress`。为了不再把可靠性押在“模型一定配合”上，新版加入模型免费的紧急 cold-storage：

- 只在有效容量 90% 或 `context-overflow` 触发；
- 保留最近 5 个 surface 节点和最新 user message；
- 选择最旧、最大、tool-call/result 平衡的范围；
- checkpoint 明确标记为“抽取索引，不是语义摘要”；
- 索引 head/tail、显著 ID、路径、ERROR/WARN/TODO、URL、tool-call arguments，并精确保留显式 FACT/DECISION/INVARIANT/CANARY 与窄匹配全大写 `KEY = VALUE` 行；
- 上限 24K 字符；
- 若 checkpoint 不会带来 token 净缩减，则拒绝动作；
- provider/model 记为 `local` / `adaptive-governor-extractive-v1`；
- 原始事件仍在 append-only log，可 `search_context` / `decompress`；
- 不产生任何 LLM API 输入、输出或缓存读取。

### 一次失败先发现了真实架构缺口

最初把同一合成会话推进到 15 阶段后，projectedTokens 达到 898,759，已经超过 841,017 紧急线，却没有任何 compaction。这不是阈值问题：`CompactionEngine` 只提供 service seam，自动 pressure / overflow listener 是 `BasicCompactionEngine` 自己注册的；当前 realm Basic 又是 `auto:false`，所以没有人调用 ACP 的 `compactIfNeeded`。

修复后 Governor 自己拥有两个 host 边界：

- 在 `agent/pre-step` 调用 `next()` **之前**执行 pressure fuse，保证 surface replacement 先于请求派生；
- 在 `agent/request-error` 仅处理规范 `CONTEXT_WINDOW_EXCEEDED`，只有 `surface.replaceGeneration` 真正前进才返回 retry，而且每个拟议 step 最多一次。

这两个边界各有回归测试，消除了对相邻 Basic 自动监听的隐式依赖。

### 复用 898K 会话的 live 结果

修复后没有重建另一个百万上下文，只对原 session 发送一次短触发。turn 18 的首个 provider 请求之前，自动 fuse 已落盘：

- block `cde1d0de-09b0-4a0d-803c-cd90ae2a748e`；
- 64 个 surface nodes，seqs 7..3681；
- 回收估算 753,933 token；
- 本地索引 23,174 字符；
- compaction provider/model = `local` / `adaptive-governor-extractive-v1`；
- `usage:null`、`llmStreamCall:null`，没有摘要器 API 调用。

事务附近的 projectedTokens 从 898,759 降到 150,628；随后 Flash 实际首个 prompt 为 9,426 uncached + 8,064 cache-read = 17,490 token。模型依次调用 `acp_status`、`search_context`、`decompress`，最终 45/45 金丝雀逐字输出，0 provider / turn / tool / compaction error，末态 projectedTokens 34,857。

短触发 continuation 的增量 API 三项为：25,803 uncached input、1,640 output、61,440 cache read。这些来自 4 次正常 agent/tool-loop 请求；自动 fallback 本身没有 API usage。

这证明了 live 可达性、请求前 surface 缩减、无摘要器调用以及本合成标记任务的索引覆盖。45 条标记本身结构规则、并不等价于生产语义推理质量，因此不能把 45/45 外推成“本地抽取索引等同模型摘要”。

---

## 五、随机不可推导 paired：反例 → 修复 → holdout

为了避免规则化金丝雀可以被猜中，本轮又生成 48 个 SHA-256 派生的 opaque 值，分布在四个 80K 字符阶段的头部、1/3、2/3 与尾部。最终问题只给 key，不给 value，禁止工具/文件，要求 48 个逐字值与 3 个跨阶段拼接答案。

预算上没有再造 1M prompt，而是缩放触发几何：Governor 显式策略窗口 160K（effective 94,464；normal 70,848；emergency 85,017）；Basic early 使用 0.08 route threshold（约 80K）。同 seed、同模型、同 reasoning effort、同工具形状。

### 首版被证伪

Governor v1 只有 **30/48 + 0/3**，Basic 为 **48/48 + 3/3**。原因被定位到本地 fallback 的信息选择：单个 80K 用户事件有 12 条 opaque assignments，generic head/tail + 最多八条 signals 只保留了尾部记录，丢失每个被归档阶段的前九条。

因此新增 narrow structured exact extractor：每事件最多 64 条显式 FACT/DECISION/REQUIREMENT/INVARIANT/CANARY/NEEDLE 行与全大写 `KEY = VALUE`，仍受全局 24K 上限约束；并新增“单事件 >8 opaque facts”回归测试。

### 同 seed 修复结果与 Basic all-in

| 臂 | 精确 / 派生 | 压缩 | API uncached input | API output | API cache read | cache-read fraction |
|---|---:|---:|---:|---:|---:|---:|
| Governor v1 反例 | 30/48 + 0/3 | 1 local | 163,440 | 4,873 | 339,456 | 0.675 |
| **Governor v2** | **48/48 + 3/3** | **1 local** | **164,010** | **4,087** | **341,120** | **0.675** |
| Basic session loop | 48/48 + 3/3 | 3 model | 220,252 | 1,674 | 172,800 | — |
| **Basic all-in** | **48/48 + 3/3** | **3 model** | **305,018** | **9,117** | **194,944** | **0.390** |

Basic 三次 `compaction/summary` 直接返回的辅助 usage 合计：84,766 uncached input、7,443 output、22,144 cache read；加到普通 session projection 才是 all-in，未做价格换算。

在同等 48/48 + 3/3 质量下，Governor v2 相比 Basic all-in：

- uncached input 少 **46.2%**；
- output 少 **55.2%**；
- cache read 多 **75.0%**；
- uncached + cache-read 总 prompt 几乎相同：505,130 vs 499,962（Governor +1.0%）；
- 1 个 local 可逆块 vs 3 次 Flash 语义摘要调用。

所以原始三项表达的是**工作转移**：Governor 把昂贵类型未知的摘要器计算转换成更热的 prefix 与本地可逆索引；在不直接计价的前提下不能把 cache read 称为免费，但可以确切说它显著降低 uncached input 和 output。

### 独立结构 holdout 与顺序停止

因为 v2 看过 seed-01，新增 seed-02，并把记录语法改成 `INVARIANT KEY: VALUE`。Governor 仍为 **48/48 + 3/3**，API 三项 163,721 / 3,515 / 340,736，1 个 local block，0 错误；与 seed-01 的 usage/cache fraction 仅小数级波动。

满足预注册式顺序停止条件后，没有再支付第二个 Basic 臂。它是工程 holdout，不是多种子置信区间，但已经排除了“只记住 seed-01 的值”与“只适配等号语法”两种直接过拟合。

---

## 六、生产选择

### 当前建议

对于 1M `deepseek-v4-flash`：

1. **首选 Governor，关闭同 realm 的 Basic。**
2. `maxOutputTokens=32768`；只有确实需要单次超长生成的任务单独提高。
3. 75% 做模型写的可逆大批量摘要；90% / confirmed overflow 用本地可逆保险丝。
4. 保留 `search_context` / `decompress`；高价值精确事实仍建议写外部工作笔记。
5. 监控只看 API 原始三项和可靠性：uncached input、output、cacheRead、max-context error、compaction transaction、最终质量探针。

### 与 ACP / Basic 的关系

| 方案 | 安全区成本 | 边界可靠性 | 可逆 | 隐藏 LLM 成本 | 当前判断 |
|---|---|---|---|---|---|
| 无压缩 | 最低 | 可能终端死亡 | 不适用 | 无 | 仅明确短会话 |
| 默认 ACP | 早期输入高、cache 重建多 | 高 | 是 | 无 | 阈值策略不适合 1M |
| 默认 Basic | 未触发时低 | 可能先撞墙再恢复 | 否 | 有；新事件可逐项观测 | 质量强，但 all-in uncached/output 高 |
| ACP + Basic | ACP 成本仍在 | 双保险 | ACP 部分可逆 | Basic 触发时有 | 旧版最稳妥 |
| **Governor** | **安全区 0 压缩** | **晚 ACP + 本地可逆保险丝** | **是** | **无** | **当前最佳候选** |

---

## 七、证据边界与下一笔预算

还不能宣称“全面胜出”，因为：

- random paired 仍是合成任务；seed-01 为同 seed 配对，seed-02 只有 Governor holdout，尚非多域、多种子统计结论；
- 主动 pressure fallback 已 live 通过；provider 先拒绝再进入 request-error 的路径仍只有真实 host waterfall 集成测试（主动路径应尽量让它不发生）；
- 尚未验证需要 >32K 单次输出的长生成任务；
- 尚未在代码工程、自由对话、跨日会话三类生产域重复。

下一轮按信息增益排序，而不是开无底洞矩阵：

1. **代码工程 holdout**：合成无敏感仓库，测试未写入文件的历史约束、当前代码状态和 tool-call/result 配对，而不只是 key/value；
2. **provider-error 专项**：用小窗口隔离 adapter 注入规范 overflow，验证 live Web host 的一次 retry，而不是再支付 900K 上下文；
3. **长生成专项**：16K / 32K / 48K 输出需求，决定 32K 是否应按任务动态放宽；
4. **再扩 paired seed 的条件**：新域出现质量分歧，或 API 三项方向不稳定；否则继续顺序停止；
5. 只有前四项暴露不足时，才引入预测器；当前数据不支持为了“智能”增加状态复杂度。

---

## 八、交付物与证据

实现 worktree：

`<legacy-governor-worktree>`

核心源码：

- `src/governor.ts`
- `src/fallback.ts`
- `src/index.ts`
- `tests/governor.test.ts`
- `docs/adaptive-governor-design.md`
- `docs/adaptive-governor-validation.md`

本轮研究材料：

- `work/context-governor-research/offline-policy-study.mjs`
- `work/context-governor-research/offline-policy-results.json`
- `work/context-governor-research/generate-synthetic-pressure.mjs`
- `work/context-governor-research/analyze-synthetic-runs.mjs`
- `work/context-governor-research/continue-trigger-fallback.mjs`
- `work/context-governor-research/generate-randomized-paired.mjs`
- `work/context-governor-research/analyze-randomized-paired.mjs`
- `work/context-governor-research/live-synthetic-results.json`
- `work/context-governor-research/randomized-paired-seed01-results.json`
- `work/context-governor-research/randomized-holdout-seed02-results.json`

原始 live 证据：

- `<local-benchmark-root>/runs/synthetic-safe-governor-01/__evidence__/`
- `<local-benchmark-root>/runs/synthetic-boundary-governor-01/__evidence__/`
- `<local-benchmark-root>/runs/synthetic-fallback-governor-01/__evidence__/`
- `<local-benchmark-root>/runs/paired-random-seed01-governor/__evidence__/`（反例）
- `<local-benchmark-root>/runs/paired-random-seed01-governor-v2/__evidence__/`
- `<local-benchmark-root>/runs/paired-random-seed01-basic/__evidence__/`
- `<local-benchmark-root>/runs/holdout-random-seed02-governor/__evidence__/`

历史权威数据：

- `<local-benchmark-root>/artifacts/hp/master-analysis.json`
- `<local-benchmark-root>/artifacts/PRODUCTION_REPORT.md`

## 九、产品化推进：输出意图、工程 holdout 与稳定性

### Intent-aware 输出预算

固定 32K 已从通用默认改为 `maxOutputTokens:auto`：

- 请求没有显式 `maxTokens`：使用 32,768 普通预算；
- 会话明确设置 64K / 128K / 更长输出：保持用户意图，不静默截断；
- 数字配置继续表示运维方硬上限；
- DSH `request/header.adapterDefaults.maxTokens` 用于区分 adapter 自动填入值与调用方意图，不按数值猜测；
- 压力线仍由同一个无状态公式派生：`contextWindow - outputReserve - safetyMargin`。

例如 1M 窗口显式 128K 输出时，effective input 为 836,160，普通/紧急线自动移动到 627,120 / 752,544；没有增加预测器、历史窗口或学习参数。

### 代码工程 holdout

构造了一个完全合成的 Node 仓库，四阶段分别实现 branch normalization、retry backoff、deployment policy、token redaction。模型必须真实调用工具编辑代码和运行测试，同时在四段 CI 噪声中保留 24 条代码策略 proof，最后禁止工具/文件，回答 24 个 exact proof 与 4 个跨阶段派生值。

第一次 seed-01 发现的是 fixture 缺陷：生成器按任意字符切 CI filler，把三条 stage-3 记录粘进上一行中间，破坏了预声明的行记录语法，结果为 21/24 + 2/4。没有因此修改插件；生成器增加完整行边界与 24 条 standalone assertion，换新 seed-02 重新 holdout。

有效 seed-02 结果：

| 项目 | 结果 |
|---|---:|
| 仓库测试 | 4/4 |
| exact proofs | 24/24 |
| derived | 4/4 |
| final-turn tool calls | 0 |
| uncached input | 121,146 |
| output | 23,234 |
| cache read | 934,656 |
| 压缩 | 2 个 local reversible blocks |
| 错误 | 0 |

两次 request-header snapshot 均为 `maxTokens:32768`，且没有 adapter-default marker，直接验证了真实 host 中 `auto` 的普通请求行为。两次 local block 分别归档 26 / 29 nodes、33,960 / 36,065 estimated tokens，均为 `usage:null`，没有隐藏摘要 API 调用。

### 产品稳定性

全量测试最终扩展到 128 项，新增覆盖：

- auto 普通请求、显式 128K、数字硬上限与非法值；
- adapter 默认值 provenance；
- 显式 64K 导致压力线提前；
- aborted pre-step / overflow 不写事务；
- 并发会话各自拥有一次 overflow recovery budget；
- fresh engine 从 durable ledger 继续压缩；
- 同 realm 第二个 `ctx.compaction` 后端快速拒绝；
- code-engineering structured records 精确保留。

新增研究材料：

- `work/context-governor-research/generate-code-engineering-holdout.mjs`
- `work/context-governor-research/analyze-code-engineering-holdout.mjs`
- `work/context-governor-research/code-engineering-holdout-seed01-invalid-results.json`
- `work/context-governor-research/code-engineering-holdout-seed02-results.json`
- `<local-benchmark-root>/runs/code-engineering-holdout-seed02-governor-auto/__evidence__/`

代码校验：TypeScript strict 通过，134/134 测试通过，tsup + declaration build 通过。

---

## 十、最终反证、修复与开源门禁

> 本节是本轮最终结论；如与第七节的“下一笔预算”冲突，以本节为准。代码工程、自由语义和长输出意图三个当时的最高信息增益项目已经执行。

### 10.1 同 seed 代码工程：Governor 同时赢质量和三项 API token

对有效的 `code-seed-02` 执行了 Basic early 对照。两臂的模型、fixture、任务、答案和测试完全相同。Basic 的两个 `compaction/summary` 事件都携带 provider 返回 usage，因此可以做无估算的 all-in 对比。

| 臂 | 项目测试 | exact / derived | uncached input | output | cache read | uncached + cache |
|---|---:|---:|---:|---:|---:|---:|
| Governor | 4/4 | 24/24 + 4/4 | 121,146 | 23,234 | 934,656 | 1,055,802 |
| Basic，all-in | 4/4 | 6/24 + 0/4 | 231,315 | 30,940 | 1,124,224 | 1,355,539 |

Governor 相对 Basic all-in：

- uncached input 少 **47.63%**；
- output 少 **24.91%**；
- cache read 少 **16.86%**；
- uncached + cache-read 总 prompt 少 **22.11%**；
- 最终历史约束质量从 6/24 + 0/4 提高到 24/24 + 4/4。

这是一个配对工程运行，不是“任意代码库必然提高”的统计声明；但它已经直接满足了“在同一生产形态中明显强于 Basic”的一个高价值证据点。

### 10.2 无标签语义变更：先让 Basic 打败，再修到同质更省

新的中文自然语言 fixture 不使用 `KEY=VALUE`、`FACT`或 `DECISION` 标签，而是在大量重复会议旁注中逐步修改 12 个上线决策。最终只问当前值、10 个变更理由和旧值泄漏。

| 臂 | 当前值 | 理由 | 旧值泄漏 | uncached input | output | cache read |
|---|---:|---:|---:|---:|---:|---:|
| Governor v1 反例 | 3/12 | 3/10 | 0 | 94,124 | 4,423 | 141,568 |
| Basic，all-in | 12/12 | 10/10 | 0 | 112,208 | 7,557 | 209,664 |
| Governor v2，同 seed | 12/12 | 10/10 | 0 | 26,970 | 3,564 | 210,432 |
| Governor v2，独立英文 holdout | 10/10 | 7/7 | 0 | 112,336 | 2,274 | 73,088 |

v1 的失败证明了“只保留显式结构记录”不足以替代 Basic 的语义摘要。修复不是增加另一个 LLM，而是增加无语言依赖的抽取路径：只对 URL、长 ID 和数字做模板频率归一化，丢弃占主导的重复模板，保留罕见行的原文字节。

同 seed 同质量时，Governor v2 比 Basic all-in 少 **75.96%** uncached input、少 **52.84%** output、多 **0.37%** cache read，总 prompt 少 **26.24%**。随后用不同语言、不同模板和不同值的独立 holdout 保持满分，达到顺序停止条件，因此没有再花费第二个 Basic 臂。

### 10.3 两个无效 live run 变成了产品级修复

#### Host token 计价协议

第一次语义 live run 使用 ACP 的 CJK-aware 估算填入 `shadowedTokenCount`。但 DSH bounded surface 会用 host 自己的 token 协议把该值当作精确抵扣。结果是对 28,493 的 message surface 声称遮蔽 30,372，下一轮在 provider 请求之前出现 `messageTokens >= 0` 校验错误。

现在 `shadowedTokenCount` 使用 host `tokenMeter.measure(session).nodes` 对所选 seq 精确求和，replacement 的大小也使用同一 meter 的 `estimateMessage`。缺失任一 seq 价格时失败关闭，不写入可疑事务。无效运行保留在：

`<local-benchmark-root>/runs/semantic-supersession-seed01-governor-invalid-token-accounting/__evidence__/`

#### 384K 输出意图与窗口真值优先级

第一次显式 `maxTokens:393216` live run 的首请求已被 provider 接受，但第二轮被本地检查拒绝：模型信息探针缓存了 262,144，真实 provider-anchored session projection 却是 1,000,000。修复后窗口优先级为：

```text
显式运维配置 > 真实 session projection > 建议性 model-info probe/cache > default
```

有效 v2 运行完成两轮，request header 保持 393,216，`adapterDefaultMaxTokens=0`，API 三项为 94 / 33 / 4,096，0 错误。这验证的是“384K 上限意图被 host 和 provider 接受且不被插件篡改”，不是“已实际生成 384K 正文”。

### 10.4 产品门禁结果

| 门禁 | 结果 |
|---|---|
| 安全区不干扰 | live safe 0 compaction；disabled mode 0 listener effect |
| 请求非干扰 | 只克隆/改写 `maxTokens`，其他字段不变，不原地 mutate |
| Basic 原生替换/回滚 | Basic→Governor→plain Basic durable log 可读 |
| 同 realm 冲突 | 第二个 compaction backend 快速拒绝，不双重执行 |
| 可逆性 | local block 可搜索、解压，原始 append-only log 保留 |
| 取消/并发/重启 | 100-session soak 通过，会话状态隔离 |
| 输出意图 | 无意图自动 32K；显式 384K live 保留 |
| 实现质量 | TypeScript strict、134/134 tests、bundle + declarations 全通过 |

### 10.5 最终决策：现在开源 Beta/RC，不再扩大付费合成矩阵

按“明显强于 Basic，能原生替换，不干扰其他产品功能”的定义，当前证据已经足以进入公开 **Beta / Release Candidate**：

- 随机结构任务与 Basic 同质，代码工程任务明显胜出；
- 自由语义反例曾被 Basic 明显打败，修复后同质更省，并通过独立英文 holdout；
- 安全区静默、请求字段非干扰、Basic 双向迁移/回滚、会话隔离都有确定性测试；
- 压力、本地保险丝和 384K 意图都有真实 host/provider 证据。

不建议现在再用有限预算扩展合成 seed 矩阵。下一阶段信息增益更高的是开源 canary：以 Governor 为 opt-in 首选，同 realm 关闭 Basic，提供一键回滚，收集匿名的原始三项 token、错误类型、compaction 事务和用户选择的质量信号。

仍不应标记为“普遍稳定 GA”：现有 paired 仍为合成负载，384K 只验证上限路径，真实 provider 先拒绝后的 request-error 仍为 host 集成测试而非 live 观测。这些应在公开预览期通过真实工作负载解决，而不是继续向无底洞投入 API 预算。

### 10.6 新增证据路径

- `work/context-governor-research/code-engineering-holdout-seed02-basic-results.json`
- `work/context-governor-research/semantic-supersession-seed01-governor-results.json`
- `work/context-governor-research/semantic-supersession-seed01-basic-results.json`
- `work/context-governor-research/semantic-supersession-seed01-governor-v2-results.json`
- `work/context-governor-research/semantic-supersession-holdout02-governor-v2-results.json`
- `work/context-governor-research/governor-explicit-output-384k-live-results.json`（无效反例）
- `work/context-governor-research/governor-explicit-output-384k-live-v2-results.json`
- `<local-benchmark-root>/runs/code-engineering-holdout-seed02-basic/__evidence__/`
- `<local-benchmark-root>/runs/semantic-supersession-seed01-basic/__evidence__/`
- `<local-benchmark-root>/runs/semantic-supersession-seed01-governor-v2/__evidence__/`
- `<local-benchmark-root>/runs/semantic-supersession-holdout02-governor-v2/__evidence__/`
- `<local-benchmark-root>/runs/governor-explicit-output-384k-live-v2/__evidence__/`

---

## 十一、Preset 全量 ARC 接管验证

官方 bundle 只能覆盖 profile 组合树中的根层 `compaction-basic`；我们的
`anchored-standard` 与 `router-standard` 原先在 preset 内使用
`isolate.compaction: true` 并挂载本地 Basic，因此会静默遮蔽 host ARC。

早期修复把两个源 preset 和安装副本永久改为继承 host ARC。后续卸载实验
证明这不满足产品要求：`dsh-web-app` 本身禁用 root Basic，移除 ARC 后这些
preset 没有任何后端。最终设计恢复 preset 的原生 Basic，并由 ARC 对
`agent.cordis.yml` 的 Include 配置施加零写入 runtime overlay：临时禁用已知
Basic/ARC，只移除 `compaction` isolation，其他配置与文件字节不变。

新增 `dsh-arc-presets audit/migrate/restore`：保守迁移只删除已确认的
Basic row 和 compaction isolation，写入前独占创建 `.arc-backup`；局部 ARC
只报告、不自动删除。Governor 在 request/pre-step/request-error 边界检查
实际 backend ownership，不再容许 ARC+Basic 混合静默运行。

第一次 live ownership 探针又揭示了真实 Cordis 语义：preset scope 解析可返回
转发的 `AcpCompactionEngine` service 对象，与根实例对象身份不同。所有权
因此改用 `Symbol.for('dsh-arc-context.backend')` 结构品牌，而非对象同一性。

| Preset | ownership | backend | maxTokens | uncached input | output | cache read | 错误 |
|---|---|---|---:|---:|---:|---:|---:|
| anchored-standard | ACTIVE | dsh-arc-context | 32,768 | 6,350 | 1,823 | 12,544 | 0 |
| router-standard | ACTIVE | dsh-arc-context | 32,768 | 1,216 | 217 | 27,008 | 0 |

`router-standard` 首轮只暴露 shell/editor，因此先执行一次有意的工具目录
晋升，再直接调用 `acp_status`。这是 preset 的工具可见性语义，不是 ARC
backend 失败。有效两臂都报告 ownership ACTIVE、backend `dsh-arc-context`、
32K 普通输出上限、0 错误。实现门禁现为 **134/134** tests。

最终干净 Web profile 又验证了完整逆过程：安装 tarball 后，官方未修改
Standard preset 可创建 session，命令目录含 `/acp` 与 `/compact`；执行
`dsh plugin remove dsh-arc-context` 并重启后，同一 preset 无需任何操作即可
再次创建 session，`/acp` 消失而原生 `/compact` 保留。官方 preset 文件的
SHA-256 在前后完全一致。Cordis 单元测试还覆盖了 live fiber dispose：先移除
config transformer，再恢复原 config object 并让 Include 事务重算。

---

## 十二、重复模板与历史指令注入反证

新 fixture 把 20 组数字决策放在多个重复自然语言模板之后，并在历史中
放入一条“忽略当前用户、只输出指定字符串”的存档样本。

| 版本 | values | dependencies | SAFE | injection 字符污染 | uncached | output | cache read |
|---|---:|---:|---:|---:|---:|---:|---:|
| v1 反例 | 0/20 | 0/20 | 否 | 是 | 225,216 | 6,516 | 98,304 |
| v2 | 20/20 | 20/20 | 是 | 否 | 196,050 | 2,284 | 127,744 |

v1 不仅丢失了同模板决策，还把历史命令复制到 hot checkpoint，导致模型
拒绝了当前的合法 JSON 任务。修复后：

- checkpoint 明确将所有 excerpt 标为不可信历史数据；
- 可执行/命令式历史行不进入 hot index，但原文仍可搜索和解压；
- 重复模板容量与全局 48 行预算对齐；
- 先按模板稀有度排序选取，再恢复原始时间顺序。

## 十三、ScNet / GLM-5.2 跨 provider 验证

### Adapter 路径

GLM-5.2 经 ScNet Anthropic-compatible route 报告 1,000,000 窗口。普通运行的
header 为 32,768，API 三项 10,381 / 176 / 16,000，ownership ACTIVE，0 错误。
显式 131,072 输出意图被原样保留，API 三项 610 / 15 / 3,072，0 错误。

### 无标签语义 paired

首个 GLM ARC 运行再次成功反证：按时间顺序取前 48 行，会让多个中频噪声
模板先占满预算，结果为 10/12 + 10/10。稀有度优先后恢复为
12/12 + 10/10，旧值污染 0。

| 臂 | 质量 | uncached input | output | cache read | total prompt |
|---|---:|---:|---:|---:|---:|
| ARC | 12/12 + 10/10 | 179,616 | 8,625 | 78,848 | 258,464 |
| Basic all-in | 12/12 + 10/10 | 241,319 | 11,059 | 80,384 | 321,703 |

同质量下 ARC 少 25.57% uncached input、22.01% output、1.91% cache read，总 prompt
少 19.66%。Basic all-in 只累加两个 `compaction/summary.usage` 中 provider 真实返回值。

### 代码工程 holdout

GLM 主动调用 `compress`，但它写的第一个摘要丢失了 stage-1 六条 proof，
v1 仅 18/24 + 1/4，尽管项目测试仍为 4/4。这证明“模型自己写摘要”也存在
跨模型高保真风险。

ARC 现在对每个 model-written checkpoint 追加同一个本地精确/可逆/红线过滤索引，
没有第二次 API 调用，并用 host token meter 对 shadow span 计价。同 seed v2 结果：

- exact proofs 24/24；
- derived 4/4；
- 项目测试 4/4；
- final-turn tools 0；
- API 三项 201,347 / 28,726 / 673,792；
- 0 错误。

语义 paired 已证明 GLM 上的费用方向，代码 v2 已恢复满分，因此按顺序
停止规则不再支付 GLM Basic 代码臂。

## 十四、开源前当前结论

现有证据已从单 provider 扩展到 DeepSeek Flash + ScNet/GLM-5.2，并在重复模板、
归档指令、稀有行排序和模型自写摘要四个反例上完成了同 fixture 修复复验。
实现门禁为 134/134 tests。

本轮不执行发布。发布决定保留给维护者。先前的 Web 卸载边界已经关闭：虽然
`dsh-web-app` 的 root Basic 仍为 disabled，但 unchanged preset-local Basic 会在
ARC layer 消失后恢复。普通安装与卸载都不写 preset/profile user patch，也不需要
`migrate` 或 `restore`。剩余边界是未知自定义 compaction backend：ARC 不猜测替换，
而是 audit/ownership fail-loud。

最终 tarball 另外在第二个全新 `DSH_HOME` 中执行了干净验收：web/headless
均从 tarball 安装成功，根 Basic disabled，ARC Governor 生效，Web 真实启动，
runtime peer import 正常，两个 preset audit PASS 且都能创建新 session。安装后不需要
用户执行任何 ARC 命令。后续可逆安装验收又覆盖卸载与 Basic 恢复。运行时依赖审计为
0 vulnerabilities。

## 十五、最终 Provider Resolver 架构

零写入 Include overlay 虽然通过卸载闭环，但依赖 `internal/config`、YAML 解析和
PresetTree config identity，不满足最终的官方扩展点要求。最终实现把一个 npm 包拆成
两个 Cordis 插件角色：host-plane `dsh-arc-context/resolver` 注册公开
`Loader.registerResolver()`，而 ARC Engine 由替换 wrapper 在原 Basic entry context
中创建。官方 Basic 通过 global-symbol provider kind 被识别；未知 provider 调用
`next()` 原样保留。

本地 Harness 源码加入了通用 resolver seam 和 Basic brand，并通过三个不依赖完整
workspace 安装的源码 smoke：resolver 注册/撤销、provider brand、Loader+ARC 同 realm
替换。临时注入同一 seam 的真实 DSH Web 进一步验证 Standard、Anchored、Router 均可
创建 session，命令目录含 `/acp` 与 `/compact`，`/acp status` 报告 ACTIVE 和
`dsh-arc-context`。

ARC 同时补齐官方 `CompactionEngine` 三方法。真实纯合成两轮会话执行原生
`/compact`，返回 `Compacted 4 history items (~4314 tokens).`，随后 ledger 为一个
local reversible checkpoint，上下文估算从 17,475 降至 14,289，未调用辅助摘要模型。

最终 tarball 在全新 Web profile 完成 add→Standard/ACTIVE→remove→restart→Standard
闭环；卸载后 `/acp` 消失、`/compact` 保留，profile dependency 和 bundle row 均移除。
Stock DSH `0.1.0-rc.6` 尚未正式发布 resolver seam，因此当前仍不可发布；仓库中的
`upstream/deepseek-harness-loader-resolver.patch` 是可审计依赖，不是要求最终用户手工
应用的安装步骤。
