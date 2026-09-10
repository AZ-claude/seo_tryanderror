# DESIGN — seo_tryanderror v1

最終更新: 2026-09-10
対象: Codex実装用の正本

## 0. 実装指示

このドキュメントを読んだCodexは、**追加の設計確認を待たず、v1を実装・テスト・コミットまで完了すること**。

設計上の不明点は、以下の優先順位で解決する。

1. この `DESIGN.md`
2. `HANDOFF.md`
3. YAGNI
4. fixture/stubで前進

ユーザー確認待ちにしてよいのは、secret/外部アカウント設定/本番不可逆変更のみ。

---

## 1. ゴール

AIが次のclosed loopを自律実行できるSEO改善基盤を作る。

```text
measure -> review due experiments -> choose exactly one keyword ->
analyze search need/SERP gap -> produce one change plan ->
apply via B/site adapters -> validate -> record -> cooldown -> later measure again
```

v1は**実サイト非依存のcore + adapter構造**とし、fixtureのみでE2Eを成立させる。

---

## 2. 技術方針

- Node.js 20+
- ESM
- TypeScriptを採用
- package manager: npm
- test: Node built-in test runner (`node:test`) または Vitestのどちらか。依存を減らすため `node:test` を優先
- runtime validation: Zodを採用してよい。依存1個で済むなら利用可
- persistence: JSON files
- no DB
- no web UI
- no GitHub Actions requirement
- no custom SERP scraping

---

## 3. Repository構成

実装後の最低構成:

```text
README.md
HANDOFF.md
DESIGN.md
package.json
tsconfig.json
.gitignore

src/
  cli.ts
  core/
    run.ts
    status.ts
    select-keyword.ts
    review.ts
    plan.ts
    report.ts
    types.ts
    schemas.ts
    date.ts
  adapters/
    gsc.ts
    search.ts
    natural-writer.ts
    site.ts
  infra/
    json-store.ts
    fs-lock.ts
    logger.ts

scripts/
  seo-status.ts
  fetch-gsc-ranks.ts
  record-ranks.ts

config/
  seo.config.example.json

data/seo/
  watchwords.example.json
  rank-history.example.json
  improvement-log.example.json

fixtures/
  site/
  data/seo/
  search/

test/
  status.test.ts
  select-keyword.test.ts
  review.test.ts
  store.test.ts
  dry-run.test.ts
  e2e-fixture.test.ts
```

`.claude/skills/seo-rank-watch/SKILL.md` も作る。

Codex互換の利用を主にする場合でも、Claude Skill形式は公開実装の再現性が高いため保持する。

---

## 4. Config

`seo.config.json`

```json
{
  "schemaVersion": 1,
  "site": {
    "baseUrl": "https://example.com",
    "repoRoot": ".",
    "contentRoot": "content"
  },
  "gsc": {
    "property": "sc-domain:example.com",
    "credentialsEnv": "GSC_SERVICE_ACCOUNT_JSON",
    "defaultWindowDays": 28,
    "reviewWindowDays": 7,
    "finalDataLagDays": 3
  },
  "experiment": {
    "cooldownDays": 7,
    "oneKeywordPerRun": true
  },
  "commands": {
    "build": "npm run build",
    "test": "npm test"
  },
  "adapters": {
    "writer": "stub",
    "site": "fixture",
    "search": "fixture"
  }
}
```

設定schemaをZod等で検証する。

---

## 5. Domain Types

### KeywordRecord

```ts
type Priority = 'high' | 'medium' | 'low';

type KeywordRecord = {
  keyword: string;
  targetPath: string;
  priority: Priority;
};
```

### RankMeasurement

```ts
type RankMeasurement = {
  keyword: string;
  rank: number | null;
  impressions: number;
  clicks: number;
  url?: string;
};
```

### RankHistoryEntry

```ts
type RankHistoryEntry = {
  date: string;
  source: 'gsc' | 'websearch' | 'manual' | 'fixture';
  window?: { start: string; end: string; days: number };
  measurements: RankMeasurement[];
  note?: string;
};
```

### ImprovementStatus

```ts
type ImprovementStatus = 'active' | 'observing' | 'achieved';
```

### ImprovementAction

```ts
type ImprovementAction = {
  date: string;
  rankAtAction: number | null;
  rankSource: RankHistoryEntry['source'];
  searchNeed: string;
  gap: string[];
  done: string;
  changeType: 'title' | 'description' | 'intro' | 'faq' | 'content' | 'internal_link' | 'data' | 'other';
  sources: string[];
  baseline?: {
    impressions?: number;
    clicks?: number;
  };
  review?: {
    date: string;
    outcome: 'achieved' | 'improved_not_achieved' | 'no_effect' | 'worse' | 'insufficient_data';
    previousRank: number | null;
    currentRank: number | null;
    notes: string;
  };
};
```

### ImprovementKeywordState

```ts
type ImprovementKeywordState = {
  keyword: string;
  targetPath: string;
  status: ImprovementStatus;
  nextReviewDate: string | null;
  actions: ImprovementAction[];
};
```

---

## 6. JSON Store rules

### watchwords.json

- schemaVersion必須
- keywordsはkeyword一意
- targetPath必須
- priority必須

### rank-history.json

**append-onlyをコードで保証する。**

禁止:

- 過去entry更新
- 過去entry削除
- 同じ `date + source` の再追記

`appendRankHistory()` のみwrite APIとして公開する。

### improvement-log.json

変更可能だが、action履歴はappend-only。

status/nextReviewDateは更新可。

---

## 7. Lock

二重実行を避ける。

`data/seo/.run.lock` を利用。

run開始時:

- lockなし -> create
- lockあり + 十分新しい -> `RUN_ALREADY_ACTIVE` で終了
- stale lock ->警告してreplace

process終了時に必ず解除。

fixture testを作る。

---

## 8. GSC Adapter

interface:

```ts
interface GscAdapter {
  fetchRankWindow(input: {
    property: string;
    startDate: string;
    endDate: string;
    watchwords: KeywordRecord[];
  }): Promise<{
    measurements: RankMeasurement[];
    unregisteredQueries: Array<{
      query: string;
      rank: number;
      impressions: number;
      clicks: number;
    }>;
  }>;
}
```

real implementation:

- Service Account JSON path from env
- OAuth JWT
- scope `https://www.googleapis.com/auth/webmasters.readonly`
- POST Search Console `searchAnalytics/query`
- dimensions = `['query']`
- rowLimit = 5000
- dataState = `final`

watchword照合 normalize:

```text
NFKC
lowercase
remove whitespace
```

未登録query:

- impressions >= 10
- impressions desc
- top 20
- **永続化しない**
- reportにのみ含める

credentialなし:

- throw typed error `GSC_NOT_CONFIGURED`
- 失敗扱いと「順位0件」を混同しない

`fetch-gsc-ranks` CLI exit:

- 0 success
- 1 attempted but failed/no measurable registered words
- 2 not configured

### Date window

通常:

- end = today - finalDataLagDays
- start = end - (days - 1)

レビュー:

改善直後のデータが混ざらないよう、可能ならaction日翌日以降のreviewWindowDaysを使う。

データ不足時は `insufficient_data` とし、効果なしと誤判定しない。

---

## 9. Search Adapter

AI/web tool自体をNodeから直接呼ぶ実装はv1では必須ではない。

interface:

```ts
interface SearchAdapter {
  inspectSerp(input: {
    keyword: string;
    targetUrl: string;
    topN: number;
  }): Promise<SerpInspection>;
}
```

```ts
type SerpInspection = {
  keyword: string;
  results: Array<{
    rank: number;
    title: string;
    url: string;
    summary: string;
  }>;
};
```

fixture implementationを必須。

real環境ではSkillを実行するcoding agent自身がWebSearchを行い、構造化JSONをCLIへ渡せる設計にする。

`--serp-file <json>` を受け付ける。

独自Google scraperは作らない。

---

## 10. Status calculation

`getStatus()` は次のbucketを返す。

```ts
{
  dueForReview: KeywordRecord[];
  observing: KeywordRecord[];
  active: KeywordRecord[];
  achieved: KeywordRecord[];
}
```

分類:

- achieved -> achieved
- observing && nextReviewDate <= today -> dueForReview
- observing && nextReviewDate > today -> observing
- else -> active

activeは最新rankの良い順に並べる。ただしselect logicは別関数。

---

## 11. Review logic

run開始時、まずdue reviewを処理する。

1 runでレビューは複数処理してよい。

**ただし新規改善は1 keywordのみ。**

判定:

- current rank == 1 -> achieved
- baseline/current両方あり、current < baseline -> improved_not_achieved / status active
- baseline/current両方あり、current > baseline -> worse / status active
-同値 -> no_effect / active
- 比較不能 -> insufficient_data / 原則 observing継続または明示的nextReview再設定

`insufficient_data` を `no_effect` として扱わない。

no_effect/worse後の次回改善では、直前の`changeType`と同じものを第一候補にしない。

---

## 12. Keyword selection

pure functionで実装しtestする。

候補はactiveのみ。

scoreではなく明示bucket優先順位にする。

### Bucket 1

rank 2〜10 and impressions > 0

sort:

1. rank asc
2. impressions desc
3. priority high > medium > low

### Bucket 2

rank >10 and <=20 and impressions > 0

sort impressions desc -> rank asc -> priority

### Bucket 3

過去actionあり and active

sort 最終reviewが古い順

### Bucket 4

rank null and priority high

### Bucket 5

unregisteredQueries

v1では自動追加しない。

reportにsuggestionとして出すだけ。

よって実際の自動selectionはBucket1〜4まで。

候補なし -> null。

---

## 13. Search Need / Gap / Plan

AI判断部分は構造化input/outputに固定する。

### PlanInput

```ts
type SeoPlanInput = {
  keyword: KeywordRecord;
  latestMeasurement: RankMeasurement | null;
  targetPage: {
    path: string;
    content: string;
  };
  serp: SerpInspection;
  previousActions: ImprovementAction[];
};
```

### PlanOutput

```ts
type SeoPlan = {
  searchNeed: string;
  evidence: string[];
  gaps: string[];
  selectedGap: string;
  changeType: ImprovementAction['changeType'];
  requestedChange: string;
  requiredFacts: string[];
  forbiddenChanges: string[];
  sources: string[];
};
```

validation:

- searchNeed 1〜2文相当
- gaps >=1
- selectedGapはgapsのいずれか
- requestedChange必須
- previous no_effect/worseと同じchangeTypeなら警告。代替不能なら許可理由必須

Planner real implementationはagent Skill側に任せる。

CLIには `--plan-file` を用意。

fixture plannerも用意。

---

## 14. Natural Writer Adapter (B)

CとBの境界を固定する。

interface:

```ts
interface NaturalWriterAdapter {
  transform(input: {
    mode: 'create' | 'revise';
    targetLanguage: 'ja';
    contentType: 'article';
    existingText?: string;
    searchNeed: string;
    requiredFacts: string[];
    requiredChanges: string[];
    forbiddenChanges: string[];
    targetKeyword: string;
  }): Promise<{
    text: string;
    preservedFacts: string[];
    warnings: string[];
  }>;
}
```

v1:

- `StubNaturalWriterAdapter`
- `CliNaturalWriterAdapter` skeleton

CLI adapter contract:

configでcommand templateを指定可能にしてもよいが、v1で複雑化しない。

最小案:

```text
writer-command --input tmp/request.json --output tmp/response.json
```

B未接続でもfixture E2Eが通ること。

C側で「人間らしい文章」の評価ロジックを持たない。

---

## 15. Site Adapter

interface:

```ts
interface SiteAdapter {
  readPage(targetPath: string): Promise<{ path: string; content: string }>;
  apply(input: {
    targetPath: string;
    newText: string;
    plan: SeoPlan;
  }): Promise<{ changedFiles: string[]; summary: string }>;
  validate(): Promise<{ ok: boolean; output: string }>;
}
```

v1 fixture adapterを必須。

real generic filesystem adapterも作る。

ただしサイトごとに生成物/正本が異なるため、HTMLを決め打ちして編集しない。

site adapter configに `pathMap` またはresolver hookを持たせる。

YAGNIのため、初版はMarkdown sourceを対象にしたfilesystem adapterでよい。

---

## 16. Transaction semantics

重要。

改善が途中で失敗した場合、`observing` にしてはいけない。

run sequence:

```text
load state
acquire lock
measure
review due
select
if none -> report and exit 0
read target
load/obtain SERP
load/obtain plan
call writer
stage/apply site change
validate build/test
if validate fails:
  rollback working files if possible
  do NOT append action
  do NOT set observing
  report failure
  exit 1
else:
  append action
  set observing
  set nextReviewDate
  write state atomically
  report success
release lock
```

JSON file writesはtemp file + renameでatomicにする。

---

## 17. Dry Run

全run commandに `--dry-run` を付ける。

Dry runでは:

- measurement fetchはしてよい
- status/review/selection/planは実行してよい
- site writeしない
- state JSON writeしない
- commitしない
- reportには `DRY RUN` を明記

必須testあり。

---

## 18. CLI

### Main

```bash
npm run seo -- run --config seo.config.json
```

options:

```text
--dry-run
--date YYYY-MM-DD
--serp-file PATH
--plan-file PATH
--fixture
```

`--date` はtest/replay用。

### Status

```bash
npm run seo -- status --config seo.config.json
```

### Fetch GSC

```bash
npm run seo -- fetch-ranks --config seo.config.json --append
npm run seo -- fetch-ranks --config seo.config.json --days 7
```

### Record manual/websearch

```bash
cat ranks.json | npm run seo -- record-ranks --source websearch
```

未登録watchwordは拒否。

---

## 19. Report format

各runでMarkdown + console summaryを出す。

`reports/YYYY-MM-DD-HHMMSS.md`

最低項目:

- measurement source/window
- 前回から大きく上昇/下降した語
- reviewした実験と判定
- observing中の語 + nextReviewDate
- 選択したkeyword + 理由
- searchNeed
- SERP gap
- requestedChange
- 実際に変更した内容
- validation結果
- unregistered query suggestions
- dry-run/error information

順位改善を予測断定しない。

---

## 20. Claude/Codex Skill

`.claude/skills/seo-rank-watch/SKILL.md` に以下を記載。

起動条件:

- SEO改善
- 検索順位を上げる
- seo-rank-watch
- 検索順位を見る

Skillは必ず:

1. `status`
2. rank fetch
3. due review
4. 1 keyword selection
5. WebSearchで上位1〜3件確認
6. plan JSON生成
7. main runへplan/serpを渡す
8. validation
9. report
10. commit

の順で動く。

SkillにもGuardrailsを明記。

---

## 21. Guardrails

- 1 runで新規改善は1 keyword
- observingは期限前に触らない
- achievedは監視のみ
- rank-historyはappend-only
- raw GSC未登録queriesを保存しない
- secretsをログ/commitしない
- custom Google SERP scraper禁止
- noindex自動変更禁止
- canonical自動変更禁止
- URL自動変更禁止
- 大規模構造変更禁止
- 複数記事一括SEO rewrite禁止
- 改善効果を予測で断定しない
- 候補なしなら何もしない
- build/test失敗時にexperiment開始扱いにしない

---

## 22. Tests

最低限以下を全部実装。

### status.test

- active
- observing before date
- observing due
- achieved

### selection.test

- 2〜10位優先
- impressionsなしをBucket1に入れない
- 11〜20位
- previous action
- high/null
- observing除外
- achieved除外
- no candidate -> null
- exactly one

### history.test

- append works
- duplicate date/source rejected
- previous entry unchanged

### review.test

- achieved
- improved
- same
- worse
- insufficient data

### dry-run.test

- zero persistent file mutations

### transaction.test

- site validation failure -> improvement log unchanged
- successful validation -> observing/action append

### gsc-normalize.test

- NFKC
- case
- whitespace

### e2e-fixture.test

fixture dataset:

- keyword A rank 4 impressions >0 active
- keyword B rank 8 observing future
- keyword C achieved

run結果:

- Aのみ選択
- fixture SERPを読む
- fixture planを読む
- stub writerが変更
- fixture siteに反映
- validate pass
- Aがobserving
- nextReviewDateが設定
- action 1件
- B untouched
- C untouched
- report生成

---

## 23. README

READMEには次だけを明確に書く。

- このPJがCであること
- A/B/C図
- quick start fixture
- GSC setup
- real site adapter接続
- B接続方法
- daily operation
- state files meaning
- guardrails
- troubleshooting

fixture quick startはcredential不要で必ず再現可能にする。

例:

```bash
npm install
npm test
npm run seo -- run --fixture --date 2026-09-10
```

---

## 24. GSC Setup

READMEへ以下を含める。

1. Google Cloud project
2. Search Console API enable
3. service account create
4. JSON key取得
5. Search Console propertyへservice account emailを制限付きユーザー等として追加
6. keyをrepo外またはgitignore済みprivateへ保存
7. `GSC_SERVICE_ACCOUNT_JSON=/path/to/key.json`

`.gitignore`:

```text
private/
.env
*.pem
*service-account*.json
reports/
.tmp/
```

reportsはGit管理したい場合に後から変更可能だがv1はignoreでもよい。SEO履歴JSONは必ずGit管理。

---

## 25. Git handling

v1 core自身がGit commit APIを持つ必要はない。

Skillを実行するCodex/Claudeが、成功後に通常のGit操作でcommitする。

推奨commit単位:

```text
seo: improve <keyword>
```

含めるもの:

- site/content change
- improvement-log
- rank-history（同runで計測した場合）

secretは絶対に含めない。

---

## 26. 実装順序

Codexは以下の順で止まらず進める。

### Phase 1 bootstrap

- package.json
- tsconfig
- directory tree
- types/schemas
- sample config/data

### Phase 2 deterministic core

- json store
- atomic write
- status
- selection
- review
- dates
- report
- tests

### Phase 3 adapters

- GSC real adapter
- fixture search
- stub writer
- fixture/filesystem site
- tests

### Phase 4 orchestration

- run transaction
- dry-run
- lock
- CLI
- tests

### Phase 5 skill/docs

- SKILL.md
- README
- full fixture E2E

### Phase 6 acceptance

Run:

```bash
npm install
npm test
npm run build
npm run seo -- run --fixture --date 2026-09-10
npm run seo -- status --fixture --date 2026-09-10
```

全PASSを確認。

---

## 27. Acceptance Criteria

以下が全て満たされたらv1 COMPLETE。

- [ ] clean install成功
- [ ] typecheck/build成功
- [ ] 全tests PASS
- [ ] fixture E2E PASS
- [ ] 1 run 1 keyword保証
- [ ] observing cooldown保証
- [ ] append-only history保証
- [ ] GSC not configuredを区別
- [ ] search resultを外部fileから注入可能
- [ ] planを外部fileから注入可能
- [ ] B stub adapter稼働
- [ ] site fixture/filesystem adapter稼働
- [ ] validation失敗時にstate進行なし
- [ ] dry-run無変更
- [ ] report生成
- [ ] secret guard
- [ ] README complete
- [ ] SKILL.md complete

---

## 28. 実サイト接続前に残してよい唯一のTODO

外部依存の値のみ。

- 実ドメイン
- GSC property
- service account credential
- 実サイトのsource path/build/test command
- Bの実CLI/API

これらが未提供でも、**core v1の実装完了をBLOCKしない**。

fixture/stubで完走させる。

---

## 29. 将来候補（v1に入れない）

- CTR/title専用experiment
- device/country別GSC
- keyword cannibalization検知
- automated internal-link graph
- multi-page experiments
- statistical significance engine
- PostgreSQL
- dashboard
- distributed workers
- agent-orchestrator integration
- automatic scheduler daemon
- B品質スコアとの連動

必要性が実測で出てから導入する。

---

## 30. Codex最終報告フォーマット

実装完了時に以下を報告。

```text
STATUS: COMPLETE | BLOCKED
HEAD: <sha>

Implemented:
- ...

Tests:
- npm test: PASS/FAIL
- npm run build: PASS/FAIL
- fixture E2E: PASS/FAIL

External setup remaining:
- GSC credential: ...
- real site adapter: ...
- B adapter: ...

Known limitations:
- ...
```

外部設定以外の「あとで実装」は残さず完結させること。
