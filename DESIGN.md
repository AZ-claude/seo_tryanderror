# DESIGN — seo_tryanderror v2 (Opportunity-driven site growth engine)

最終更新: 2026-09-18
対象: Codex/Claude等のcoding agent実装用の正本

---

## 0. 実装指示（実装開始が許可された時点で有効）

このドキュメントは設計確定版であり、**今回のセッションでは実装しない**。
実装を開始してよいタイミングになったら、実装agentは `IMPLEMENTATION_GOAL.md` を渡され、
以下の優先順位で不明点を解決しながら、追加の設計確認を待たずに実装・テスト・コミットまで進める。

1. この `DESIGN.md`
2. `HANDOFF.md`
3. YAGNI
4. fixture/stubで前進

ユーザー確認待ちにしてよいのは、secret/外部アカウント設定/本番不可逆変更/`rakusetsu.com`や他repoへの書き込みのみ。

最初の実装マイルストーン（Milestone 1）のスコープは [§19 Acceptance Criteria](#19-acceptance-criteriav1-milestone-1) と
[§21 実装順序](#21-実装順序milestone-1codexが実装時に迷わないための骨子)、および `IMPLEMENTATION_GOAL.md` を参照。

---

## 1. North Star

`seo_tryanderror`（C）は、

> テーマまたは既存サイトを与えると、検索市場・サイト・保有データを理解し、
> Opportunityを発見し、仮説を立て、コンテンツの新規作成または改善を行い、
> 公開後の実測結果から学習しながらサイトそのものを育てていく自律サイト育成エンジン

である。

「最初に完璧なSEOサイトを設計すること」がゴールではない。**小さく仮説を立てて公開し、実測結果から次の行動を変えていく試行錯誤そのもの**が本質。

「Google検索1位」は最終ゴールではない。順位は数あるdiagnostic signalの一つ。将来的な成果指標は impressions / clicks / CTR / organic sessions / qualified sessions / conversion / revenue・lead / AI検索での可視性・引用 まで広がる。V1はGSC中心でよいが、これらを後から追加できる形にしておく。

---

## 2. Scope（このドキュメントが定義するもの）

- Cの中心主語を `keyword` から `Opportunity` / `Hypothesis` へ変更するドメインモデル全体
- SEO改善単位を `1 keyword` から `page × search intent cluster × hypothesis` へ変更する設計
- Existing Site Mode（`rakusetsu.com` を対象にした最初の実運用）の詳細フロー
- Bootstrap Mode（新規サイトをtheme起点で育てる）の設計（実装はV1に含めなくてよい）
- READ → UNDERSTAND → DISCOVER → PRIORITIZE → PROPOSE のV1ワークフローと、将来の PROPOSE → PR → test → review → publish への拡張点
- 既存実装（json store, atomic write, lock, GSC/search/writer/site adapterの契約, dry-run, append-only history, insufficient_data判定, fixture E2E）のうち、そのまま/ほぼそのまま再利用するもの、書き換えるもの、廃止するもの

## 3. Non-goals（v2でも作らない）

- SaaS UI / multi-tenant / billing / 専用Web管理画面
- ベクトルDB
- LLM fine-tuning / 強化学習
- 大規模multi-agent orchestration
- 独自Google SERP scraper
- 100記事一括生成
- 自動被リンク
- 本番への無制限自動push（`rakusetsu.com` への直接書き込みは当面一切行わない）
- 統計的有意性エンジン、キーワードカニバリ検知エンジン等の高度分析（必要になってから）

---

## 4. Modes

Cは同一のドメインモデル・同一のワークフロー（READ→UNDERSTAND→DISCOVER→...）を、入力の充実度に応じて2つのモードで走らせる。モードはコード上の分岐ではなく、**site-understanding.json にどれだけデータが入っているか**で自然に決まる。

### 4.1 Existing Site Mode（最初の実運用対象）

入力: 既存サイトのURL/リポジトリ（`rakusetsu.com`）。

Cが自分で読む:

- 現在どんなページがあるか（サイト構造）
- どんなテーマ・トピックを扱っているか
- どんな独自データ・一次情報を持っているか
- GSC上でどんなquery/pageが反応しているか
- SERP上で何が不足しているか（現在ページ vs 上位ページ）

ユーザーがキーワードを指定する運用にはしない。Cが自力で「次に何を試すべきか」を決める。

**これがV1 Milestone 1のスコープ。**

### 4.2 Bootstrap Mode（設計のみ、実装は後続milestone）

入力: `theme` + `available assets`（保有する一次情報・独自データ等）のみ。ページ0、GSCデータ0、サイト構造0。

```text
theme
  -> market / SERP research
  -> initial opportunities
  -> minimal site構成決定
  -> 初期ページ作成
  -> 公開
  -> index
  -> GSCデータ取得開始
  -> 通常の学習ループ（Existing Site Modeと合流）
```

DISCOVERコマンドは、`site-understanding.json` にページ・GSCデータが無ければ自動的にこの経路（theme起点の市場調査）にフォールバックする設計にしておく。CREATE系Actionと初期サイト構成の実行はV1で自動化しない（[§9.6](#96-action) 参照）。

### 4.3 Maturity state（採用するが最小限）

サイト単位で以下の状態を持たせてよい。過剰設計と判断すれば省略してよいが、Bootstrap Modeの設計拡張性のために型だけ用意する。

```ts
type SiteMaturity = 'bootstrap' | 'exploring' | 'growing' | 'optimizing';
```

判定はheuristic（ページ数・GSCデータの有無・observing/concluded experimentの件数）で十分。専用スコアリングエンジンは作らない。V1ではreport表示にのみ使い、ワークフロー分岐には使わない。

---

## 5. 技術方針（現行から変更なし）

- Node.js 20+ / ESM / TypeScript
- npm
- test: `node:test`（現行のまま）
- runtime validation: Zod
- persistence: JSON files, no DB
- no web UI, no GitHub Actions要件
- no custom SERP scraper

---

## 6. Domain Model

現行の `KeywordRecord` / `ImprovementKeywordState` / `ImprovementAction` 中心のモデルを廃止し、以下に置き換える。

### 6.1 Opportunity

「この市場・このサイトにはこういう需要／ギャップがある」という発見。主語はキーワードではなく需要（intent cluster）。

```ts
type OpportunityScope =
  | { type: 'page'; path: string }
  | { type: 'cluster'; representativeQueries: string[] } // ページが存在しない/複数ページにまたがる需要
  | { type: 'site' }; // Bootstrap Modeの「サイト全体構成」レベルの発見

type Opportunity = {
  id: string; // ULID
  createdAt: string;
  updatedAt: string;
  scope: OpportunityScope;
  title: string; // 「未開封BOXの将来供給量を知りたい需要がある」のような一文
  description: string;
  evidence: Evidence[];
  status: 'open' | 'promoted' | 'rejected' | 'stale';
  // promoted: 少なくとも1つのHypothesis/Experimentに発展した
  // rejected: 検討したが見送り（理由をdescriptionかhistoryに残す）
  // stale: 一定期間再評価されず、再UNDERSTANDが必要
  history: OpportunityEvent[]; // append-only
};

type OpportunityEvent = {
  at: string;
  type: 'discovered' | 'promoted' | 'rejected' | 'reopened' | 'note';
  note?: string;
};
```

### 6.2 Evidence

Opportunity/Hypothesisの根拠。ソースは将来拡張前提で型を開いておく。

```ts
type EvidenceSource =
  | 'gsc_query'
  | 'gsc_page'
  | 'serp'
  | 'existing_page'
  | 'proprietary_data' // サイトが持つ独自データ・一次情報
  | 'ga4' // 将来
  | 'manual';

type Evidence = {
  source: EvidenceSource;
  summary: string; // 人間可読の要約
  ref?: string; // 元データへのポインタ（GSC query文字列、URL、ファイルパス等）
  collectedAt: string;
};
```

### 6.3 Hypothesis

Opportunityに対する「こう変えれば良くなるはず」という仮説。

```ts
type Hypothesis = {
  id: string;
  opportunityId: string;
  createdAt: string;
  statement: string; // 「価格表だけでなく残存供給量の推定を出せば価値が増える」
  expectedSignals: MetricKey[]; // どの指標が動くと支持されるか
  rationale: string;
};

type MetricKey =
  | 'impressions'
  | 'clicks'
  | 'ctr'
  | 'position'
  | 'organic_sessions'
  | 'qualified_sessions'
  | 'conversions'
  | 'revenue';
```

### 6.4 Action

Hypothesisを実行に移す変更の種類。V1で**自動実行するのはREVISEのみ**（それもMilestone 2以降、[§9.6](#96-action)参照）。他は型として定義するが実行器（executor）は用意しない/スタブでNotImplementedとする。

```ts
type ActionType = 'CREATE' | 'REVISE' | 'LINK' | 'MERGE' | 'SPLIT' | 'RETIRE';

type Action = {
  type: ActionType;
  targetPaths: string[]; // REVISE/LINK/MERGE/SPLIT/RETIREは既存パス、CREATEは提案パス
  summary: string; // 何をするか（実施前は「提案」、実施後は「実施内容」）
  requiredFacts: string[];
  forbiddenChanges: string[];
};
```

### 6.5 Experiment（旧 ImprovementKeywordState + ImprovementAction を統合・一般化）

「このOpportunityとHypothesisに基づき、このActionを行い、結果はこうだった」という一連の試行。**これがExperiment Memoryの単位**。

```ts
type ExperimentStatus =
  | 'proposed' // PROPOSE段階。まだ何も適用していない
  | 'approved' // 人間/上位ワークフローがPRを承認（将来）
  | 'applied' // サイトへ適用済み（将来のapply mode）
  | 'observing' // 適用後、観察期間中
  | 'concluded' // 観察終了、result/learning確定
  | 'rejected'; // 提案されたが実施しないと判断

type MetricsSnapshot = {
  at: string;
  source: 'gsc' | 'ga4' | 'websearch' | 'manual' | 'fixture';
  window?: { start: string; end: string; days: number };
  metrics: Partial<Record<MetricKey, number>>;
};

type Experiment = {
  id: string;
  opportunityId: string;
  hypothesisId: string;
  action: Action;
  status: ExperimentStatus;
  before: MetricsSnapshot | null; // insufficient_dataならnull
  after?: MetricsSnapshot;
  observation?: { start: string; end: string; cooldownDays: number; nextReviewDate: string };
  result?: {
    outcome: ReviewOutcome;
    notes: string;
  };
  learning?: string; // Learning本体（このサイトでは何が効いたか）
  createdAt: string;
  updatedAt: string;
  history: ExperimentEvent[]; // append-only。状態遷移を全て記録
};

type ReviewOutcome =
  | 'hypothesis_supported'
  | 'partially_supported'
  | 'no_effect'
  | 'worse'
  | 'insufficient_data';

type ExperimentEvent = {
  at: string;
  type: ExperimentStatus | 'applied_rolled_back';
  note?: string;
};
```

旧 `ImprovementAction.review.outcome`（achieved / improved_not_achieved / no_effect / worse / insufficient_data）を `ReviewOutcome` に写像し直した。「1位達成」という単一ゴールを前提にしないため `achieved` は `hypothesis_supported` に、"改善したが未達"は `partially_supported` に一般化する。

### 6.6 Learning（集約ビュー）

個々のExperimentの `learning` フィールドがExperiment Memoryの本体。加えて、サイト単位で横断的な学習を読みやすくするための集約ビューを `learnings.json` として持たせてよい（v1では手動/簡易生成でよい。専用要約エンジンは作らない）。

```ts
type LearningEntry = {
  id: string;
  derivedFromExperimentIds: string[];
  statement: string; // 「〇〇系のchangeTypeはこのサイトでは効きにくい」等
  confidence: 'low' | 'medium' | 'high';
  createdAt: string;
};
```

### 6.7 Site Understanding（新規）

READ/UNDERSTANDフェーズの成果物。Opportunity発見の入力になる、Cが持つ「このサイトの理解」のスナップショット。**都度作り直せるキャッシュ**であり、append-onlyではない（前回分は上書き。監査したい場合はreportsに残る）。

```ts
type PageSummary = {
  path: string; // サイト内相対パス、またはfull URL（HTTP読み取り時）
  title?: string;
  headings?: string[];
  wordCount?: number;
  lastFetchedAt: string;
};

type SiteUnderstanding = {
  schemaVersion: 1;
  site: { baseUrl: string };
  generatedAt: string;
  pages: PageSummary[];
  themes: string[]; // Cが読んで抽出したトピック一覧（自由記述、構造化しすぎない）
  proprietaryDataNotes: string[]; // 独自データ・一次情報として見つけたものの記述
  gscSummary?: {
    window: { start: string; end: string; days: number };
    topQueries: Array<{ query: string; page: string | null; clicks: number; impressions: number; ctr: number; position: number }>;
  };
  maturity: SiteMaturity;
};
```

---

## 7. Persistence（データストア）

`data/seo/` 配下。旧 `watchwords.json` は廃止（事前キーワード登録という前提自体をやめるため）。

```text
data/seo/
  site-understanding.json   # 6.7。UNDERSTANDのたびに再生成（上書き）
  opportunities.json        # Opportunity[]（statusで生存管理、historyはappend-only）
  experiments.json          # Experiment[]（＝Experiment Memory本体）
  learnings.json            # LearningEntry[]（任意、v1では手動生成でも可）
  rank-history.json         # 現行のまま再利用。GSC/websearch/manual計測の生ログ、append-only
  .run.lock                 # 現行のまま再利用
```

### 7.1 再利用するインフラ

以下は**ほぼ無変更で再利用する**。設計変更はドメイン型が変わったことによるスキーマ差し替えのみ。

- `src/infra/json-store.ts` の `readJsonFile` / `writeJsonFileAtomic`（一時ファイル+rename）
- `src/infra/fs-lock.ts`（`.run.lock`、stale lock検知）
- `src/core/date.ts`（`computeMeasurementWindow` 等の日付計算）
- `appendRankHistory` のappend-only強制パターン（同じ仕組みを `opportunities.json`/`experiments.json` の `history` 配列にも適用する: 個々のレコードの `history[]` に対してはappendのみを許す専用APIを用意し、レコード本体の可変フィールド（status等）は別APIで更新する、という設計をそのまま踏襲）

### 7.2 opportunities.json のwrite rule

- `id` はcreate時発行、以後不変
- `status` は更新可能
- `history[]` はappend-onlyの専用API (`appendOpportunityEvent`) 経由のみ
- 同一 `scope` に対して `status: 'open'` のOpportunityが重複しないようにする（discover時にdedupe）

### 7.3 experiments.json のwrite rule

- `id` は不変
- `status` 遷移は許可された遷移のみ（`proposed -> approved -> applied -> observing -> concluded`、または各段階から `rejected`）。不正な遷移はエラー
- `history[]` はappend-onlyの専用API経由のみ
- `before` は一度設定したら不変。`after`/`result`/`learning` は観察終了時にのみ設定

### 7.4 rank-history.json

現行の仕様を完全に維持する: schemaVersion必須、entriesはappend-only、同じ `date + source` の重複拒否。ただし記録するmeasurementの粒度を「登録watchword」単位から「query × page」単位に一般化する（[§9.2](#92-gsc-adapter) 参照）。

---

## 8. Config

```json
{
  "schemaVersion": 2,
  "site": {
    "baseUrl": "https://rakusetsu.com",
    "mode": "existing", // "existing" | "bootstrap"
    "reader": "http", // "http" | "filesystem"
    "repoRoot": null, // filesystem readerのときのみ使用
    "contentRoot": null
  },
  "gsc": {
    "property": "sc-domain:rakusetsu.com",
    "credentialsEnv": "GSC_SERVICE_ACCOUNT_JSON",
    "defaultWindowDays": 28,
    "reviewWindowDays": 7,
    "finalDataLagDays": 3
  },
  "experiment": {
    "cooldownDays": 7
  },
  "commands": {
    "build": null,
    "test": null
  },
  "adapters": {
    "writer": "stub",
    "site": "http-readonly",
    "search": "fixture"
  }
}
```

`experiment.oneKeywordPerRun` は廃止（キーワード中心モデルの廃止に伴う）。代わりに「1 discoverあたり生成するproposalの上限」を運用ガードとして持たせてよいが、これはCLIオプション（`--max-proposals`）で十分であり、config必須項目にはしない。

`commands.build`/`commands.test` はMilestone 1では未使用（read-onlyのため）。`site.reader: "http"` かつ `mode: "existing"` かつ `repoRoot: null` が `rakusetsu.com` の初期構成になる。

---

## 9. Adapters

### 9.1 Site Reader Adapter（新規、read-only）

`rakusetsu.com` はこのリポジトリからは別リポジトリ・別ホストである。**ソースリポジトリへのアクセス権を前提にしない**設計とする。したがって最初の実装は「公開されている本番サイトをHTTP越しに読む」アダプタを主とする。将来ローカルにcontentリポジトリを持つ場合のために filesystem 版も残す（旧 `FixtureSiteAdapter`/`FilesystemSiteAdapter` の読み取り側を流用）。

```ts
interface SiteReaderAdapter {
  listPages(): Promise<Array<{ path: string; source: 'sitemap' | 'crawl' }>>;
  readPage(path: string): Promise<{ path: string; html: string; text: string; title?: string; headings: string[] }>;
}
```

- `HttpSiteReaderAdapter`: `sitemap.xml` を取得してURL一覧を作り（無ければ設定されたトップページから同一ドメイン内リンクを浅くたどる。深さ・件数上限を設ける）、各ページを `fetch` してHTML→テキスト抽出する。**書き込み系メソッドを持たない**ことでmode誤用を型レベルで防ぐ。robots.txtを尊重し、過度な並列/高頻度アクセスをしない（レート制限を設ける）。
- `FilesystemSiteReaderAdapter`: 旧 `resolveContentFile` 相当の変換 + `readFile` のみ（`apply` は持たない）。

書き込み系（`SiteWriterAdapter`: 旧 `apply`/`validate`）はMilestone 2以降で導入する別interfaceとし、旧 `FixtureSiteAdapter`/`FilesystemSiteAdapter` の `apply`/`validate` 実装をほぼそのまま移設して再利用する。

### 9.2 GSC Adapter

現行の認証まわり（Service Account JWT、`webmasters.readonly` scope、`searchAnalytics/query` POST、credential未設定時の `GSC_NOT_CONFIGURED`）は**そのまま再利用する**。変更するのは取得後の整形ロジックのみ。

```ts
interface GscAdapter {
  fetchQueryPageMatrix(input: {
    property: string;
    startDate: string;
    endDate: string;
  }): Promise<{
    rows: Array<{ query: string; page: string | null; clicks: number; impressions: number; ctr: number; position: number }>;
  }>;
}
```

- `dimensions: ['query', 'page']` に変更（現行は `['query']` のみ）。
- 旧 `buildMeasurements`（watchwordとのNFKC正規化マッチング）は廃止。事前登録キーワードに縛られず、**全クエリ×ページ行列をそのまま `site-understanding.json.gscSummary` に格納**し、DISCOVERフェーズでOpportunity候補の材料にする。
- impressions閾値によるフィルタ（旧: unregistered query, impressions>=10, top20）は、DISCOVER側の「候補として提示する上限」として引き継ぐ（[§10.3](#103-discover)）。
- `insufficient_data` の扱い（データ不足を効果なしと誤判定しない）は概念として維持し、Experimentのreview判定に適用する。

### 9.3 Search Adapter（SERP）

現行のcontract・実装方針を完全に維持する。

```ts
interface SearchAdapter {
  inspectSerp(input: { query: string; topN: number }): Promise<SerpInspection>;
}
```

- `FixtureSearchAdapter` / `FileSearchAdapter`（`--serp-file`）をそのまま再利用。
- 独自SERPスクレイパーは作らない。実運用ではSkillを実行するcoding agent自身がWebSearchを行い、構造化JSONをCLIへ渡す。

### 9.4 GA4 Adapter（将来、V1では未実装）

インターフェースだけ予約する。

```ts
interface Ga4Adapter {
  fetchConversionWindow(input: { propertyId: string; startDate: string; endDate: string }): Promise<{
    rows: Array<{ page: string; sessions: number; conversions: number }>;
  }>;
}
```

V1では呼び出し箇所を作らない。`MetricsSnapshot.metrics` に `organic_sessions`/`conversions` キーが既にあるのは、このアダプタを後から挿すため。

### 9.5 Natural Writer Adapter（B）

**契約は現行のまま完全維持する。** CはBに「何を変更するか・なぜ・必須事実・禁止変更」を渡し、Bは自然な日本語への変換のみを行う。C自身は日本語自然化ロジックを持たない。

```ts
interface NaturalWriterAdapter {
  transform(input: {
    mode: 'create' | 'revise';
    targetLanguage: 'ja';
    contentType: 'article';
    existingText?: string;
    searchNeed: string; // = Hypothesisのrationale相当
    requiredFacts: string[];
    requiredChanges: string[];
    forbiddenChanges: string[];
    targetKeyword: string; // Opportunityの代表クエリ、後方互換のためフィールド名は維持
  }): Promise<{ text: string; preservedFacts: string[]; warnings: string[] }>;
}
```

`StubNaturalWriterAdapter` / `CliNaturalWriterAdapter` をそのまま再利用する。Bが未実装でもstubでC単体をテストできる状態を維持する。**この adapterはMilestone 2（apply mode）で初めて呼ばれる。Milestone 1（read-only propose）では呼ばれない**が、契約はMilestone 1の時点でDESIGN上確定させておく（PROPOSE出力にすでに `requiredFacts`/`forbiddenChanges` 等Bへ渡せる形の下書きを含めるため）。

### 9.6 Action executor（実行器）

`Action.type` ごとの実行器。V1で実装するのは**将来のMilestone 2でのREVISEのみ**。他はスタブ。

```ts
interface ActionExecutor {
  supports(type: ActionType): boolean;
  apply(input: { action: Action; site: SiteWriterAdapter; writer: NaturalWriterAdapter }): Promise<{ changedFiles: string[]; summary: string }>;
}
```

- `ReviseActionExecutor`: 旧 `runSeoLoop` のstep5-6（`readPage` → writer.transform → `site.apply` → `site.validate` → 失敗時rollback）をほぼそのまま移設。
- `CREATE`/`LINK`/`MERGE`/`SPLIT`/`RETIRE`: `NotImplementedActionExecutor` を返す。DISCOVER/PROPOSEはこれらのAction typeを**提案として出すこと自体は許す**が、apply mode側で実行しようとした場合は明示的にエラーで停止する。

---

## 10. Workflow

### 10.1 全体像

```text
READ
  ↓
UNDERSTAND
  ↓
DISCOVER
  ↓
PRIORITIZE
  ↓
PROPOSE
  ↓  ← V1 Milestone 1 はここまで
PR作成
  ↓
test
  ↓
review（人間）
  ↓
publish            ← Milestone 2以降
```

`READ`/`UNDERSTAND` を1コマンドに統合し(`seo understand`)、以降は分離する。決定論的コード（state管理・履歴・重複防止・遷移制御）とAI（意味理解・仮説生成）の分離という現行設計の核は維持する: **状態遷移と永続化はcore、意味理解と仮説はSkill（呼び出し元のcoding agent）が担当**。

### 10.2 READ / UNDERSTAND

```bash
npm run seo -- understand --config config/seo.config.json
```

1. `SiteReaderAdapter.listPages()` → `readPage()` で全ページ（上限あり、設定可能）のtext/headingsを収集
2. GSC設定があれば `GscAdapter.fetchQueryPageMatrix()` でクエリ×ページ行列を取得し、`rank-history.json` にsource='gsc'のentryとしてappend
3. Cが読んだ内容から `themes`/`proprietaryDataNotes` を抽出する部分は**構造化input/output越しにAIへ委譲する**（旧Plan生成と同じパターン）。CLIは `--understanding-file <json>`（Skillが事前にページ内容を読んで生成した themes/proprietaryDataNotes の下書き）をマージ入力として受け付ける。CLI単体はページ本文の機械的収集とGSC取得のみ行い、意味理解（テーマ抽出等）そのものはしない。
4. `site-understanding.json` を atomic writeで上書き保存

GSC未設定でも失敗させない。`gscSummary` を省略して `site-understanding.json` を生成し、reportに `GSC_NOT_CONFIGURED` である旨を明記する（旧 `fetch-gsc-ranks` のexit code方針を踏襲: 0成功 / 1取得失敗 / 2未設定）。

### 10.3 DISCOVER

```bash
npm run seo -- discover --config config/seo.config.json --opportunities-file <json>
```

- `site-understanding.json` を読み、Opportunity候補生成の材料（ページ内容、GSCクエリ×ページ、独自データ）をCLIが構造化して出力できるようにする（`seo discover --dump-inputs` のようなヘルパーでSkillに渡す）。
- 実際のOpportunity/Evidence/Hypothesis生成（意味理解）はSkill側（AI）が行い、`--opportunities-file` としてCLIへ渡す。CLIはこのファイルをスキーマ検証し、`opportunities.json` へ**重複排除しながら**マージする（同一 `scope` でstatus:openが既存ならスキップしreportに記載）。
- GSCデータが無い（Bootstrap Mode相当）場合は、`pages.length === 0` かつ `gscSummary === undefined` を検知し、reportに「market/SERP research起点でのdiscoverが必要」という誘導を出す。この経路の自動化はV1では行わない（[§4.2](#42-bootstrap-mode設計のみ実装は後続milestone)）。

### 10.4 PRIORITIZE

Pure functionで実装しテストする（旧 `selectKeyword` と同じ設計原則: score付けではなく明示的なbucket優先順位）。

```ts
function prioritizeOpportunities(input: {
  opportunities: Opportunity[]; // status === 'open' のみ対象
  experiments: Experiment[];
}): { ranked: Opportunity[]; excluded: Array<{ id: string; reason: string }> };
```

Bucket例（実装時に確定させてよいが、方向性は固定）:

1. GSC evidenceが複数あり、既存ページがあり（`scope.type === 'page'`）、position 2〜20 — 「もう一歩でクリック/上位化」する既存資産
2. GSC evidenceはあるが対応ページが無い（`scope.type === 'cluster'`）— コンテンツギャップ
3. 過去にExperimentが `no_effect`/`worse` で終わり、まだ再挑戦していない対象で、evidenceが更新されたもの
4. サイト全体・Bootstrap系（`scope.type === 'site'`）は最低優先（V1では通常出てこない）

除外: `status !== 'open'` のOpportunity、直近で `observing` 中のExperimentが紐づくOpportunity（cooldown中は同一opportunityへの新規提案を作らない）。

```bash
npm run seo -- prioritize --config config/seo.config.json
```

出力は順位付きリストのJSON/表示のみ。状態は変更しない。

### 10.5 PROPOSE

```bash
npm run seo -- propose --config config/seo.config.json \
  --opportunity-id <id> \
  --hypothesis-file <json> \
  --serp-file <json>
```

1. 指定Opportunityに対し、Skillが `Hypothesis` と `Action`（提案）を構造化JSONとして用意し渡す
2. CLIはスキーマ検証し、`Experiment { status: 'proposed' }` を新規作成して `experiments.json` に追加
3. `before` snapshotは `rank-history.json` の最新entryから機械的に埋める（データが無ければ `null` とし `insufficient_data` 相当のマークをつける。「無い」ことを「効果なし」と混同しない、という現行の原則をここでも維持する）
4. Opportunityを `status: 'promoted'` に更新し、`history` にeventを追記
5. Markdown report（`reports/YYYY-MM-DD-HHMMSS.md`）を生成。**これがMilestone 1における最終成果物**。サイトへの書き込みは一切発生しない

**V1 Milestone 1はここで終わる。** サイトへのapply、B呼び出し、PR作成は行わない。

### 10.6 将来: apply mode（Milestone 2以降）

```bash
npm run seo -- apply --config config/seo.config.json --experiment-id <id>
```

旧 `runSeoLoop` のtransaction semantics（[§13](#13-transaction-semantics)）をそのまま踏襲し、`Action.type === 'REVISE'` のExperimentのみ実行可能にする。成功時は `status: 'applied'` → 観察期間設定で `status: 'observing'`。この時点でもリポジトリへの直接pushは行わず、**ブランチ作成+diff提示（PR相当）までをCLIまたはSkillの責務とし、mergeは人間が行う**。「本番への直接pushは初期V1では不要」という要求を、Milestone 2に入ってもなお守る設計とする。

---

## 11. CLI

```bash
npm run seo -- understand --config <path> [--fixture] [--date YYYY-MM-DD]
npm run seo -- discover --config <path> [--opportunities-file <path>]
npm run seo -- prioritize --config <path>
npm run seo -- propose --config <path> --opportunity-id <id> --hypothesis-file <path> [--serp-file <path>] [--dry-run]
npm run seo -- status --config <path>
```

（将来）

```bash
npm run seo -- apply --config <path> --experiment-id <id> [--dry-run]
```

`status` は旧 `getStatus()` のバケツ分類の思想を維持しつつ、opportunities/experimentsの現況を出す:

```ts
type StatusView = {
  openOpportunities: number;
  proposedExperiments: number;
  observingExperiments: Array<{ id: string; opportunityTitle: string; nextReviewDate: string }>;
  dueForReviewExperiments: Array<{ id: string; opportunityTitle: string }>;
  concludedRecently: Experiment[];
};
```

`--dry-run` は全コマンドに付けられるようにし、`understand`/`discover`/`prioritize` はそもそも副作用が小さい（`understand` のみ `site-understanding.json`/`rank-history.json` を書くのでdry-runの意味がある）。`propose` のdry-runは `experiments.json`/`opportunities.json` を書かずreportのみ出す。

`--fixture` は現行同様、fixtureデータのgitignore済み作業コピーを使ってE2Eを再現可能にする仕組みを維持する。

---

## 12. Safety / Guardrails

現行のGuardrailsは基本的に全て維持し、モデル変更に合わせて言い換える。

- 1 discoverで作るproposal（Experiment）数には上限を設ける（デフォルト1、`--max-proposals` で変更可）。「1 runで新規改善は1 keyword」の精神を「1回のPROPOSEで積み上げる提案は絞る」に一般化
- `observing` 中のExperimentに紐づくOpportunityへは、cooldown（`nextReviewDate`）前に新規Experimentを作らない
- `concluded` なExperimentは監視のみ（過去のExperimentを書き換えない）
- `rank-history.json` はappend-only（現行のまま）
- `opportunities.json`/`experiments.json` の `history[]` はappend-only
- GSCの生クエリ×ページ行列を無制限に永続化しない。`site-understanding.json.gscSummary.topQueries` は上位N件に絞る（旧: impressions>=10, top20 の踏襲）
- secretをログ・commitに含めない
- 独自Google SERPスクレイパーは作らない
- **noindex/canonical/URL/大規模IA変更の自動実行は禁止**（提案としてAction type `RETIRE`/`SPLIT`/`MERGE` を出すことはあっても、executorは用意しない）
- 複数記事一括SEO rewriteは禁止
- 改善効果を予測で断定しない（観測結果のみreportに書く）
- 候補がなければ何もしない（捏造しない）
- build/test失敗時にExperimentを`applied`/`observing`へ進めない（Milestone 2)
- **`rakusetsu.com` を含む対象サイトのソースリポジトリ・本番環境への書き込みは、Milestone 1では一切行わない**（read-onlyアダプタのみ使用）

---

## 13. Transaction semantics（Milestone 2向け、設計として確定させておく）

Milestone 1はread-onlyのため厳密なtransactionは不要だが、`propose`/将来の `apply` では現行の設計をそのまま踏襲する。

```text
load state
acquire lock
(apply mode) read target page via SiteReaderAdapter
(apply mode) call writer (B)
(apply mode) apply via SiteWriterAdapter
(apply mode) validate build/test
if validate fails:
  rollback working files if possible
  do NOT advance Experiment.status
  report failure
  exit 1
else:
  Experiment.status = 'applied' -> 'observing'
  append history event
  write state atomically
  report success
release lock
```

JSON file writeはtemp file + renameでatomicにする（現行 `writeJsonFileAtomic` をそのまま再利用）。

### 13.1 Read-only mode / Proposal mode / Future apply mode

| mode | コマンド | 副作用 |
|---|---|---|
| read-only | `understand`, `discover`, `prioritize` | `site-understanding.json`/`rank-history.json` のみ（`understand`のみ） |
| proposal | `propose` | `opportunities.json`/`experiments.json` へ提案を追加。サイトへの書き込みなし |
| apply（将来） | `apply` | サイトへの変更＋build/test検証＋Experiment状態進行。直接pushはしない |

---

## 14. Dry Run

`--dry-run` を持つ全コマンドで:

- 読み取り系処理（fetch/crawl/理解生成）は実行してよい
- 永続ファイル（`site-understanding.json`, `opportunities.json`, `experiments.json`, `rank-history.json`）への書き込みをしない
- サイトへの書き込みをしない（Milestone 2でも同様）
- reportには `DRY RUN` を明記
- 必須test: dry-runで永続ファイルのmutationがゼロであることを確認

---

## 15. Report format

各コマンド実行でMarkdown + console summaryを出す（`reports/YYYY-MM-DD-HHMMSS.md`、現行のまま）。

`understand` report:

- サイト読み取り件数・失敗ページ
- GSC取得window/成否
- 抽出themes（下書き）

`discover` report:

- 新規Opportunity件数、dedupeでスキップした件数
- 各Opportunityのtitle/scope/evidence要約

`prioritize` report:

- ランク付きOpportunity一覧と理由

`propose` report:

- 選択したOpportunity + Hypothesis
- Action種別と内容（提案段階であることを明記）
- before snapshot（またはinsufficient_data）
- dry-run/error情報

「順位改善を予測断定しない」原則は維持する。

---

## 16. Bとの関係（再確認）

- Cが決めるもの: 何を変更するか（Action）、なぜ（Hypothesis.rationale）、必須事実（Action.requiredFacts）、禁止変更（Action.forbiddenChanges）
- Bが行うもの: 文章生成・自然化・事実保持のみ
- C自身は日本語自然化ロジックを持たない
- Bが未実装でも `StubNaturalWriterAdapter` でC単体をテストできる（現行のまま維持）
- Milestone 1ではBは一切呼ばれない（apply modeがまだ無いため）。Milestone 2で `ReviseActionExecutor` から呼ばれる

---

## 17. Existing Site flow（rakusetsu.com、詳細）

```text
1. seo understand --config config/seo.rakusetsu.json
   - HttpSiteReaderAdapterでsitemap.xml or トップページからクロール（上限件数・深さは設定）
   - GSC設定済みなら fetchQueryPageMatrix
   - Skillがページ本文/GSCデータを読み、themes/proprietaryDataNotesの下書きを --understanding-file で渡す
   - site-understanding.json 生成

2. seo discover --config ... --opportunities-file <skillが生成したJSON>
   - site-understanding.jsonとevidenceからOpportunity候補をSkillが作り、CLIが検証・保存

3. seo prioritize --config ...
   - 優先順位付きOpportunity一覧を確認

4. seo propose --config ... --opportunity-id <top> --hypothesis-file <skillが生成したJSON>
   - Experiment(status=proposed)を1件（既定）生成し、reportを出す

5. 人間がreportをレビューし、次のアクション（Milestone 2実装後のapply、または別途手動対応）を判断する
```

このフローに、旧`.claude/skills/seo-rank-watch/SKILL.md` のガードレール精神（独自クローラー禁止、捏造禁止、build/test失敗時に進めない等）を引き継いだ新Skill（`.claude/skills/seo-opportunity-watch/SKILL.md` のような名称を想定）を後続作業で用意する。

---

## 18. Bootstrap flow（設計のみ）

```text
theme + available assets
  -> seo discover --theme "<theme>" --assets-file <json>
       (site-understanding.jsonが空/themeモードのときの特別入力経路)
  -> initial opportunities（scope: 'site' または 'cluster'）
  -> Skillが「最小サイト構成」を決定し、CREATE Action群を提案
  -> V1では自動apply/自動publishしない。人間が初期ページを作成・公開する運用を想定
  -> 公開後、通常のunderstand（GSCデータが乗り始める）に合流
```

`CREATE` action executorはV1で実装しない。Bootstrap Modeは「discoverコマンドがtheme起点の入力を受け付けられる」ところまでを設計上のフックとして用意し、それ以上の自動化は後続milestoneに委ねる。

---

## 19. Acceptance Criteria（V1 Milestone 1）

以下が全て満たされたらMilestone 1 COMPLETE。

- [ ] clean install成功
- [ ] typecheck/build成功
- [ ] 全tests PASS
- [ ] fixture E2E PASS（`understand -> discover -> prioritize -> propose` を fixtureサイト/fixture GSCデータで一周できる）
- [ ] `site-understanding.json` がread-onlyで生成される（サイト・リポジトリへの書き込み一切なし）
- [ ] GSC未設定でも `understand` が失敗せず `GSC_NOT_CONFIGURED` を区別して報告する
- [ ] Opportunity重複排除が機能する
- [ ] cooldown中のOpportunityへ新規Experimentを作らない
- [ ] `experiments.json`/`opportunities.json` の `history[]` がappend-only
- [ ] `rank-history.json` のappend-only保証が維持されている（現行testを流用）
- [ ] dry-runで永続ファイルのmutationがゼロ
- [ ] search resultを外部fileから注入可能（`--serp-file`、現行のまま）
- [ ] hypothesis/opportunitiesを外部fileから注入可能
- [ ] report生成
- [ ] secret guard
- [ ] README / SKILL.md 更新

---

## 20. Tests（Milestone 1で最低限実装するもの）

現行testの多くは**ドメイン型の置き換えに合わせて書き直すだけで方針は再利用できる**。

- `store.test`（新規スキーマでのjson-store読み書き、旧を継承）
- `fs-lock.test`（現行のまま再利用可）
- `gsc-normalize.test` → `gsc-query-page-matrix.test`（query+page dimensionへの変更に合わせて改名・改修）
- `site-reader.test`（HttpSiteReaderAdapterのsitemapパース、クロール上限、テキスト抽出。fixture HTMLを使う）
- `opportunity-dedupe.test`（同一scopeのOpportunity重複排除）
- `prioritize.test`（bucket優先順位、cooldown除外、旧`select-keyword.test`の設計を踏襲）
- `experiment-lifecycle.test`（status遷移の許可/禁止、historyのappend-only）
- `dry-run.test`（現行の設計を踏襲、対象コマンドを新CLIに合わせる）
- `e2e-fixture.test`（fixtureサイト+fixture GSCデータで `understand -> discover -> prioritize -> propose` が一周し、reportが生成されることを確認）

---

## 21. 実装順序（Milestone 1、Codexが実装時に迷わないための骨子）

### Phase 1: ドメイン型 + persistence

- `src/core/types.ts` を本ドキュメント §6-§7 の型で全面書き換え
- `src/core/schemas.ts` をZodで対応
- `json-store.ts`/`fs-lock.ts`/`date.ts` は再利用（必要最小限の調整のみ）
- opportunities/experimentsの `history[]` append-only API

### Phase 2: Site Reader Adapter

- `HttpSiteReaderAdapter`（sitemap取得、浅いクロール、テキスト抽出）
- `FilesystemSiteReaderAdapter`（旧readPage相当をread-onlyに縮小）
- fixture reader（テスト用）

### Phase 3: GSC Adapter改修

- `fetchQueryPageMatrix`（dimensions変更）
- 認証部分は現行 `gsc.ts` から流用

### Phase 4: core workflow

- `understand` / `discover` / `prioritize` / `propose` / `status` の実装
- report生成（旧`report.ts`のパターンを踏襲）

### Phase 5: CLI + fixtures + E2E

- CLIコマンド追加
- fixtureデータ一式（fixture site pages, fixture GSC matrix, fixture opportunities/hypothesis JSON）
- e2e fixture test

### Phase 6: skill/docs

- `.claude/skills/` を新ワークフローに合わせて更新
- README更新
- acceptance確認

---

## 22. 現行設計との対応表（変更点サマリ）

| 旧 | 新 | 扱い |
|---|---|---|
| `KeywordRecord` / `watchwords.json` | 廃止（事前キーワード登録をやめる） | 削除 |
| `RankHistoryEntry`/`RankMeasurement` | ほぼ維持、GSC取得のdimensionを`query`→`query,page`に拡張 | 再利用+拡張 |
| `ImprovementKeywordState`/`ImprovementAction` | `Experiment`（Opportunity/Hypothesis/Actionを内包） | 置き換え |
| `SeoPlan`/`SeoPlanInput` | `Hypothesis` + `Action` | 置き換え（構造はほぼ対応） |
| `SiteAdapter`（read+write+validate） | `SiteReaderAdapter`（read-only, Milestone1） + `SiteWriterAdapter`（Milestone2、旧apply/validateを流用） | 分割 |
| `GscAdapter.fetchRankWindow` | `GscAdapter.fetchQueryPageMatrix` | 改修（認証部分は再利用） |
| `SearchAdapter` | 変更なし | 再利用 |
| `NaturalWriterAdapter` | 変更なし（呼ばれるタイミングがMilestone2に後退） | 再利用 |
| `selectKeyword`（bucket優先順位） | `prioritizeOpportunities`（bucket優先順位） | 設計パターン再利用、実装は書き換え |
| `applyReview` | Experiment状態遷移+`ReviewOutcome`拡張 | 拡張 |
| `runSeoLoop`（1トランザクション） | `propose`（Milestone1）+ 将来`apply`（Milestone2、runSeoLoopのtransaction部分を移設） | 分割 |
| `json-store.ts`/`fs-lock.ts`/`date.ts` | 変更なし | 完全再利用 |
| dry-run / atomic write / lock / append-only history | 変更なし（対象ファイルが増えるのみ） | 完全再利用 |
| insufficient_data判定 | `ReviewOutcome`に統合して維持 | 再利用 |
| fixture E2E | 新ワークフロー向けに再構築するが方針は同じ | 再利用（設計方針） |
| 「1 run 1 keyword」 | 「1 discover/propose あたりの提案数上限」 | 一般化 |
| Skill (`seo-rank-watch`) | 新Skillへ改名・改修（意味理解/AI担当の分離は維持） | 改修 |

---

## 23. 将来候補（v2でも入れない）

- CTR/title専用experiment種別の細分化
- device/country別GSC
- キーワードカニバリゼーション検知
- 内部リンクグラフの自動生成
- multi-page同時experiment
- 統計的有意性エンジン
- PostgreSQL、専用ダッシュボード、分散ワーカー
- 自動scheduler daemon
- Bの品質スコアとの連動
- GA4/conversion連携の自動化（interfaceのみ予約、実装は必要になってから）
- Bootstrap ModeのCREATE自動実行、自動publish

必要性が実測で出てから導入する。
