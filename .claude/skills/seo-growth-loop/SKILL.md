---
name: seo-growth-loop
description: >
  1回の実行 = 1 daily cycle。rolling PDCA(28日を待たず、複数Experimentを
  並行観測しながら、観測checkpointのreview/conclude/learnと新規Opportunityの
  discover/prioritize/propose/apply/observingを毎日回す)。
  「デイリーサイクル回して」「今日のPDCA」「seo-growth-loop」
  「サイト育成を進めて」と言われたら起動する。
---

# seo-growth-loop

`seo-rank-watch`(understand -> discover -> prioritize -> propose まで、
Milestone 1)の上に乗る、rolling PDCAの1日分。状態管理・遷移制御・重複防止・
ページ衝突防止・最大並行数は決定論的コード(`src/core/*`)が持つ。このSkillは
意味理解・Opportunity発見・仮説生成・B呼び出し・サイト変更の実行判断だけを担う。

**1つのExperimentが28日経つのを待たない。** 既存の observing 中Experimentは
そのまま並行させ、当日は別ページの新規Opportunityを最大1件だけ進める。

## 起動条件

- デイリーサイクル回して / 今日のPDCA / seo-growth-loop / サイト育成を進めて

## 前提

- `rakusetsu.com` を含む実サイト・実GSCへの操作は、ユーザーが明示的に許可した
  範囲でのみ行う(Milestone 1Bと同じ原則)。
- B(自然な日本語生成、`seo_japanese`)を実際に呼ぶ。黙ってこのSkill自身の文章
  生成で代替しない。
- サイトへの書き込みは、対象サイトのリポジトリの `AGENTS.md`/運用ルールに従う
  (通常デプロイ経路をそのまま使う。新しいdeploy方式を作らない)。

## 手順(1 daily cycle)

必ずこの順で実行する。「毎日必ず何か変更する」が目的ではない。良い
Opportunityが無ければ何もしないのが正しい結果。

### 1. Preflight

```bash
npm run seo -- status --config config/seo.config.json
```

`openOpportunities` / `proposedExperiments` / `observingExperiments` /
`dueForReviewExperiments` を確認する。HEAD/branch/worktreeがcleanであることも
確認する。

### 2. GSC + site UNDERSTAND更新

```bash
npm run seo -- understand --config config/seo.config.json --dry-run
```

異常(HTTP失敗多数、GSC認証エラー等)が無ければ、通常実行して
`site-understanding.json`/`rank-history.json` を更新する。

### 3. Active Experiment REVIEW checkpoints

`observingExperiments` の各Experimentについて:

```bash
npm run seo -- review --config config/seo.config.json \
  --experiment-id <id> --dump-inputs
```

`checkpoint` が `null`(未到来、またはfinalDataLagDays分のfinal dataがまだ無い)
なら何もしない。`checkpoint` が出た場合、`before`/`after`/`delta`/
`sufficientData`/`metricDirection` を読み、意味判断する:

- `canConclude: false`(`continue_observing`) → 通常は様子見。
  `decision: "continue_observing"` を `--review-file` で渡してcheckpointだけ
  記録する(Experimentの状態は変わらない)。
- `canConclude: true` で十分な確信が持てる → `decision: "conclude"` +
  `proposedOutcome`(`hypothesis_supported`/`partially_supported`/
  `no_effect`/`worse`/`insufficient_data`)+ `note` + 可能なら `learning` を
  `--review-file` で渡す。
  - `after.sufficientData === false` かつ最終(28日)checkpointの場合のみ
    `insufficient_data` を使う。`no_effect` と混同しない。
  - 確信が持てなければ `canConclude: true` でも `continue_observing` のままで
    よい(次のtier、あるいは28日目まで待つ)。

```bash
npm run seo -- review --config config/seo.config.json \
  --experiment-id <id> --review-file /path/to/review.json [--dry-run]
```

まずdry-runで確認し、問題なければ本実行する。concludeした場合、
Opportunityは自動的に`open`へrelease(別Experimentがまだそのopportunityを
使っていない場合のみ)。

### 4. DISCOVER

```bash
npm run seo -- discover --config config/seo.config.json --dump-inputs
```

`gscEvidence`(1〜9 impressionsのqueryも含む全件)、`experimentMemory`
(直近concluded Experimentのoutcome/learning、最大50件)を必ず読む。
**同じページ×同じ意図を過去に試して`no_effect`/`worse`だったなら、同じ施策を
繰り返さない。** `existingOpportunityIdentities` も確認し、既存の
scopeKey/intentKeyと重複させない。

必要ならOpportunity候補を作り `--opportunities-file` で渡す
(`seo-rank-watch` と同じ手順)。

### 5. PRIORITIZE

```bash
npm run seo -- prioritize --config config/seo.config.json
```

固定bucket順位(DESIGN.md §10.4)。状態は変更しない。

### 6. 安全に新しいExperimentを開始できるか確認

以下のいずれかに該当したら、**その日は新規applyなしで終了**する(handoff
不要、reportだけ書いて終わる)。

- **active Experiment数が `maxActiveExperiments` 以上**
  (`config.experiment.maxActiveExperiments`、未指定なら3)。ここでいう
  active数は `status` が `proposed`/`approved`/`applied`/`observing` の
  いずれかであるExperiment全部の数であり、`status --dump-inputs`等の
  `observingExperiments`(`status: observing` かつ `nextReviewDate` がまだ
  未到来のものだけ)ではない——両者を混同しない。実際の判定はcoreの
  `assertUnderMaxActiveExperiments()`(`propose`が内部で必ず呼ぶ)が正本
  であり、このSkillの事前チェックはproposeを試す前の目安に過ぎない。
- prioritizeの上位Opportunityが、既にactiveなExperimentと同じページ
  (`Action.targetPaths`/`MeasurementPlan.targetPages`)を指している
  → 次に確度の高い、**衝突しないページ**のOpportunityを探す。全部衝突するなら
  今日はここで終了。
- 筋の良いeligible Opportunityが無い
- 以降のB validation / build・test / deploy のいずれかが失敗した場合も、
  そこで打ち切り、それまでの結果(review/conclude等)は保存したまま報告する

この段階でのpage衝突チェックは最終的に `propose` 自体がcoreで強制する
(`ACTIVE_PAGE_EXPERIMENT_EXISTS`)。事前にprioritize結果を見て衝突しない候補を
選ぶのは、無駄なproposeを避けるための事前チェックに過ぎない。

**1 daily cycleで新規applyは最大1件。** 複数の良いOpportunityがあっても、
当日proposeしてapplyまで進めるのは1件だけにする(reviewやconcludeは複数件
処理してよい)。

### 7. PROPOSE

`seo-rank-watch` の手順4と同じ(hypothesis/action/measurementPlanを言語化して
`npm run seo -- propose ... --dry-run` → 問題なければ本実行)。

### 8. B

Milestone 1Bで確立した手順と同じ:
1. 変更したいpage roleとgoal、required facts、allowed links、forbiddenを構造化
   してBへ渡す(価格・固有名詞等の事実を捏造しない)。
2. `seo-japanese rewrite --facts <facts.json> <draft.md>` を実行し、
   `claim_preservation`(`invented===0 && modified===0` がhard gate)と
   `naturalness_scores` を確認する。

### 9. site変更

対象サイトのリポジトリを特定する(名前だけで推測せず、git remote・build
設定・実サイトとの一致で確認)。最小限のdiffで変更する(既存section/データを
壊さない、固定値の価格等を書き込まない、動的dataから読む構造を維持する)。

### 10. test/build

対象サイトの既存の正式な検証コマンド(lint/typecheck/test/build)をすべて
実行する。新しい独自テスト基盤は作らない。失敗したら日次サイクルはここで
打ち切り(apply/deployしない)。

### 11. deploy

対象サイトの既存の正式なdeploy経路をそのまま使う(新しいdeploy方式を作らない)。

### 12. live verify

deploy後、実際に対象URLをGETし、追加した内容・リンクが生きていること、
既存sectionが壊れていないこと、canonical/noindexが意図せず変化していないこと
を確認する。

### 13. APPLY → observing

```bash
npm run seo -- apply --config config/seo.config.json \
  --experiment-id <id> --evidence-file /path/to/evidence.json --dry-run
```

evidence-fileには、手順8〜12で実際に確認した事実(commit SHA、B結果、
test/build結果、live verification結果)だけを書く。dry-runが健全なら本実行し、
Experimentを `proposed -> approved -> applied -> observing` へ進める。

### 14. report

その日に行ったこと(review/conclude/learning、discover/prioritize結果、
propose/apply結果、または「今日は変更なし」)を要約する。「検索順位の改善を
予測・断定しない」原則を守る(観測結果のみ報告する)。

## Guardrails

- 1 daily cycleにつき新規apply最大1件。review/concludeは複数件可。
- `maxActiveExperiments` を超えて新規Experimentを作らない(coreがguardする)。
- 同一ページに複数のactiveなExperimentを作らない(`ACTIVE_PAGE_EXPERIMENT_EXISTS`
  としてcoreがguardする)。異なるページなら並行してよい。
- `measurementPlan.targetQueries` が既存のactiveなExperimentと1件でも完全一致
  するcandidateは作らない(`ACTIVE_QUERY_EXPERIMENT_EXISTS` としてcoreが
  guardする)。これは**exact string match**のみで、`targetQueries` を片方でも
  指定していなければ判定しない。「メガブレイブ 買取」と「メガブレイブ買取」の
  ような類似語・意味が近いだけのqueryをcoreが検知することはない——**そうした
  「同じ検索意図が明らかに重なる」候補を選ばないこと自体は、DISCOVER/PROPOSE
  時にこのSkill(あなた)の責任で判断する。** coreの2つのguard(page/query)は
  文字列一致の安全網であり、意味的な重複判断の代わりにはならない。
- `insufficient_data` を `no_effect` にすり替えない。データ不足は
  データ不足として記録する。
- checkpointは`review`の`--dump-inputs`が返す構造化データに基づいて判断する。
  独自の統計的閾値・有意性検定を発明しない(YAGNI)。
- 短期的な順位・impressions低下だけを理由に自動rollbackしない
  (rollback機能はまだ作っていない)。技術的な明確な障害(HTTP失敗、index消失、
  意図しないnoindex/canonical変化)を見つけたら、通常reviewとは別に警告する。
- schedulerへの自動登録はまだ行わない。このSkillは手動/Claude起動でのみ動く。
