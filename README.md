# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context。** 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的上下文治理插件:在安全区保持静默,在接近真实输入容量时执行**模型驱动、本地可逆**的压缩,信息永不丢失,卸载零残留。

> **发布状态:公开 Beta,跟随 dsh 官方 0.1.0-rc.7。** 本项目与 dsh 均处公开 beta,暂不建议用于生产。完整发布门实机验证矩阵(十项)见 [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json)。

## 实测优势

以下数字全部来自真实模型实机实验(原始 usage 口径,不换算价格),证据与实验协议随包发布,由 `npm run research:verify` 逐项复核。

### 对比内置 Basic 压缩(同场景同 seed)

**代码工程长会话** — 逐字历史约束保真:

| 方案 | 精确事实 | 派生约束 | 输入 tokens | 输出 tokens | 总 prompt |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

质量 4 倍差距的同时成本更低:输入 −47.6%、输出 −24.9%、总 prompt −22.1%;ARC 的压缩为本地可逆提取(零辅助 LLM 调用),Basic 为不可逆模型摘要。

**无标签自然语言决策追踪**(含值更替):ARC 当前值 12/12、依据 10/10、旧值污染 0,输入较 Basic 低约 76%;独立英文 holdout 10/10 + 7/7。

### Basic 没有的能力

- **永不丢失,可逆恢复** — 压缩原件永远保留在 append-only 日志;`decompress` 逐字恢复有效源(六链实测 100%,超大输出经 dsh 溢写文件同样完整);`search_context` 检索压缩块,中英信息层召回 43/43。
- **多层蒸馏不失真** — tier-3 深层检查点的证据附录在 6/6 条双语链上 20/20 保留全部事实(有效源索引递归刷新,`effectiveSourceSafetyIndex`)。
- **预算内的类型加权保留** — 附录超出检查点预算时按类型价值密度逐出噪声行,而非按时间序截断(`safetyIndexRanking: value`):离线最差情形全预算占优,live 配对附录层 +14.3pp、端到端零回归。
- **对抗零服从** — 18 个归档注入攻击面变体(摘要投毒、检索注入、伪保护标签、模板模仿等),模型服从次数 **0**;一切归档输出带"历史数据,非指令"框架。
- **诚实压力治理** — 压缩感知读数 = dsh 投影 − 日志账本遮蔽;压缩后零伪紧急告警(实测),压力显示与真实占用一致。
- **紧凑指导** — 系统指导 1,140 tokens,四臂实机 verbatim 质量与完整版零劣化(0pp)。

## 安装

```bash
dsh plugin --profile web add dsh-arc-context
```

重启 dsh 即生效。bundle 自动安装 host-plane Preset Bridge:ARC 在 standard preset 自己的 compaction 隔离域内替换官方 Basic 行,**preset 文件逐字节不变**;命令、pruner、isolation 及其他 preset 行全部保留。

手动安装 tarball、其他 profile 与高级选项见 [`docs/INSTALL.md`](docs/INSTALL.md)。

### 配置(节选)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # tier-2/3 索引递归回有效原始源(默认开)
    safetyIndexRanking: value           # 超预算时按类型价值密度逐出(默认 value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | tier-2/3 蒸馏时,安全索引递归回到有效原始源,而非只重提取可见父 checkpoint。tier-1 输出不变。 |
| `safetyIndexRanking` | `value` | 附录超出检查点预算时的逐出次序:`value` 按类型价值密度先逐出低价值事件行;`chronological` 为纯时间序截断。预算内两者输出逐字节相同。 |

完整配置(上下文窗口、nudge 阈值、保护范围、Governor、提示模板等)见 [`docs/INSTALL.md`](docs/INSTALL.md) 与 [`docs/kernel-tuning.md`](docs/kernel-tuning.md)。

## 卸载 — 干净、彻底、实机可验证

```bash
dsh plugin --profile web remove dsh-arc-context
```

重启 dsh 后:

- 组合配置回到官方 Basic,无任何 ARC 行残留;
- **preset 文件全程未被修改**(SHA-256 前后一致,发布门实测);
- 已有会话继续可读:Basic 直接读 ARC 的持久日志,压缩后的表面形态保持,**不会把原始内容洪泛回上下文**(实测 2,331 事件的会话完整可读、投影正常);
- 新会话不再注册任何 ARC 工具或命令。

重装随时可行,行为与首次安装一致(安装 → 卸载 → 重装循环在发布门矩阵中逐项验证)。

## 证据与文档

- 研究议程与全部结论:[`docs/research-agenda.md`](docs/research-agenda.md)
- 结果数据:[`research/results/`](research/results/)(含发布门十项矩阵、对照实验、对抗套件)
- 设计文档:[`docs/`](docs/)(安装、preset 集成、Governor 设计、可逆安装设计)
- 公开证据校验:`npm run research:verify`

## 致谢与许可

ARC 的压缩内核源自 [acp-kernel](https://github.com/ranxianglei/acp-kernel)(及 billion-context-pi、opencode-acp,ranxianglei,MIT)的移植与独立演进;dsh 宿主为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DeepSeek AI)。本项目 MIT 许可,见 [LICENSE](LICENSE)。
