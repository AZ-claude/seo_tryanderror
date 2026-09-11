---
name: seo-rank-watch
description: >
  SEO改善を自律的に一周実行する(measure -> review due -> select one keyword ->
  analyze search need/SERP gap -> apply a minimal change -> observe)。
  「SEO改善」「検索順位を上げる」「seo-rank-watch」「検索順位を見る」
  と言われたら起動する。
---

# seo-rank-watch

このSkillは `seo_tryanderror`(このリポジトリのC: SEO自己改善)を動かす。
状態管理・履歴・再実行制御は決定論的コード(`src/core/*`)が持ち、
検索意図の理解と改善仮説だけをこのSkill(=あなた)が担当する。

## 起動条件

次のような依頼があったとき起動する。

- SEO改善
- 検索順位を上げる
- seo-rank-watch
- 検索順位を見る

## 手順

必ずこの順で実行する。途中を飛ばさない。

### 1. status

```bash
npm run seo -- status --config config/seo.config.json
```

`active` / `observing` / `dueForReview` / `achieved` を確認する。

### 2. rank fetch

```bash
npm run seo -- fetch-ranks --config config/seo.config.json --append
```

- exit 0: 成功。続行。
- exit 2 (`GSC_NOT_CONFIGURED`): GSC未設定。ユーザーに認証情報の設定を依頼し、
  それ以外の手順(due review・report生成など既存データでできる範囲)は続けてよい。
- exit 1: 取得失敗、または計測可能な登録keywordなし。既存rank-historyのまま続行。

### 3. due review

`npm run seo -- run ...`(手順7)が内部で自動的に処理する。個別コマンドは不要。

### 4. 1 keyword selection

`run` コマンドが `active` から最大1件を選ぶ(バケット優先順位はDESIGN.md参照)。
候補がなければ「何もしない」が正しい結果である。捏造しない。

### 5. WebSearchで上位1〜3件確認

選ばれたkeywordについて、あなた自身がWebSearchを実行し、上位1〜3件の
タイトル・URL・要約を集めて次の形式のJSONファイルに保存する
(`SerpInspection`、詳細は `src/core/types.ts`)。

```json
{
  "keyword": "...",
  "results": [
    { "rank": 1, "title": "...", "url": "...", "summary": "..." }
  ]
}
```

独自クローラーやスクレイピングは行わない。あなた自身の検索結果の要約のみを使う。

### 6. plan JSON生成

対象ページを読み、次を必ず言語化してから `SeoPlan` JSON(`src/core/types.ts`)を作る。

1. 「誰が・何を知りたくて検索しているか」を1〜2文(`searchNeed`)
2. 上位ページとの比較で見つかった不足点(`gaps`、1件以上)
3. 今回埋める不足点1つ(`selectedGap`、`gaps` に含まれること)
4. 変更種別(`changeType`)と具体的な変更内容(`requestedChange`)
5. 変更に必要な事実(`requiredFacts`)と、変更してはいけない事(`forbiddenChanges`)

直前の改善が `no_effect` / `worse` だった場合、同じ `changeType` を
第一候補にしない(理由があれば例外可、その理由を記録する)。

文章量を増やすこと自体を目的にしない。

### 7. main runへplan/serpを渡す

```bash
npm run seo -- run \
  --config config/seo.config.json \
  --serp-file /path/to/serp.json \
  --plan-file /path/to/plan.json
```

### 8. validation

`run` コマンドが `commands.build` / `commands.test` を実行し、
失敗時は自動的にロールバックする(改善ログも進めない)。追加操作は不要。

### 9. report

`run` コマンドが `reports/YYYY-MM-DD-HHMMSS.md` を生成する。内容をユーザーに要約する。

### 10. commit

`run` が成功した(exit 0 かつ実際に変更を適用した)場合のみ、通常のgit操作でcommitする。

```text
seo: improve <keyword>
```

含めるもの: サイト/コンテンツ変更、`improvement-log.json`、
(同runで計測した場合)`rank-history.json`。secretは絶対に含めない。

## Guardrails

- 1 runで新規改善は1 keywordのみ
- `observing` は `nextReviewDate` 前に触らない
- `achieved` は監視のみ
- `rank-history.json` は追記専用(過去entryの更新・削除は禁止)
- GSC未登録の生クエリを永続化しない(reportの提案としてのみ表示)
- secretをログ・commitに含めない
- 独自Google SERPスクレイパーは作らない
- noindex / canonical / URL の自動変更は禁止
- 大規模構造変更・複数記事一括SEO rewriteは禁止
- 改善効果を予測で断定しない(観測結果のみ報告する)
- 候補がなければ何もしない
- build/test失敗時はexperiment開始扱いにしない

## 止まってよい場面

- 本番サイトへの不可逆変更が必要なとき
- secretが不足しているとき
- GSCの所有権・認証にユーザー操作が必要なとき
- B(自然な日本語生成)側インターフェースが存在せず実site統合が不可能なとき

それ以外は、fixture/stub/dry-runで前進し、実装・テスト・commitまで完了させる。
