# Public research bundle

本目录用于让公开结论可检查，而不是进入插件运行时。

## 目录

- `bench/`：RQ1 统一实验台（种子化任务生成 → 真实会话 → 评分 → 成本账本），见 bench/README.md；
- `fixtures/`：完全合成的阶段输入、answer key 和小型代码 fixture；
- `scripts/`：生成器、分析器和结果一致性校验；
- `results/`：API/provider 返回的输入、输出、缓存读取及质量评分；
- `profiles/`：缩放窗口、384K 输出意图等实验配置；
- `reports/`：完整中文研究报告。
- `legacy-experiment-configs/`：正式 ARC 迁移前的对照 preset/profile 快照，只用于复现旧实验。
- `results/PREOPEN_RELEASE_RESULTS.json`：重复模板、归档指令、ScNet/GLM-5.2 和开源前门禁的汇总。

## 成本口径

只报告三类 API 原始值：

1. uncached input tokens；
2. output tokens；
3. cache-read tokens。

Basic 的 all-in 数值只把 `compaction/summary.usage` 中真实返回的字段逐项加入 session usage，不做计价或 token 估算。

## 有效与无效运行

反例和无效运行不会删除：

- `code-engineering-holdout-seed01-invalid-results.json`：fixture 任意字符切分破坏了预声明的行记录语法；没有用于修改插件。
- `governor-explicit-output-384k-live-results.json`：暴露 stale 262K advisory probe；v2 为修复后的有效运行。
- Governor semantic v1：有效的质量反例，触发 distinctive-line 修复。

`results/PRODUCT_READINESS_RESULTS.json` 是当前发布门禁的机器可读摘要。

## 原始 mux evidence

本仓库提交可重建 fixture、分析器和凝练结果，不提交体积更大且包含 host 绝对路径/系统提示的原始 mux event 流。原始文件在实验机上按 run id 保留；公开发布前可通过独立 artifact release 上传经过路径脱敏的压缩包。`EVIDENCE_MANIFEST.json` 记录 run id、状态和对应结果文件，不把本机路径作为可复现接口。

## 校验

```bash
npm run research:verify
```

校验器检查关键算术、质量门槛、fixture/answer-key 完整性以及公开文件中的常见凭据模式。
