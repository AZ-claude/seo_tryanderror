# seo_tryanderror

テーマまたは既存サイトを与えると、検索市場・サイト・保有データを理解し、Opportunity
を発見し、仮説を立て、コンテンツの新規作成/改善を提案し、公開後の実測結果から学習
しながらサイトそのものを育てていく自律サイト育成エンジン「C」。

```text
A → B   = ユーザー自身の作業ログを自然な記事にする(別リポジトリ)
C → B   = SEO上必要な記事/改善を自然な記事にする(このリポジトリ)
```

- **A: 作業ログの素材化** — 別リポジトリ(`/kiji`)。このリポジトリは依存しない。
- **B: 自然な日本語生成** — 別プロジェクト(`seo_japanese`)。事実を変えず自然な
  日本語へ変換する。未接続の間は `StubNaturalWriterAdapter` で代替する。
  当初のMilestone 1ではBは一切呼ばれなかったが、`apply`(最初の実サイト適用)を
  最小実装したことで、そこから先(サイト側の編集・B連携・deploy)は現在は
  人間/Skillが対象サイトのリポジトリで直接行い、その結果を`apply`が検証・記録
  する運用になっている(下記「rolling PDCA」参照)。
- **C: サイト育成の意思決定(このリポジトリ)**

設計の詳細は [DESIGN.md](./DESIGN.md)、背景は [HANDOFF.md](./HANDOFF.md) を参照。

## ワークフロー

```text
understand -> discover -> prioritize -> propose -> (B, サイト変更, deploy) -> apply -> observe -> review -> learn -> repeat
```

- **understand**: サイトを読み取り専用で読み(HTTP/sitemap優先、GSC設定があれば
  クエリ×ページ行列も取得)、`site-understanding.json` を生成する。
- **discover**: `site-understanding.json` とSkill(coding agent)が構造化した
  Opportunity候補を突き合わせ、`identity`(scopeKey+intentKey)単位で重複排除
  しながら `opportunities.json` に保存する。`--dump-inputs` は直近concludedの
  Experiment(何を試して何が起きたか、最大50件)も併せて出す。
- **prioritize**: `status === 'open'` のOpportunityを固定バケット順位で並べる
  (DESIGN.md §10.4)。状態は変更しない。
- **propose**: 指定した1件のOpportunityに対しHypothesis/Action/MeasurementPlan
  を受け取り、`Experiment(status: proposed)` を作成してMarkdown reportを出す。
  同じページに既にactiveなExperimentがあれば(別のOpportunity由来でも)拒否する。
- **apply**: 対象サイトのリポジトリで実際に行った変更(B review・test/build・
  commit・deploy・live verification)を構造化evidenceとして受け取り、検証した
  上で `Experiment` を `proposed -> approved -> applied -> observing` へ進める。
  `REVISE` のみ対応、サイト編集やBの呼び出し自体はこのコマンドは行わない。
- **review**: 固定tier(3/7/14/28日)でのrolling checkpoint review。
  `observation.start` からの厳密な日付範囲でGSCを直接取得し、変更前後を
  同じ日数で比較する(trailing 28日snapshotの使い回しはしない)。十分な
  根拠があればSkillが`conclude`を選び、`after`/`result`/`learning`を保存して
  `Experiment` を `concluded` にし、他にactiveなExperimentが無ければ
  Opportunityを `open` へ戻す。

**複数のExperimentを並行して観測できる**(`config.experiment.maxActiveExperiments`
、既定3)。ただし同一ページに2つ以上のactiveなExperimentは作れない
(`ACTIVE_PAGE_EXPERIMENT_EXISTS`)。1回のdaily cycleで新規applyは最大1件、
review/concludeは複数件処理してよい(`.claude/skills/seo-growth-loop/SKILL.md`)。

## Quick start(credential不要、fixtureのみで一周)

```bash
npm install
npm test
npm run build

npm run seo -- understand --fixture --date 2026-09-10
npm run seo -- discover --fixture --opportunities-file fixtures/discover/opportunities.json
npm run seo -- prioritize --fixture
```

`prioritize` の出力からOpportunityの `id` を控え、`propose` に渡す。

```bash
npm run seo -- propose --fixture --date 2026-09-10 \
  --opportunity-id <id> \
  --hypothesis-file fixtures/propose/hypothesis.json \
  --serp-file fixtures/serp/example-keyword.json

npm run seo -- status --fixture --date 2026-09-10
```

`--fixture` は `fixtures/` 配下のサンプルデータを `.tmp/fixture-run/` にコピーして
実行する。**git管理下の `fixtures/` 自体は書き換わらない**ので、何度でも安全に
試せる。まっさらな状態からやり直したい場合は次で削除する。

```bash
rm -rf .tmp
```

同じOpportunityへ再度 `propose` すると、Active Experiment Guardにより
拒否される(exit code 1)。これは意図した動作(DESIGN.md §12)。

## CLI

```bash
npm run seo -- understand --config <path> [--fixture] [--date YYYY-MM-DD] [--dry-run] [--understanding-file <path>]
npm run seo -- discover --config <path> [--fixture] [--dump-inputs] [--opportunities-file <path>] [--dry-run]
npm run seo -- prioritize --config <path> [--fixture]
npm run seo -- propose --config <path> [--fixture] --opportunity-id <id> --hypothesis-file <path> [--serp-file <path>] [--dry-run]
npm run seo -- apply --config <path> --experiment-id <id> --evidence-file <path> [--dry-run]
npm run seo -- review --config <path> --experiment-id <id> [--dump-inputs | --review-file <path>] [--dry-run]
npm run seo -- status --config <path> [--fixture]
```

`discover --dump-inputs` は、`site-understanding.json` の中身と既存
Opportunityのidentity一覧をJSONで出力するだけで、何も書き込まない。Skillが
Opportunity候補を作る前の材料集めに使う。

`--dry-run` は読み取り(fetch/crawl)はしてよいが、永続ファイル
(`site-understanding.json` / `opportunities.json` / `experiments.json` /
`rank-history.json`)への書き込みを一切行わない。

## Daily operation(実サイト運用、Milestone 1Bとして別途許可が必要)

**複数サイトを同じリポジトリから完全に独立したstateで運用できる**
(state/lock/Experiment上限/reports/learningはすべて `config.site.key` 単位で
分離される。詳細はDESIGN.mdおよび下記「Multi-site」参照)。

1. サイトごとに `config/seo.config.example.json` をコピーした専用config
   ファイル(例: `config/seo.rakusetsu.config.json` / `config/seo.pokeca.config.json`)
   を用意し、`site.key`(state namespace)・`site.baseUrl` / `site.mode` /
   `site.reader` / `gsc.property`(必要なら `gsc.pagePrefix`/
   `gsc.excludePagePrefix`)を実サイトの値に書き換える。固定パス
   `config/seo.config.json` を実運用で使うことは想定していない
   (`--config` を省略した場合の挙動は後方互換のためのレガシー動作であり、
   複数サイト運用の入口ではない)。
2. `understand -> discover -> prioritize -> propose` までは
   `.claude/skills/seo-rank-watch/SKILL.md`、毎日のrolling PDCA
   (review/conclude/learn、新規apply)は `.claude/skills/seo-growth-loop/SKILL.md`
   に従ってcoding agentが操作する。どちらも実行のたびに対象siteの
   configPathを明示的に解決してから動く(単一site専用)。scheduler化
   (無人自動実行)はまだ行っていない。
3. **`rakusetsu.com`/`pokeca.rakusetsu.com` を含む実サイト・実GSCへの
   アクセスは、DESIGN.md §19.2(Milestone 1B)としてユーザーが明示的に
   許可した後にのみ行う。**

### Multi-site

```text
「rakusetsu-mainのPDCA回して」  -> config/seo.rakusetsu.config.json だけで
                                    seo-growth-loop を1cycle
「pokecaのPDCA回して」          -> config/seo.pokeca.config.json だけで
                                    seo-growth-loop を1cycle
「両サイトのPDCA回して」        -> .claude/skills/seo-multi-site-loop/SKILL.md
                                    が上の2つを直列に1cycleずつ実行し、
                                    最後にサイト別の統合reportを出す
```

サイトを跨いだOpportunity/Experiment/rank-history/site-understanding/lock/
reportの混在は無い(`data/seo/<site.key>/`・`reports/<site.key>/` で
物理的に分離される)。pokecaのようにsite側リポジトリの`AGENTS.md`が
Heavy tier(public site deploy等)を要求している場合、branch/PR/独立review
PASSを経てからでないとmerge/deployしない(`seo-growth-loop`の該当節参照)
——このtier判定はC本体にハードコードせず、対象repoの`AGENTS.md`を都度読んで
判断する。

## GSC setup

1. Google Cloud プロジェクトを作成
2. Search Console API を有効化
3. サービスアカウントを作成
4. JSONキーを取得
5. Search Console の対象プロパティにサービスアカウントのメールアドレスを
   (制限付きユーザーとして)追加
6. キーファイルをリポジトリ外、または `.gitignore` 済みの場所に保存
7. 環境変数を設定(`seo.config.json` の `gsc.credentialsEnv` で指定した名前、
   例: `GSC_SERVICE_ACCOUNT_JSON=/path/to/key.json`)

認証情報が未設定のまま `understand` を実行しても失敗しない。
`GSC_NOT_CONFIGURED` をreportに明記し、ページ読み取りなど他の処理は続行する。

## 実サイトへの接続(read-only)

`config/seo.config.json` の `site.reader` を `"http"` にすると
`HttpSiteReaderAdapter`(`src/adapters/site-reader.ts`)が有効になる。
`sitemap.xml` を優先し、無ければbaseUrlから同一ドメイン内リンクを浅く辿る
(件数・深さ上限あり)。`robots.txt` のDisallowを尊重する。**書き込みメソッドを
一切持たない**ので、このアダプタ経由でサイトが変更されることはない。

`site.reader` を `"filesystem"` にすると `FilesystemSiteReaderAdapter` が
有効になり、`site.contentRoot` 配下のMarkdown/HTMLを読み取り専用で走査する。

サイトへの書き込み(汎用の `SiteWriterAdapter`)、B接続を含む自動実行器は
`REVISE` 以外まだ実装していない(`NotImplementedActionExecutor`、DESIGN.md
§9.6)。`REVISE` についても、対象サイトのリポジトリを直接編集するのは
Skill/人間の役割のままで、このリポジトリのコード自体はサイトへ書き込まない
(`apply` は結果のevidenceを検証・記録するだけ)。

## 状態ファイルの意味

| ファイル | 役割 |
| --- | --- |
| `data/seo/site-understanding.json` | 直近の `understand` 実行結果(都度上書き) |
| `data/seo/opportunities.json` | Opportunity一覧。`history[]` は追記専用 |
| `data/seo/experiments.json` | Experiment(Opportunity×Hypothesis×Action×MeasurementPlanの試行記録)。`history[]` は追記専用 |
| `data/seo/rank-history.json` | GSC等の計測生ログ。**追記専用**、過去entryは変更・削除しない |
| `data/seo/.run.lock` | 二重実行防止のロック(`.gitignore`済み) |
| `reports/` | 各コマンド実行のMarkdownレポート(`.gitignore`済み) |

## Guardrails

- 1 discover/proposeで作るOpportunity/Experimentの検討候補は絞る(`propose`は
  常に指定した1件のOpportunityのみを対象とする)
- **Active Experiment Guard**: 同一Opportunityに `proposed`/`approved`/
  `applied`/`observing` のExperimentが存在する間、新規Experiment作成は
  (`--opportunity-id` 直接指定でも)拒否される
- Opportunityのdedupeは `identity`(scopeKey+intentKey)単位。同一ページの
  異なるintentは共存できる
- `rejected` なOpportunityは明示的な `reopen: true` + 理由なしに自動再浮上しない
- `rank-history.json` / `opportunities.json` / `experiments.json` の
  `history[]` は追記専用
- ページ本文・GSCの生クエリ×ページ行列を無制限に永続化しない(excerpt上限・
  top-N上限あり)
- secretをログ・commitに含めない
- 独自Google SERPスクレイパーは作らない
- noindex / canonical / URL の自動変更、大規模構造変更、複数記事一括rewriteは
  自動実行しない(提案としてAction typeを出すことはあっても実行器を持たない)
- 改善効果を予測で断定しない(観測結果のみ報告する)
- 候補がなければ何もしない(捏造しない)
- 同一ページに2つ以上のactiveなExperimentは作れない(`ACTIVE_PAGE_EXPERIMENT_EXISTS`)
- `maxActiveExperiments`(既定3)を超える新規Experimentは作れない
- checkpoint reviewで `insufficient_data` を `no_effect` にすり替えない
- 短期的な順位・impressions低下だけを理由にした自動rollbackは持たない
- このリポジトリのコード自体がサイトへ書き込む・PRを作る・publishする
  コードパスはまだ存在しない(`apply` はevidenceの検証・記録のみ)

## Troubleshooting

- **`RUN_ALREADY_ACTIVE`**: 別プロセスが実行中、または前回異常終了した
  ロックが残っている。10分以上古いロックは自動的に無効化されるので、
  それ未満であれば少し待つ。手動で消す場合は `data/seo/.run.lock` を削除する。
- **`GSC_NOT_CONFIGURED`**: 上記「GSC setup」を参照。`understand` は失敗せず
  続行する。
- **`propose` が exit 1 (`ACTIVE_EXPERIMENT_EXISTS` / `OPPORTUNITY_NOT_OPEN`)**:
  そのOpportunityには既にアクティブなExperimentがある、または
  `open` 状態ではない。`status` で確認する。
- **dry-runで何も変わらない**: 仕様通り。`--dry-run` を外して実行する。
- **fixtureを試したらリポジトリが汚れた**: 起きない設計だが、もし
  `fixtures/` 配下がgit差分に出たら `git checkout -- fixtures/` で戻し、
  `.tmp/fixture-run/` を使っているか確認する。

## Known limitations(Milestone 1A)

- `before`/`after` は、`rank-history.json` の中から要求した `source` と一致し、
  かつMeasurementPlanの対象windowと重なる(entryの `window`、無ければ `date` で
  判定)entryのうち**最新の1件だけ**を選び、そのentry内のrowsだけを集計する。
  GSC entryは既にwindow全体の集計スナップショットであり、複数entryを合算する
  と重複期間分を二重計上してしまうため、複数entryの合算は行わない。完全な
  日次時系列分析(重複を考慮した按分等)は必要になってから実装する。
- Bootstrap Mode(`discover --theme`/`--assets-file` 相当)の自動化フックは
  未実装。`site-understanding.json` にページ/GSCデータが無い場合、discoverの
  reportにその旨を記載するのみ。
- `--max-proposals` のような複数提案の上限フラグは無い(`propose` が常に
  1回1件のExperimentしか作らないため、実質的にガードレールの意図は満たされる)。
- `RealGscAdapter` の `searchAnalytics/query` 呼び出しは `rowLimit: 5000` 固定。
  pagination/25,000件対応は未実装のため、大規模サイトではquery×pageの全量を
  1回のfetchで取得できない可能性がある(将来必要になってから対応する)。
