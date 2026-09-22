---
name: seo-rank-watch
description: >
  サイトを理解し、Opportunityを発見し、優先順位をつけ、次に試す施策を
  Experiment(status: proposed)として提案する(understand -> discover ->
  prioritize -> propose)。
  「SEO改善」「検索順位を上げる」「seo-rank-watch」「検索順位を見る」
  「Opportunityを探して」と言われたら起動する。
---

# seo-rank-watch

このSkillは `seo_tryanderror`(このリポジトリのC: 自律サイト育成エンジン)を
動かす。状態管理・履歴・重複防止・遷移制御は決定論的コード(`src/core/*`)が持ち、
サイト内容の意味理解・Opportunity発見・仮説生成だけをこのSkill(=あなた)が担当する。

主語は `keyword` ではなく `Opportunity`(page × search intent × hypothesis)で
ある。詳細な型・ルールは `DESIGN.md`(正本)を参照。

**Milestone 1の範囲は `understand -> discover -> prioritize -> propose` まで。**
サイトへの書き込み、B(自然な日本語生成)の呼び出し、PR作成、publishは行わない。
`rakusetsu.com` を含む実サイト・実GSCへのアクセスは、ユーザーが明示的に許可した
場合(Milestone 1B)にのみ行う。それ以外はfixtureまたは既存の
`site-understanding.json`/`opportunities.json`/`experiments.json` に対して操作する。

## 起動条件

次のような依頼があったとき起動する。

- SEO改善
- 検索順位を上げる
- seo-rank-watch
- 検索順位を見る
- Opportunityを探して

## 手順

必ずこの順で実行する。途中を飛ばさない。

### 1. status

```bash
npm run seo -- status --config config/seo.config.json
```

`openOpportunities` / `proposedExperiments` / `observing` / `dueForReview` /
`concludedRecently` を確認する。

### 2. understand

```bash
npm run seo -- understand --config config/seo.config.json
```

サイトを読み取り専用で読み、GSC設定があればクエリ×ページ行列も取得する。
GSC未設定でも失敗しない(`GSC_NOT_CONFIGURED` として続行)。

ページ本文を読んでテーマ・独自データを言語化する部分(`themes`/
`proprietaryDataNotes`)はあなた自身が行い、`--understanding-file <json>` で
下書きを渡してよい(`{ "themes": [...], "proprietaryDataNotes": [...] }`)。

### 3. discover

まず材料を確認する(任意、書き込みなし)。

```bash
npm run seo -- discover --config config/seo.config.json --dump-inputs
```

`site-understanding.json` の内容(ページのexcerpt/headings、GSCクエリ×ページ)と、
既存Opportunityの `identity` 一覧(scopeKey/intentKey/kind/title)が出力される。
既存の需要を再発見した場合は、同じ `kind`+`intentSlug` を選ぶこと
(自由文のtitleの言い換えでintentSlugを作らない)。

その上でOpportunity候補を構造化JSONとして作り(`DiscoverOpportunityInput[]`、
`src/core/types.ts` 参照)、渡す。

```bash
npm run seo -- discover --config config/seo.config.json \
  --opportunities-file /path/to/opportunities.json
```

各候補は次を必ず持つ。

1. `scope`(`page`/`cluster`/`site`)と `kind`(統制語彙)
2. `intentSlug`(kebab-case、titleの単純な言い換えにしない)
3. `title`/`description`(人間可読の要約)
4. `evidence[]`(`gsc_query`/`gsc_page`/`serp`/`existing_page`/
   `proprietary_data`/`manual` のいずれか、根拠つき)

同一 `identity`(scopeKey+intentKey)は自動的に重複排除される(evidence追記の
み)。`rejected` なOpportunityを復活させたい場合のみ `reopen: true` +
`reopenReason` を付ける。理由の無いreopenは無視される。

独自クローラーやスクレイピングは行わない。SERP根拠が必要な場合は、あなた自身が
WebSearchを実行した要約を `evidence` に含めるか、`--serp-file` を後段の
`propose` に渡す。

### 4. prioritize

```bash
npm run seo -- prioritize --config config/seo.config.json
```

固定のbucket順位(DESIGN.md §10.4)で並んだOpportunity一覧が出る。状態は
変更しない。GSC順位(position)には依存しない。上位1件を次のproposeに使う。

候補が無ければ「何もしない」が正しい結果である。捏造しない。

### 5. propose

選んだOpportunityについて、必ず次を言語化してから
`ProposeInput`(`src/core/types.ts`)JSONを作る。

1. `hypothesis.statement`: 「こう変えれば良くなるはず」を1〜2文
2. `hypothesis.expectedSignals`: 支持されたと判断する指標
3. `action`: 変更の種類(`type`)・対象パス・内容(`summary`)・
   必須事実(`requiredFacts`)・禁止変更(`forbiddenChanges`)
4. `measurementPlan`: `targetPages`/`targetQueries`・`primaryMetric`・
   `baselineWindowDays`/`reviewWindowDays`・`minimumImpressions`

`minimumImpressions` は実際に観測されているimpressions量に合わせて誠実に決める
(閾値を下げて「十分なデータがある」ように見せない)。低トラフィックなサイト/
ページでは、実測ベースラインが1桁impressionsしか無いことも普通にある——その
場合はその事実をそのまま`minimumImpressions`に反映し、hypothesis.rationaleにも
明記する。**注意: `minimumImpressions`は「機械的にsufficientData判定できる最低
条件」であり、「その水準のimpressionsだけでcheckpointをconcludeしてよい」という
意味ではない。** `review`の`canConclude: true`は母数が極小でも機械的にtrueになり
得る——低トラフィックな候補では、`canConclude: true`でも`continue_observing`を
選ぶ判断(手順6を参照)がむしろ通常になる。

```bash
npm run seo -- propose --config config/seo.config.json \
  --opportunity-id <id> \
  --hypothesis-file /path/to/hypothesis.json \
  --serp-file /path/to/serp.json
```

同一Opportunityに既にアクティブな(`proposed`/`approved`/`applied`/
`observing`)Experimentがある場合、Active Experiment Guardにより拒否される
(exit code 1)。これは正しい挙動であり、回避策を探さない。

### 6. report

`understand`/`discover`/`propose` はそれぞれ `reports/YYYY-MM-DD-HHMMSS.md`
を生成する。内容をユーザーに要約する。「順位改善を予測断定しない」原則を守る
(観測結果のみ報告する)。

### 7. commit

このリポジトリの変更(`data/seo/*.json` 等)をcommitする場合は、通常のgit操作で
行う。含めるもの: `site-understanding.json` / `opportunities.json` /
`experiments.json` / `rank-history.json`(更新があった場合)。secretは絶対に
含めない。**Milestone 1ではサイト側の変更は発生しないため、対象サイトの
リポジトリへコミットすることはない。**

## Guardrails

- `propose` は常に指定した1件のOpportunityのみを対象とする
- Active Experiment Guard: 同一Opportunityに未終結のExperimentがある間、
  新規Experiment作成を試みない
- Opportunityのdedupeは `identity`(scopeKey+intentKey)単位。titleの言い換えで
  重複を作らない
- `rejected` は理由付きの明示的reopenなしに自動では触らない
- `rank-history.json`/`opportunities.json`/`experiments.json` の `history[]`
  は追記専用(過去entryの書き換え・削除は禁止)
- GSCの生クエリ×ページ行列・ページ全文を無制限に永続化しない
- secretをログ・commitに含めない
- 独自Google SERPスクレイパーは作らない
- noindex / canonical / URL の自動変更、大規模構造変更、複数記事一括rewriteは
  提案として出すことはあっても実行しない(実行器が無い)
- 改善効果を予測で断定しない(観測結果のみ報告する)
- 候補がなければ何もしない
- サイトへの書き込み・B呼び出し・PR作成・publishはMilestone 1では行わない

## 止まってよい場面

- 本番サイト・他repoへの書き込みが必要に見えたとき(Milestone 1では発生しない
  はず。発生したら設計解釈が誤っている可能性が高いので止まる)
- secretが不足しているとき
- GSCの所有権・認証にユーザー操作が必要なとき
- `rakusetsu.com` など実サイトへのアクセスが必要で、かつユーザーからMilestone 1B
  の明示的な許可を得ていないとき

それ以外は、fixture/既存データ/dry-runで前進し、実装・テスト・commitまで
完了させる。
