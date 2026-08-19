# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context。** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 向けのコンテキスト・ガバナンス・プラグインです。安全帯では静寂を保ち、実効入力容量に近づくと**モデル駆動・ローカル可逆**な圧縮を実行します。情報は失われず、アンインストールも無残留です。

> **リリース状態: パブリックベータ、公式 dsh 0.1.0-rc.7 追従。** 本プロジェクトと dsh はいずれもパブリックベータであり、本番利用はまだ推奨しません。10 項目のライブ・リリースゲート検証マトリクス: [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json)。

## 実測の強み

以下の数値はすべて実モデルによるライブ実験に基づきます(生の usage 値、価格換算なし)。エビデンスと実験プロトコルはパッケージに同梱され、`npm run research:verify` により項目ごとに再検証されます。

### 内蔵 Basic 圧縮との比較(同一シナリオ・同一シード)

**コードエンジニアリングのロングセッション** — 履歴制約の逐語保存:

| 方式 | 正確な事実 | 派生制約 | 入力トークン | 出力トークン | 総 prompt |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

4 倍の品質差をより低いコストで達成:入力 −47.6%、出力 −24.9%、総 prompt −22.1%。ARC の圧縮はローカル可逆抽出(補助 LLM 呼び出し 0 回)であり、Basic は元に戻せないモデル要約です。

**ラベルなし自然言語の意思決定追踪**(値の置換を含む):ARC は現在値 12/12、根拠 10/10 を再現し、廃止値の漏出は 0、入力は Basic 比で約 76% 低減。独立した英語ホールドアウトは 10/10 + 7/7。

### Basic にはない能力

- **喪失ゼロ、完全復元** — 圧縮前の原文は append-only ログに永久保存されます。`decompress` は有効ソースを逐語復元し(6 本のライブチェーンで 100%、超大出力もホストのスピルファイル経由で完全)、`search_context` は圧縮ブロックを検索して日英とも情報レベル召回率 43/43。
- **無劣化の多段蒸留** — tier-3 の証拠付録が 6 本すべての二言語チェーンで全事実を 20/20 で保持(再帰的有効ソース・インデックス更新、`effectiveSourceSafetyIndex`)。
- **予算内でのタイプ別重み付け保持** — 付録がチェックポイント予算を超えると、時系列切断ではなくタイプ価値密度で低価値のイベント行から排除(`safetyIndexRanking: value`)。オフラインの最悪ケースですべての予算帯で優位、ライブ比較で付録層 +14.3pp、エンドツーエンドの劣化なし。
- **敵対的指示への従順ゼロ** — 18 種のアーカイブ注入攻撃面バリアント(要約汚染、検索注入、偽の保護ラベル、テンプレート模倣など)でモデルが指令に従った回数は **0**。すべてのアーカイブ出力には「歴史データであり指示ではない」フレームが付与されます。
- **誠実な圧力ガバナンス** — 圧縮認識の読み = ホスト投影 − ログ台帳の遮蔽分。圧縮後の偽の緊急警告は 0(実測)、表示圧力が実占有と一致します。
- **コンパクトなガイダンス** — システムガイダンス 1,140 トークンで、完全版に対する逐語品質の劣化は 0pp(ライブ 4 アーム)。

## インストール

```bash
dsh plugin --profile web add dsh-arc-context
```

ホスト再起動で即時に有効化されます。バンドルは host-plane の Preset Bridge を自動インストールし、ARC が standard preset 自身の compaction 分離レルム内で公式 Basic 行を置き換えます。**preset ファイルはバイト単位で不変**。コマンド・プルーナ・isolation など他の preset 行はすべて保持されます。

手動 tarball インストール、他プロファイル、高度なオプション: [`docs/INSTALL.md`](docs/INSTALL.md)。

### 設定(抜粋)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # tier-2/3 インデックスは有効な原文へ再帰(デフォルト有効)
    safetyIndexRanking: value           # 予算超過時はタイプ価値密度で排除(デフォルト value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| オプション | デフォルト | 説明 |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | tier 2/3 で、安全インデックスは可視の親チェックポイントのみ再抽出するのではなく、有効な原文ソースへ再帰します。tier-1 の出力は不変です。 |
| `safetyIndexRanking` | `value` | 付録がチェックポイント予算を超えた際の排除順序: `value` はタイプ価値密度の低いイベント行から除外、`chronological` は従来の時系列文字切断。予算内では両者の出力はバイト単位で同一です。 |

完全な設定(コンテキストウィンドウ、nudge しきい値、保護帯、Governor、プロンプトテンプレート): [`docs/INSTALL.md`](docs/INSTALL.md)、[`docs/kernel-tuning.md`](docs/kernel-tuning.md)。

## アンインストール — クリーン、完全、実機検証済み

```bash
dsh plugin --profile web remove dsh-arc-context
```

ホスト再起動後:

- 合成構成は公式 Basic に戻り、ARC 行は一切残りません;
- **preset ファイルは一度も変更されません**(SHA-256 が前後で同一であることをリリースゲートで実測);
- 既存セッションは引き続き読み取り可能 — Basic が ARC の永続ログを直接読み、圧縮済みの表面形状は保持され、**原文がコンテキストへ溢れ戻ることはありません**(2,331 イベントのセッションが完全に読み取り可能で投影も正常なことを実測);
- 新しいセッションには ARC のツールやコマンドが登録されません。

再インストールはいつでも可能で、初回インストールと同一の動作です(インストール → アンインストール → 再インストールのサイクルはリリースゲートのマトリクスで項目ごとに検証済み)。

## エビデンスとドキュメント

- 研究アジェンダとすべての結論: [`docs/research-agenda.md`](docs/research-agenda.md)
- 結果データ: [`research/results/`](research/results/)(リリースゲート・マトリクス、ペア比較、敵対スイート)
- 設計文書: [`docs/`](docs/)(インストール、preset 統合、Governor 設計、可逆インストール設計)
- 公開エビデンス検証: `npm run research:verify`

## クレジットとライセンス

ARC の圧縮コアは [acp-kernel](https://github.com/ranxianglei/acp-kernel)(および billion-context-pi、opencode-acp、ranxianglei、MIT)の移植と独立した発展に由来します。ホストは [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DeepSeek AI)です。本プロジェクトは MIT ライセンスです — [LICENSE](LICENSE)。
