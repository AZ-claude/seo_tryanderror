---
name: seo-growth-loop
description: >
  1回の実行 = 特定1サイトの1 daily cycle。rolling PDCA(28日を待たず、複数
  Experimentを並行観測しながら、観測checkpointのreview/conclude/learnと
  新規Opportunityのdiscover/prioritize/propose/apply/observingを毎日回す)。
  「<site名>のデイリーサイクル回して」「<site名>の今日のPDCA」
  「<site名>のサイト育成を進めて」と言われたら起動する。site名が無い、または
  「両方」「全サイト」「全部」と言われた場合はこのSkillではなく
  `seo-multi-site-loop` を使う(このSkillは常に単一siteだけを扱う)。
---

# seo-growth-loop

`seo-rank-watch`(understand -> discover -> prioritize -> propose まで、
Milestone 1)の上に乗る、**特定1サイトの** rolling PDCAの1日分。状態管理・
遷移制御・重複防止・ページ衝突防止・最大並行数・state/lock/reportsの
サイト間分離は決定論的コード(`src/core/*`、`config.site.key`ベース)が持つ。
このSkillは意味理解・Opportunity発見・仮説生成・B呼び出し・サイト変更の
実行判断だけを担う。

**1つのExperimentが28日経つのを待たない。** 既存の observing 中Experimentは
そのまま並行させ、当日は別ページの新規Opportunityを最大1件だけ進める。

## 起動条件

- 「rakusetsu-mainのデイリーサイクル回して」「pokecaの今日のPDCA」等、
  site名を伴う依頼。
- site名が無い依頼(「デイリーサイクル回して」等)で、かつ対象siteが文脈から
  一意に確定できる場合(例: 直前の会話で既にsiteが決まっている)。
- **「両方」「全サイト」「全部」のPDCA、またはsite名が無く複数siteのうち
  どれか判断できない依頼は、このSkillを直接起動しない。** 「両方」なら
  `seo-multi-site-loop` を使う。単一だが曖昧なら「対象siteの解決」の手順に
  従う。

## 対象siteの解決(必須、最初に行う)

このSkillは実行のたびに、対象siteの `configPath` を明示的に確定してから
以後のすべてのCLI呼び出しに使う。`config/seo.config.json` という固定パスは
使わない(そのファイル自体、実運用では存在しない)。

現在の実サイト一覧(`config/*.config.json` を実際に確認して増減を把握する。
以下は2026-09時点の既知の例であり、決め打ちの全量ではない):

| site.key        | configPath                              | baseUrl                        | source repo                  |
| ---------------- | ---------------------------------------- | ------------------------------- | ------------------------------ |
| `rakusetsu-main`  | `config/seo.rakusetsu.config.json`        | `https://rakusetsu.com/`         | `AZ-claude/moveblog`            |
| `pokeca`          | `config/seo.pokeca.config.json`           | `https://pokeca.rakusetsu.com/`  | `AZ-claude/pokeca-lottery2`      |

解決ルール:

1. ユーザーがsite名(`rakusetsu-main`/`rakusetsu`/`pokeca` 等)を明示 →
   対応する `configPath` を使う。以後このcycle内では変えない。
2. 明示が無く、直前の会話等から一意に定まるなら、それを使う(勝手な推測では
   ない一意確定のみ)。
3. **明示が無く一意にも定まらない場合は、`config/*.config.json` を実際に
   列挙してユーザーに確認する。手元の記憶や上表だけで片方を勝手に選ばない**
   (上表は新しいsiteの追加で古くなり得るため、実ファイルを都度確認する)。

以後、本Skill内のすべての `npm run seo -- ...` 呼び出しは
`--config <resolved-configPath>` を必ず付ける。この文書内の
`<resolved-config>` は、この手順で確定したconfigPathを指す。

## 前提

- 実サイト・実GSCへの操作は、ユーザーが明示的に許可した範囲でのみ行う
  (Milestone 1Bと同じ原則)。
- B(自然な日本語生成、`seo_japanese`)を実際に呼ぶ。黙ってこのSkill自身の文章
  生成で代替しない。
- **サイトへの書き込みは、対象サイトのソースrepo(上表の source repo)の
  `AGENTS.md`(および、そこが参照する共通運用ルール文書があればそれも)を
  必ずそのつど読み、そこに書かれているreview-weight tiering等の運用ルールに
  従う。** どのtierが適用されるかを本Skileや `src/core/*` にハードコードしない
  ——siteが増えても、判断は毎回そのrepoの `AGENTS.md` を読んで行う。
  「public site/API/Workerへのdeployに到達する変更はHeavy tier」のように
  Heavy tierが明記されている場合、独立review PASSより前にmerge/deployしない
  (「10. deploy」参照)。通常デプロイ経路をそのまま使い、新しいdeploy方式は
  作らない。

## 手順(1 daily cycle)

必ずこの順で実行する。「毎日必ず何か変更する」が目的ではない。良い
Opportunityが無ければ何もしないのが正しい結果。

### 1. Preflight

```bash
npm run seo -- status --config <resolved-config>
```

`openOpportunities` / `proposedExperiments` / `observingExperiments` /
`dueForReviewExperiments` を確認する。HEAD/branch/worktreeがcleanであることも
確認する。

### 2. GSC + site UNDERSTAND更新

```bash
npm run seo -- understand --config <resolved-config> --dry-run
```

異常(HTTP失敗多数、GSC認証エラー等)が無ければ、通常実行して
`site-understanding.json`/`rank-history.json` を更新する(このsiteの
`data/seo/<site.key>/` 配下だけが更新される。他siteのstateには一切触れない)。

### 3. Active Experiment REVIEW checkpoints

このsiteの `observingExperiments` の各Experimentについて:

```bash
npm run seo -- review --config <resolved-config> \
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
    よい(次のtier、あるいは28日目まで待つ)。**特に、対象ページ/クエリの
    実トラフィックが低く`minimumImpressions`をぎりぎり満たしただけ(例:
    母数が1桁impressions)の場合、`canConclude: true`は「母数がある」という
    機械的判定に過ぎず、「結論付けてよい」という意味ではない。** そうした
    checkpointでは`continue_observing`を選ぶのが通常の判断になる。低
    トラフィックなsite/pageでは今はこちらが通常の結果になる。

```bash
npm run seo -- review --config <resolved-config> \
  --experiment-id <id> --review-file /path/to/review.json [--dry-run]
```

まずdry-runで確認し、問題なければ本実行する。concludeした場合、
Opportunityは自動的に`open`へrelease(別Experimentがまだそのopportunityを
使っていない場合のみ)。

意味分類そのものが誤っていた(例: `ctr_title`と提案したが実際は
`intent_mismatch`だった)場合は、reviewのconclude(`no_effect`等)で無理に
片付けない。`npm run seo -- reject --config <resolved-config> --experiment-id
<id> --reason "..."` でExperimentをreject(履歴は保持、Opportunityは
自動release)し、必要なら `npm run seo -- reject-opportunity --config
<resolved-config> --opportunity-id <id> --reason "..."` で元Opportunityも
rejectしてから、正しいkindで新しいOpportunityをdiscoverし直す。

### 4. DISCOVER

```bash
npm run seo -- discover --config <resolved-config> --dump-inputs
```

`gscEvidence`(1〜9 impressionsのqueryも含む全件、無ければ無しとして扱う—
GSC evidenceはOpportunity作成の必須条件ではない。`existing_page`/`serp`/
`proprietary_data`等の他evidenceだけでもOpportunityは成立する。ただし
優先順位では既存ロジック通りGSC traction + confirmed gapが強い候補になる)、
`experimentMemory`(直近concluded Experimentのoutcome/learning、最大50件)を
必ず読む。**同じページ×同じ意図を過去に試して`no_effect`/`worse`だったなら、
同じ施策を繰り返さない。** `existingOpportunityIdentities` も確認し、既存の
scopeKey/intentKeyと重複させない。**これはこのsiteのstateだけを見る——他
siteのOpportunity/Experiment/learningは一切参照・混在させない(coreが
site.keyでstateを分離しているため、そもそも別siteのデータはここに出てこない)。**

必要ならOpportunity候補を作り `--opportunities-file` で渡す
(`seo-rank-watch` と同じ手順)。

### 5. PRIORITIZE

```bash
npm run seo -- prioritize --config <resolved-config>
```

固定bucket順位(DESIGN.md §10.4)。状態は変更しない。

### 6. 安全に新しいExperimentを開始できるか確認

以下のいずれかに該当したら、**その日は新規applyなしで終了**する(handoff
不要、reportだけ書いて終わる)。

- **active Experiment数が `maxActiveExperiments` 以上**
  (`config.experiment.maxActiveExperiments`、未指定なら3。このsiteの
  configの値を使う——他siteのmaxActiveExperimentsやactive数と混同しない)。
  ここでいうactive数は `status` が `proposed`/`approved`/`applied`/
  `observing` のいずれかであるこのsiteのExperiment全部の数であり、
  `status --dump-inputs`等の `observingExperiments`(`status: observing`
  かつ `nextReviewDate` がまだ未到来のものだけ)ではない——両者を混同しない。
  実際の判定はcoreの `assertUnderMaxActiveExperiments()`(`propose`が内部で
  必ず呼ぶ)が正本であり、このSkillの事前チェックはproposeを試す前の目安に
  過ぎない。
- prioritizeの上位Opportunityが、既にこのsiteでactiveなExperimentと同じ
  ページ(`Action.targetPaths`/`MeasurementPlan.targetPages`)を指している
  → 次に確度の高い、**衝突しないページ**のOpportunityを探す。全部衝突するなら
  今日はここで終了。
- 筋の良いeligible Opportunityが無い
- 以降のB validation / build・test / deploy / independent review の
  いずれかが失敗・PASSしなかった場合も、そこで打ち切り、それまでの結果
  (review/conclude等)は保存したまま報告する

この段階でのpage衝突チェックは最終的に `propose` 自体がcoreで強制する
(`ACTIVE_PAGE_EXPERIMENT_EXISTS`)。事前にprioritize結果を見て衝突しない候補を
選ぶのは、無駄なproposeを避けるための事前チェックに過ぎない。

**1 daily cycleにつき、このsiteでの新規applyは最大1件。** 複数の良い
Opportunityがあっても、当日proposeしてapplyまで進めるのは1件だけにする
(reviewやconcludeは複数件処理してよい)。

### 7. PROPOSE

`seo-rank-watch` の手順5と同じ(hypothesis/action/measurementPlanを言語化して
`npm run seo -- propose --config <resolved-config> ... --dry-run` → 問題
なければ本実行)。

### 8. B

Milestone 1Bで確立した手順と同じ:
1. 変更したいpage roleとgoal、required facts、allowed links、forbiddenを構造化
   してBへ渡す(価格・固有名詞等の事実を捏造しない)。
2. `seo-japanese rewrite --facts <facts.json> <draft.md>` を実行し、
   `claim_preservation`(`invented===0 && modified===0` がhard gate)と
   `naturalness_scores` を確認する。

### 9. site変更

対象サイトのリポジトリを特定する(名前だけで推測せず、git remote・build
設定・実サイトとの一致で確認。上表はあくまで既知の対応表であり、必ず実際に
確認する)。最小限のdiffで変更する(既存section/データを壊さない、固定値の
価格等を書き込まない、動的dataから読む構造を維持する)。

**対象repoの `AGENTS.md` がHeavy tier(public site/API/Worker deploy等)を
要求している場合:** ここから先はコミットを直接mainへ積まない。専用branchを
作り、コミットする(この段階ではPRはまだ作らない——テストまで通してから
「11. test/build」の後でPRを作る)。Light tier、またはtiering自体が
無いrepoの場合は、そのrepoの通常の直接コミット手順に従ってよい。

### 10. test/build

対象サイトの既存の正式な検証コマンド(lint/typecheck/test/build。READMEや
CI workflow定義に実際に書かれているコマンドを使う——推測しない)をすべて
実行する。新しい独自テスト基盤は作らない。失敗したら日次サイクルはここで
打ち切り(apply/deployしない)。

### 11. PR + independent review(Heavy tierのときだけ)

「9. site変更」でHeavy tierと判定したrepoの場合:

1. branchをpushし、PRを作成する。PR本文にC(`seo_tryanderror`)側の
   Experiment/Opportunity provenance(id・kind・baseline)を明記する。
   「改善を保証する」ような表現は書かない。
2. **実装したagent自身ではない、独立したreviewer(別セッション/別agent)**に
   diffを読ませ、実際にそのrepoのtest/buildコマンドを実行させて検証させる。
   実装側の結論を鵜呑みにせず、独立に再検証するよう明示的に指示する。
   チェック観点の例: Experimentとの整合、factual claims(捏造値が無いか)、
   diffのscope(無関係なfile/collector/DB/生成data/workers/APIに触れていないか)、
   title/meta正しさ、accessibility、canonical/noindex、生成dataの永続性
   (SEO文言が再生成されるpublic data等に紛れ込んでいないか)、tests、
   deployment影響、対象repoのAGENTS.md。
3. 指摘(finding)があれば修正し、substantiveなものがあれば再レビューする。
   **独立reviewがPASSするまでmerge/deployしない。**

Light tier、またはtiering自体が無いrepoでは、この手順は不要(そのrepoの
通常運用に従う)。

### 12. deploy

PASS後(Heavy tierならreview PASS後にmerge)、対象サイトの既存の正式な
deploy経路をそのまま使う(新しいdeploy方式は作らない)。

### 13. live verify

deploy後、実際に対象URLをGETし、追加した内容・リンクが生きていること、
既存sectionが壊れていないこと、canonical/noindexが意図せず変化していないこと
を確認する。

### 14. APPLY → observing

```bash
npm run seo -- apply --config <resolved-config> \
  --experiment-id <id> --evidence-file /path/to/evidence.json --dry-run
```

evidence-fileには、手順8〜13で実際に確認した事実(commit SHA、B結果、
test/build結果、Heavy tierならreview結果、live verification結果)だけを書く。
dry-runが健全なら本実行し、Experimentを
`proposed -> approved -> applied -> observing` へ進める。

### 15. report

その日に行ったこと(review/conclude/learning、discover/prioritize結果、
propose/apply結果、または「今日は変更なし」)をこのsite単位で要約する。
「検索順位の改善を予測・断定しない」原則を守る(観測結果のみ報告する)。

## Guardrails

- 1 daily cycleにつき、このsiteでの新規applyは最大1件。review/concludeは
  複数件可。
- `maxActiveExperiments` を超えて新規Experimentを作らない(coreがguardする。
  このsiteのconfigの値のみを見る)。
- 同一ページに複数のactiveなExperimentを作らない(`ACTIVE_PAGE_EXPERIMENT_EXISTS`
  としてcoreがguardする)。異なるページなら並行してよい。他siteの同名/類似
  ページとは衝突しない(state自体が別ディレクトリ)。
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
- Heavy tierのrepoで、独立review PASS前にmerge/deployしない。
- site固有のtier判定・repo対応を `src/core/*` にハードコードしない
  ——毎回そのrepoのAGENTS.md/上表を確認する。
- schedulerへの自動登録はまだ行わない。このSkillは手動/Claude起動でのみ動く。
