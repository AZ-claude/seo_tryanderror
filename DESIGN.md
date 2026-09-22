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

最初の実装マイルストーン（Milestone 1A）のスコープは [§19 Acceptance Criteria](#19-acceptance-criteriav1) と
[§21 実装順序](#21-実装順序milestone-1acodexが実装時に迷わないための骨子)、および `IMPLEMENTATION_GOAL.md` を参照。

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

DISCOVERコマンドは、`site-understanding.json` にページ・GSCデータが無ければ自動的にこの経路（theme起点の市場調査）にフォールバックする設計にしておく。CREATE系Actionと初期サイト構成の実行はV1で自動化しない（[§9.6](#96-action-executor実行器) 参照）。

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

**同じページに複数のOpportunityが同時に存在できる。** CTR/titleの改善余地、情報不足、独自データ追加の余地、異なるsearch intentへの対応漏れは、それぞれ別のOpportunityとして共存してよい。これは `page × search intent cluster × hypothesis` という基本単位の直接の帰結であり、dedupeは「ページ単位」ではなく「ページ×intent単位」で行う。

#### 6.1.1 Identity（dedupeキー）

Opportunityの同一性は、自由文の `title` ではなく決定論的な `identity` で判定する。

```ts
type OpportunityScope =
  | { type: 'page'; path: string }
  | { type: 'cluster'; representativeQueries: string[] } // ページが存在しない/複数ページにまたがる需要
  | { type: 'site' }; // Bootstrap Modeの「サイト全体構成」レベルの発見

// Opportunityの「種類」。自由文のtitleではなく、この統制語彙 + Skillが与える短いスラグで
// intentを表現する。これにより「同じ需要を表現違いで何度も生成する」ことを防ぐ。
type OpportunityKind =
  | 'ctr_title'        // CTR/titleの改善余地
  | 'content_gap'       // 検索ニーズに対する情報不足
  | 'proprietary_data'  // 独自データ・一次情報を追加する余地
  | 'intent_mismatch'   // 既存ページが別intentを想定している/対応漏れ
  | 'other';

type OpportunityIdentity = {
  scopeKey: string;  // scopeから決定論的に導出（下記参照）。同一pathやqueryクラスタなら常に同じ文字列
  intentKey: string;  // `${OpportunityKind}:${intentSlug}`。intentSlugはSkillが与える短いkebab-caseスラグ
};
```

`scopeKey` の導出規則（pure function、テスト対象）:

```text
scope.type === 'page'    -> `page:${normalizedPath}`
scope.type === 'cluster' -> `cluster:${sortedNormalizedQueries.join('|')}`  // normalizeQuery(NFKC/lowercase/空白除去)をGSC adapterから再利用
scope.type === 'site'    -> `site`
```

`intentSlug` は自由文の要約ではなく、Skillが選ぶ短い識別子（例: `residual-supply-estimate`）。**titleの言い換えを許さないための制約として、intentSlugは自由文のtitleそのものをそのまま使ってはならない**（バリデーションで、intentSlugがtitleの単純な正規化と一致する場合は警告し再考を促す）。同じ需要を再発見したときにSkillが同じスラグを選べるよう、`discover`はページ内容の構造化ダンプに加えて**そのscopeに既に存在するOpportunityのidentity一覧（kind/intentSlug/title）をヒントとして提供する**（[§10.3](#103-discover)）。

`OpportunityIdentity`（`scopeKey` + `intentKey` の組）が一致するOpportunityは同一とみなし、重複生成しない。逆に `scopeKey` が同じでも `intentKey` が異なれば別Opportunityとして共存する。

#### 6.1.2 本体

```ts
type Opportunity = {
  id: string; // ULID
  createdAt: string;
  updatedAt: string;
  scope: OpportunityScope;
  identity: OpportunityIdentity;
  kind: OpportunityKind;
  title: string; // 「未開封BOXの将来供給量を知りたい需要がある」のような一文。人間可読の要約であり、dedupeキーには使わない
  description: string;
  evidence: Evidence[];
  // signals はcoreがevidenceから機械的に導出する（AIの自己申告ではない）。PRIORITIZEの入力になる。§10.4参照
  signals: {
    hasGscTraction: boolean; // evidenceにsource='gsc_query'|'gsc_page'が含まれる
    contentGapConfirmed: boolean; // evidenceにsource='serp'が含まれる（上位比較済み）
    leveragesProprietaryData: boolean; // evidenceにsource='proprietary_data'が含まれる
  };
  status: 'open' | 'promoted' | 'rejected' | 'stale';
  // open: 新規Experiment提案の対象になれる（アクティブなExperimentが紐づいていない）
  // promoted: proposed/approved/applied/observingのいずれかのExperimentが現在紐づいている（§7.3, §12のactive experiment guardの根拠）。
  //           そのExperimentがconcluded/rejectedになった時点でcoreが自動的にopenへ戻す
  // rejected: 検討したが見送りと明示的に判断した（理由をhistoryに残す）。discover時に自動では再浮上しない
  // stale: V1では自動遷移させない（予約のみ。将来、再UNDERSTANDが必要な鮮度切れ検知に使う）
  history: OpportunityEvent[]; // append-only
};

type OpportunityEvent = {
  at: string;
  type: 'discovered' | 'promoted' | 'released' | 'rejected' | 'reopened' | 'note';
  // promoted: open -> promoted（Experiment作成時）
  // released: promoted -> open（紐づくExperimentがconcluded/rejectedになり、他にアクティブなExperimentが無い場合、core自動発行）
  // rejected: 明示的にOpportunity自体を見送ると判断
  // reopened: rejectedからopenへの明示的な復帰（後述、理由必須）
  note?: string;
  relatedExperimentId?: string;
};
```

#### 6.1.3 再発見ルール（reopen / reject / promote後の扱い）

DISCOVERが同一 `identity` のOpportunityを既存データの中に見つけたときの扱いを固定する。

| 既存Opportunityのstatus | discoverの挙動 |
|---|---|
| `open` | 新規作成しない。新しいevidenceがあれば `evidence[]` に追記し、`updatedAt` を更新。重複作成としてreportに記載 |
| `promoted` | 新規作成しない。「アクティブなExperimentが既にある」旨をreportに記載し、スキップ（[§12](#12-safety--guardrails)のactive experiment guardと整合） |
| `rejected` | **自動では再浮上させない。** `--opportunities-file` の該当エントリに明示的な `reopen: true` とその理由（`reopenReason: string`、必須）が含まれている場合のみ、coreが `status: 'open'` に戻し `reopened` イベントを追記する。理由が無い場合はスキップしreportに「rejected済み、reopenするには理由が必要」と記載 |
| `stale` | V1では発生しない（stale自動遷移は未実装のため） |

同一 `scopeKey` だが `intentKey` が異なる場合は、常に別Opportunityとして新規作成してよい（重複ではない）。

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

Hypothesisを実行に移す変更の種類。V1で**自動実行するのはREVISEのみ**（それもMilestone 2以降、[§9.6](#96-action-executor実行器)参照）。他は型として定義するが実行器（executor）は用意しない/スタブでNotImplementedとする。

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

「このOpportunityとHypothesisに基づき、このMeasurementPlanで測ると決め、このActionを行い、結果はこうだった」という一連の試行。**これがExperiment Memoryの単位**であり、構成要素は

```text
Opportunity -> Hypothesis -> Action -> MeasurementPlan -> Before -> After -> Result -> Learning
```

の順で並ぶ。

#### 6.5.1 MeasurementPlan

「何を測ればHypothesisが支持されたと判断できるか」を、Experiment作成時に固定する。これがないと `before`/`after` の比較対象があいまいになり、Experiment Memoryが学習資産として機能しない。

```ts
type MeasurementPlan = {
  targetPages: string[]; // before/afterの集計対象ページ（Action.targetPathsと一致することが多いが、独立して持つ）
  targetQueries?: string[]; // 対象クエリ/intent clusterを絞りたい場合（省略時はtargetPagesの全クエリを対象）
  primaryMetric: MetricKey; // Hypothesis支持/不支持の主判定に使う指標
  secondaryMetrics: MetricKey[]; // 参考指標
  baselineWindowDays: number; // beforeスナップショットの集計window長
  reviewWindowDays: number; // afterスナップショットまでの観察期間（旧cooldownDaysに相当）
  minimumImpressions?: number; // これ未満のimpressionsしか無い場合はinsufficient_dataとする閾値
};
```

`primaryMetric`/`secondaryMetrics` は [§6.3](#63-hypothesis) の `Hypothesis.expectedSignals` と整合させる（`primaryMetric` は `expectedSignals` に含まれる指標から選ぶ）。

#### 6.5.2 Experiment本体

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
  window: { start: string; end: string; days: number };
  scope: { targetPages: string[]; targetQueries?: string[] }; // MeasurementPlanのscopeをそのまま転記（監査用）
  metrics: Partial<Record<MetricKey, number>>;
  sufficientData: boolean; // MeasurementPlan.minimumImpressionsを満たしたか
};

type Experiment = {
  id: string;
  opportunityId: string;
  hypothesisId: string;
  action: Action;
  measurementPlan: MeasurementPlan;
  status: ExperimentStatus;
  before: MetricsSnapshot | null; // sufficientData=falseで作れない場合はnull（insufficient_data）
  after?: MetricsSnapshot;
  observation?: { start: string; end: string; nextReviewDate: string };
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

#### 6.5.3 before/afterの算出ルール（scope・data lag・insufficient_data）

- `before`/`after` は**「最新のrank-history全体」ではなく、`measurementPlan.targetPages`/`targetQueries` に一致する行だけを `rank-history.json` から抽出して集計する**。旧設計の「登録watchwordの最新測定値をそのまま使う」実装（`getLatestMeasurementWithSource`）はこの用途には使わない
- `before` の集計windowは `baselineWindowDays`、`after` は `reviewWindowDays` 経過後に、現行の `computeMeasurementWindow`（`finalDataLagDays` を考慮した終端日ずらし）をそのまま再利用して計算する
- 集計したimpressions合計が `minimumImpressions` 未満（未設定なら現行同様データが1件も無い場合）は `sufficientData: false` とし、`ReviewOutcome` は必ず `insufficient_data` にする。**`no_effect`（差が無かった）と `insufficient_data`（測れなかった）を混同しない**という現行原則をscope限定後も維持する
- `after` が未取得の間（`observing`中）は `result` を確定させない
- fixture testでは、`measurementPlan.targetPages` を意図的に一部ページのみに絞ったケースを用意し、`before` スナップショットが**そのページのみ**から算出されること（他ページの数値が混入しないこと）を検証する

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

**DISCOVERはページ本文を必要とする。** `understand`が収集した本文を捨てて `path`/`title`/`headings`/`wordCount` だけを残すと、DISCOVERがページ内容の根拠を持てなくなる。かといって全文を無制限に永続化するのはYAGNIに反する（vector store等の大規模基盤は作らない）。そこで、**bounded excerpt + content hash** をこの1ファイルの中に保持する（案A相当。専用の別ファイルは追加せず、既存の `site-understanding.json` を拡張するだけに留める）。

```ts
type PageSnapshot = {
  path: string; // サイト内相対パス、またはfull URL（HTTP読み取り時）
  title?: string;
  headings: string[];
  excerpt: string; // クリーニング済みテキストの先頭から最大 EXCERPT_MAX_CHARS（既定4000文字、設定可能）まで
  excerptTruncated: boolean; // 本文がexcerptより長く切り詰められたか
  contentHash: string; // クリーニング済みテキスト全体のsha256。差分検知・provenance用（本文自体は保存しない）
  wordCount: number;
  fetchedAt: string;
};

type SiteUnderstanding = {
  schemaVersion: 2;
  site: { baseUrl: string };
  generatedAt: string;
  pages: PageSnapshot[];
  themes: string[]; // Cが読んで抽出したトピック一覧（自由記述、構造化しすぎない）
  proprietaryDataNotes: string[]; // 独自データ・一次情報として見つけたものの記述
  gscSummary?: {
    window: { start: string; end: string; days: number };
    topQueries: Array<{ query: string; page: string | null; clicks: number; impressions: number; ctr: number; position: number }>;
  };
  maturity: SiteMaturity;
};
```

**Provenance:** DISCOVERは `SiteReaderAdapter` を再取得せず、`understand` が生成したこの `site-understanding.json` のみを入力とする。したがって同じ `site-understanding.json`（同じ `generatedAt`）を使う限り、DISCOVERの入力は完全に再現可能。`Evidence.source === 'existing_page'` のエビデンスは `ref` に `${path}#${contentHash}` を入れ、どのスナップショット時点のどのページ本文を根拠にしたかを一意に追跡できるようにする。サイトが `understand` と `discover` の間で変わっていても、DISCOVERが見ているのは常に最後の `understand` 実行時点のスナップショットであり、二重取得や未知のcrawl回数増加は発生しない（再UNDERSTANDしない限りDISCOVERはHTTPアクセスを一切行わない）。

excerptの上限（`EXCERPT_MAX_CHARS`）は既存の「GSCの生クエリ×ページ行列を無制限に永続化しない」というガードレールと同じ精神で、ページ本文についても上限を設ける（[§12](#12-safety--guardrails)に追記）。

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
- `identity`（`scopeKey`+`intentKey`）はcreate時発行、以後不変。dedupeはこの `identity` の完全一致で判定する（[§6.1.1](#611-identitydedupeキー)）。**`scope`単位のdedupeは行わない**——同一ページに複数のOpportunityが共存できる
- `status` は更新可能。ただし `open <-> promoted` の遷移はcoreがExperimentの状態変化に応じて自動的に行う（[§7.3](#73-experimentsjson-のwrite-rule)）。`rejected`/`reopened` は明示的な操作でのみ発生する（[§6.1.3](#613-再発見ルールreopen--reject--promote後の扱い)）
- `history[]` はappend-onlyの専用API (`appendOpportunityEvent`) 経由のみ
- `signals` はcoreが `evidence[]` から機械的に再計算する派生値であり、外部から直接書き込ませない

### 7.3 experiments.json のwrite rule

- `id` は不変
- `status` 遷移は許可された遷移のみ（`proposed -> approved -> applied -> observing -> concluded`、または各段階から `rejected`）。不正な遷移はエラー
- **Active experiment guard**: 同一 `opportunityId` に対し、`status` が `proposed`/`approved`/`applied`/`observing` のいずれかであるExperimentが既に存在する間は、新しいExperimentを作成できない。`propose --opportunity-id` を直接指定した場合もcore側でこのチェックを行い拒否する（[§12](#12-safety--guardrails)）。`rejected`または`concluded`に達すると、対応するOpportunityは自動的に `status: 'open'` へ戻り（`released` イベント追記）、新規Experimentの作成が再び可能になる。追加のcooldownは課さない（`observing`期間そのものが十分な待機期間である）
- `history[]` はappend-onlyの専用API経由のみ
- `before` は一度設定したら不変。`after`/`result`/`learning` は観察終了時にのみ設定
- `measurementPlan` はcreate時発行、以後不変（[§6.5.1](#651-measurementplan)）。`before`/`after` は必ず `measurementPlan` の scope（`targetPages`/`targetQueries`）に基づいて算出する

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

`experiment.oneKeywordPerRun` は廃止(キーワード中心モデルの廃止に伴う)。代わりに「1 discoverあたり生成するproposalの上限」を運用ガードとして持たせてよいが、これはCLIオプション(`--max-proposals`)で十分であり、config必須項目にはしない。

`gsc.reviewWindowDays`/`experiment.cooldownDays` は**既定値**であり、`propose`時にSkillが `MeasurementPlan.baselineWindowDays`/`reviewWindowDays`([§6.5.1](#651-measurementplan))を明示しなければこれらの値が使われる。個々のExperimentの実測window長は最終的に `MeasurementPlan` に固定され、後から config を変えても既存Experimentの判定基準は変わらない(監査可能性のため)。

`commands.build`/`commands.test` はMilestone 1では未使用(read-onlyのため)。`site.reader: "http"` かつ `mode: "existing"` かつ `repoRoot: null` が `rakusetsu.com` の初期構成になる。

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
UNDERSTAND
  ↓
DISCOVER
  ↓
PRIORITIZE
  ↓
PROPOSE
  ↓
B
  ↓
APPLY / deploy
  ↓
OBSERVE
  ↓
REVIEW（checkpoint: 3 / 7 / 14 / 28日）
  ↓
conclude可能 → LEARN → Opportunity release
conclude不可 → observe継続
  ↓
repeat（毎日。複数Experimentを並行観測しながら回す — 1件のExperimentが
        28日終わるのを待って次に進む、という直列運用はしない）
```

**現在の実装状態（更新履歴の概要。詳細は各節）:**
`understand -> discover -> prioritize -> propose` は当初のMilestone 1の範囲どおり実装済み。続けて、実サイト（rakusetsu.com）への最初のREVISE適用一式（`apply`、B連携、rolling checkpoint review、`concluded`後のOpportunity release、`discover`への `experimentMemory`、並行Experiment向けのpage衝突ガード・最大並行数ガード）も実装済み（[§10.6](#106-apply-実装済みmilestone-2最小スコープ)、[§10.7](#107-rolling-checkpoint-review実装済み)）。当初「Milestone 1はここで終わる、B呼び出し・apply・PR作成は行わない」としていた記述は、最初の1件を人間の明示許可のもとで手動運用として実施した際の暫定境界であり、現在はその先（apply/review/conclude/並行実行）までコードとして存在する。ただし **scheduler化（Windows Task Scheduler等への自動登録、無人での毎日実行）はまだ行っていない** — 1 daily cycleは手動、またはClaude Codeの `seo-growth-loop` Skill経由での起動を前提とする（[§14 将来](#14-将来的な拡張任意)相当）。

`READ`/`UNDERSTAND` を1コマンドに統合し(`seo understand`)、以降は分離する。決定論的コード（state管理・履歴・重複防止・遷移制御）とAI（意味理解・仮説生成）の分離という現行設計の核は維持する: **状態遷移と永続化はcore、意味理解と仮説はSkill（呼び出し元のcoding agent）が担当**。

### 10.2 READ / UNDERSTAND

```bash
npm run seo -- understand --config config/seo.config.json
```

1. `SiteReaderAdapter.listPages()` → `readPage()` で全ページ（上限あり、設定可能）のtext/headingsを収集し、各ページを `PageSnapshot`（`excerpt`＋`contentHash`＋`wordCount`、[§6.7](#67-site-understanding新規)）に変換する。excerptは `EXCERPT_MAX_CHARS` で機械的に切り詰め、全文は保持しない
2. GSC設定があれば `GscAdapter.fetchQueryPageMatrix()` でクエリ×ページ行列を取得し、`rank-history.json` にsource='gsc'のentryとしてappend
3. Cが読んだ内容から `themes`/`proprietaryDataNotes` を抽出する部分は**構造化input/output越しにAIへ委譲する**（旧Plan生成と同じパターン）。CLIは `--understanding-file <json>`（Skillが事前にページ内容を読んで生成した themes/proprietaryDataNotes の下書き）をマージ入力として受け付ける。CLI単体はページ本文の機械的収集とGSC取得のみ行い、意味理解（テーマ抽出等）そのものはしない。
4. `site-understanding.json` を atomic writeで上書き保存

GSC未設定でも失敗させない。`gscSummary` を省略して `site-understanding.json` を生成し、reportに `GSC_NOT_CONFIGURED` である旨を明記する（旧 `fetch-gsc-ranks` のexit code方針を踏襲: 0成功 / 1取得失敗 / 2未設定）。

### 10.3 DISCOVER

```bash
npm run seo -- discover --config config/seo.config.json --opportunities-file <json>
```

- `site-understanding.json`（ページの`excerpt`/`headings`込み、[§6.7](#67-site-understanding新規)）を読み、Opportunity候補生成の材料（ページ内容、GSCクエリ×ページ、独自データ）をCLIが構造化して出力できるようにする（`seo discover --dump-inputs` のようなヘルパーでSkillに渡す）。**この時点でCLIは再クロールしない** — 入力は常に直近の `understand` が保存したスナップショットのみ（[§6.7 Provenance](#67-site-understanding新規)）
- `--dump-inputs` の出力には、既存 `opportunities.json` に登録済みの `identity`（`scopeKey`/`intentKey`/`kind`/`title`）一覧も含める。Skillはこれを見て、同じ需要を再発見した場合に同じ `kind`+`intentSlug` を選べる（[§6.1.1](#611-identitydedupeキー)）
- 実際のOpportunity/Evidence/Hypothesis生成（意味理解）はSkill側（AI）が行い、`--opportunities-file` としてCLIへ渡す。CLIはこのファイルをスキーマ検証し、`opportunities.json` へ**`identity`（`scopeKey`+`intentKey`）単位で重複排除しながら**マージする。挙動は [§6.1.3](#613-再発見ルールreopen--reject--promote後の扱い) の表のとおり（`open`はevidence追記のみ、`promoted`はスキップ、`rejected`は明示的reopenが無い限りスキップ）。**同一`scopeKey`でも`intentKey`が異なれば必ず新規作成する**
- GSCデータが無い（Bootstrap Mode相当）場合は、`pages.length === 0` かつ `gscSummary === undefined` を検知し、reportに「market/SERP research起点でのdiscoverが必要」という誘導を出す。この経路の自動化はV1では行わない（[§4.2](#42-bootstrap-mode設計のみ実装は後続milestone)）。

### 10.4 PRIORITIZE

Pure functionで実装しテストする（旧 `selectKeyword` と同じ設計原則: score付けではなく明示的なbucket優先順位）。

```ts
function prioritizeOpportunities(input: {
  opportunities: Opportunity[]; // status === 'open' のみ対象
  experiments: Experiment[];
}): { ranked: Opportunity[]; excluded: Array<{ id: string; reason: string }> };
```

**V1のbucket規則をここで確定する（正本はDESIGN.mdであり、実装時に変更しない）。** 順位はGSC順位（position）に依存させない——「position 2〜20だから最優先」という旧keyword中心設計には戻らない。判断材料は `Opportunity.signals`（[§6.1.2](#612-本体)、evidenceから機械的に導出済み）と過去のExperiment結果、active experiment guard、実行可能性の4点に限定し、複雑なスコアリングエンジンは作らない。

対象: `status === 'open'` のOpportunityのみ（`promoted`/`rejected`/`stale` は除外——`promoted` は [§7.3 active experiment guard](#73-experimentsjson-のwrite-rule) によりアクティブなExperimentが既にあることを意味するため、cooldown中の除外は自動的にここに含まれる）。

Bucket（上から優先）:

1. **実需要のある既存資産の改善**: `signals.hasGscTraction && signals.contentGapConfirmed && scope.type === 'page'` — GSCで実際に反応があり、かつSERP比較で不足が確認済みの既存ページ。最も確度が高く実行可能性も高い
2. **実需要のあるコンテンツギャップ**: `signals.hasGscTraction && scope.type === 'cluster'` — 需要は確認できるが対応ページが無い
3. **独自データを活かせる差別化**: `signals.leveragesProprietaryData` かつ Bucket 1/2に該当しないもの — 実需要がまだ弱くても、他サイトが真似できない一次情報を武器にできる機会
4. **再挑戦**: 同一 `identity` に紐づく過去のExperimentが `no_effect`/`worse`/`partially_supported` で `concluded` しており（＝`released`済みで現在`open`）、`evidence[]` が前回のExperiment作成時点より増えている（新しい根拠が追加されている）もの
5. **その他**: 上記いずれにも該当しないもの（`scope.type === 'site'` を含む。Existing Site ModeのV1では通常空、Bootstrap Mode向けの受け皿）

同一bucket内のtie breaker（決定論的、上から順に適用）:

1. `evidence.length` 降順（根拠が多いほど優先）
2. `createdAt` 昇順（発見が古いものを先に——飢餓状態を防ぐ）
3. `id` 昇順（最終的な決定論的タイブレーク）

除外: `status !== 'open'` のOpportunity全て。

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

1. **Active experiment guard**: 指定Opportunityに `proposed`/`approved`/`applied`/`observing` のいずれかのExperimentが既に紐づいていれば、`--opportunity-id` を直接指定していても即エラーで停止する（[§7.3](#73-experimentsjson-のwrite-rule)）。`open` でないOpportunity（`rejected`/`stale`）も同様に拒否する
2. 指定Opportunityに対し、Skillが `Hypothesis` と `Action`（提案）に加えて `MeasurementPlan`（[§6.5.1](#651-measurementplan)）を構造化JSONとして用意し渡す
3. CLIはスキーマ検証し、`Experiment { status: 'proposed' }` を新規作成して `experiments.json` に追加
4. `before` snapshotは `measurementPlan.targetPages`/`targetQueries` にscopeした `rank-history.json` のエントリから機械的に算出する（[§6.5.3](#653-beforeafterの算出ルールscopedata-laginsufficient_data)）。scope内のimpressions合計が `minimumImpressions` 未満、またはデータが無ければ `before: null` とし `insufficient_data` 相当のマークをつける。「無い」ことを「効果なし」と混同しない、という現行の原則をここでも維持する
5. Opportunityを `status: 'promoted'` に更新し、`history` に `promoted` eventを追記
6. Markdown report（`reports/YYYY-MM-DD-HHMMSS.md`）を生成。**これがMilestone 1における最終成果物**。サイトへの書き込みは一切発生しない

**当初のMilestone 1はここで終わっていた。** サイトへのapply、B呼び出し、PR作成は最初は行わなかった。最初の1件（rakusetsu.com `/pokemon-box-price/`）は人間の明示許可のもとで実施し、その過程で必要になった最小限のMilestone 2実装（`apply` CLI、rolling checkpoint review）を後追いでコードとして固定した（[§10.6](#106-apply-実装済みmilestone-2最小スコープ)、[§10.7](#107-rolling-checkpoint-review実装済み)）。

### 10.6 apply（実装済み、Milestone 2最小スコープ）

```bash
npm run seo -- apply --config config/seo.config.json \
  --experiment-id <id> --evidence-file <path> [--dry-run]
```

`src/core/workflow/apply.ts`。`Action.type === 'REVISE'` かつ `status: 'proposed'` のExperimentのみ受け付ける（CREATE/MERGE/SPLIT/RETIRE、および汎用のクロスリポジトリSiteWriter/NaturalWriter実行器はまだ実装しない——[§9.6](#96-action-executor実行器)のNotImplementedActionExecutorのまま）。

このコマンド自身は対象サイトのリポジトリを編集したりBを呼んだりしない。サイト側の編集・B（`seo_japanese`）でのreview・lint/build・commit・deployは、Skill（またはそれを呼び出す人間）が対象サイトのリポジトリで直接行う。`apply` はその結果を構造化evidence（`ApplyEvidence`: 対象ページ、commit SHA、B の `claim_preservation`、site validation結果、live verification結果）として受け取り、検証したうえで**既存の** `transitionExperiment()` 状態機械（Milestone 1時点で実装済み、これまで未使用だった）を使って `proposed -> approved -> applied -> observing` へappend-onlyで進める。`observation.start`/`end`/`nextReviewDate` は `measurementPlan.reviewWindowDays` から機械的に算出する。

「リポジトリへの直接pushは行わず、ブランチ作成+diff提示までをCLIの責務とし、mergeは人間が行う」という当初の設計は、**最初の1件については人間が対象サイトのリポジトリで直接commit/pushする運用（ユーザーの明示許可あり）に変わっている。** 汎用のPR自動作成・自動push機構はまだ実装していない。

### 10.7 Rolling checkpoint review（実装済み）

28日間隔で1回だけ判定する直列運用ではなく、固定tier `[3, 7, 14, 28]`（`CHECKPOINT_DAYS`）日でのrolling reviewを行う。「見るタイミング」であり「必ず終了するタイミング」ではない——早いtierで十分なsignalが無ければ単に観測を続ける。

**equal-window比較**: `rank-history.json` のtrailing 28日snapshotを早期review（例: 7日目）にそのまま使うと、変更前後で大部分の日数が重複し判定が歪む。そのため `review` は `RealGscAdapter.fetchQueryPageMatrix()`（独自GSC clientは作らない）で毎回**厳密な日付範囲**を直接read-only取得し、before/afterを同じ日数で比較する（`src/core/review.ts` の `computeComparisonWindow`）。**deploy日（`observation.start`）はbefore/afterのどちらからも完全に除外する**——`afterStart` は `observation.start + 1日`、`beforeEnd` は `observation.start - 1日`。deploy日はdeploy前とdeploy後のトラフィックが混在する部分日であり、3日/7日のような短いcheckpointではこの1日を「変更前」にも「変更後」にも含めたくないため。`afterEnd` は `min(observation.start + checkpointDay, today - finalDataLagDays)` でfinal data lagを反映する。例（`observation.start = 2026-09-21`、`checkpointDay = 7`、`finalDataLagDays = 2`、review日 `2026-09-29`）: `after = 2026-09-22..2026-09-27`（6日）、`before = 2026-09-15..2026-09-20`（6日、9/21は含まない）。

```bash
npm run seo -- review --config config/seo.config.json \
  --experiment-id <id> --dump-inputs
```

read-only。`{ experiment, elapsedDays, checkpoint, comparison: {before, after, delta}, sufficientData, canConclude, metricDirection, note }` を出力する。`checkpoint` は「まだ記録していない最小のtierで、かつobservation開始後のfinal dataが存在する」もの。無ければ `null`（=まだ何もすることがない、no-op）。

意味判断（`hypothesis_supported`/`partially_supported`/`no_effect`/`worse`/`insufficient_data` のどれか）はSkillが行い、`--review-file` で渡す。coreは以下だけを機械的に保証する:

- `minimumImpressions` 未達なら `sufficientData: false`。ただし最終(28日)tierでなければ `decision: 'continue_observing'` に留め、勝手に`insufficient_data`として終了させない。28日tierで未達なら `insufficient_data` としてconclude可能にする
- `insufficient_data` は `no_effect` と絶対に混同させない（`assertOutcomeConsistentWithCheckpoint` がcore側で強制する）
- `decision: 'continue_observing'` を送った場合は `ReviewCheckpoint` をExperimentへ追記するだけ（`checkpoints[]`、append-only）で状態遷移はしない
- `decision: 'conclude'` の場合、checkpointの追記に加えて `after`/`result`/`learning` を保存し、`status: 'concluded'` へ遷移。対応するOpportunityは、**他にそのOpportunityを参照するactiveなExperimentが無ければ** `open` へrelease（[§6.1.2](#612-本体) の `released` イベントをそのまま再利用）

専用の統計的有意性エンジンやBayesian最適化は作らない（YAGNI）。coreが出すのは `before`/`after`/`delta`/`elapsedDays`/`sufficientData`/`metricDirection`（`position` のみlower-is-better）という構造化データのみで、「成功」を決める%閾値は一切発明しない。

### 10.8 並行Experiment・page/query conflict guard（実装済み）

1つのExperimentのreviewを待ってサイト全体のPDCAを止めない。`config.experiment.maxActiveExperiments`（未指定時3）まで、複数のActiveなExperiment（`proposed`/`approved`/`applied`/`observing`）を並行させてよい。

ただし**同じページに2つ以上のactiveなExperimentを同時に走らせると、効果がどちらの変更によるものか分からなくなる**。そのため `propose` 時、既存のOpportunity単位のactive experiment guard（[§7.3](#73-experimentsjson-のwrite-rule)）に加えて、`Action.targetPaths` / `MeasurementPlan.targetPages` のページscopeが既存のactiveなExperimentと重なっていないかを確認する（`assertNoActivePageConflict`、エラーコード `ACTIVE_PAGE_EXPERIMENT_EXISTS`）。別のOpportunityであっても、同じページを指していればブロックする。異なるページなら常に並行可能。V1ではcluster Opportunity同士のキーワード意味重複検出は行わない（scopeがpageと重ならなければ許可）。

**query conflict guard（`assertNoActiveQueryConflict`、エラーコード `ACTIVE_QUERY_EXPERIMENT_EXISTS`）**: 同じqueryを狙う2つのExperimentが別ページで同時に走ると、page conflict guardをすり抜けてしまう（ページが異なるため）。そこで `measurementPlan.targetQueries` を**双方が指定している場合のみ**、exact string matchで1件でも重複していれば `propose` を拒否する。正規化・大文字小文字統一・空白除去・類似語判定等は一切行わない——`targetQueries` が片方でも未指定（page-level測定のExperiment）なら判定自体をスキップする。「意味的に近い検索意図を避ける」判断はcoreの責務ではなくSkillの責務のまま（`.claude/skills/seo-growth-loop/SKILL.md` に明記）。

---

## 11. CLI

```bash
npm run seo -- understand --config <path> [--fixture] [--date YYYY-MM-DD]
npm run seo -- discover --config <path> [--opportunities-file <path> | --dump-inputs]
npm run seo -- prioritize --config <path>
npm run seo -- propose --config <path> --opportunity-id <id> --hypothesis-file <path> [--serp-file <path>] [--dry-run]
npm run seo -- apply --config <path> --experiment-id <id> --evidence-file <path> [--dry-run]
npm run seo -- review --config <path> --experiment-id <id> [--dump-inputs | --review-file <path>] [--dry-run]
npm run seo -- status --config <path>
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
- **Active experiment guard**: 同一Opportunityに `proposed`/`approved`/`applied`/`observing` のExperimentが存在する間、新しいExperimentは（`propose --opportunity-id` の直接指定であっても）core側で拒否する。これは `Opportunity.status === 'promoted'` として表現され、対応するExperimentが `concluded`/`rejected` になった時点で自動的に `open` へ戻る（[§7.3](#73-experimentsjson-のwrite-rule)、[§6.1.2](#612-本体)）
- `concluded` なExperimentは監視のみ（過去のExperimentを書き換えない）
- `rank-history.json` はappend-only（現行のまま）
- `opportunities.json`/`experiments.json` の `history[]` はappend-only
- GSCの生クエリ×ページ行列を無制限に永続化しない。`site-understanding.json.gscSummary.topQueries` は上位N件に絞る（旧: impressions>=10, top20 の踏襲）
- **ページ本文を無制限に永続化しない**。`site-understanding.json` に保存するページ本文は `EXCERPT_MAX_CHARS`（既定4000文字）で切り詰めた `excerpt` のみとし、全文は保存しない（[§6.7](#67-site-understanding新規)）
- `rejected` なOpportunityは、`--opportunities-file` に明示的な `reopen: true` + 理由が無い限りdiscoverが自動的に再浮上させない（[§6.1.3](#613-再発見ルールreopen--reject--promote後の扱い)）
- Opportunityのdedupeは `identity`（`scopeKey`+`intentKey`）単位で行い、`scope` 単位では行わない——同じページに複数の異なるintentのOpportunityが共存できることを前提にする（[§6.1.1](#611-identitydedupeキー)）
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

**このフローの実行は Milestone 1B（[§19.2](#192-milestone-1b--rakusetsucom-live-read-only-validation明示的に許可された後にのみ実行)）に属する。** 実装agentがfixtureだけで実装を完了させる Milestone 1A の範囲には、`rakusetsu.com` への実際のアクセスは含まれない。

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

## 19. Acceptance Criteria（V1）

V1を2段階に分ける。**fixture E2EがPASSすることは「rakusetsu.comで使える」ことを意味しない。** それを評価するのは意図的に分離されたMilestone 1Bである。

### 19.1 Milestone 1A — Implementation qualification（coding agentのDefinition of Done）

実装agentは、ここまでを**ユーザー確認待ちにせず**完了させる。`rakusetsu.com`・GSC・その他本番環境には一切アクセスしない。

- [ ] clean install成功
- [ ] typecheck/build成功
- [ ] 全tests PASS
- [ ] fixture E2E PASS（`understand -> discover -> prioritize -> propose` を fixtureサイト/fixture GSCデータで一周できる）
- [ ] `HttpSiteReaderAdapter` のfixture test（sitemapパース、クロール上限、テキスト抽出、robots.txt尊重）がPASS
- [ ] `site-understanding.json` がread-onlyで生成される（サイト・リポジトリへの書き込み一切なし。`SiteReaderAdapter` が型として書き込みメソッドを持たないことで担保）
- [ ] GSC未設定でも `understand` が失敗せず `GSC_NOT_CONFIGURED` を区別して報告する
- [ ] Opportunity dedupeが `identity`（`scopeKey`+`intentKey`）単位で機能し、同一ページの異なるintentのOpportunityが共存できることをtestで示す（[§6.1](#61-opportunity)）
- [ ] `rejected` なOpportunityが明示的reopenなしに自動再浮上しないことをtestで示す
- [ ] Active experiment guardが機能する: 同一Opportunityに`proposed`/`approved`/`applied`/`observing`のExperimentがある間、新規Experiment作成（`--opportunity-id`直接指定を含む）が拒否される
- [ ] `experiments.json`/`opportunities.json` の `history[]` がappend-only
- [ ] `rank-history.json` のappend-only保証が維持されている（現行testを流用）
- [ ] `before` snapshotが `MeasurementPlan.targetPages`/`targetQueries` のscopeに基づいて算出され、scope外のページ/クエリの数値が混入しないことをfixture testで示す（[§6.5.3](#653-beforeafterの算出ルールscopedata-laginsufficient_data)）
- [ ] `minimumImpressions` 未達時に `insufficient_data` となり `no_effect` と混同されないことをtestで示す
- [ ] dry-runで永続ファイルのmutationがゼロ
- [ ] search resultを外部fileから注入可能（`--serp-file`、現行のまま）
- [ ] hypothesis/opportunities/measurementPlanを外部fileから注入可能
- [ ] report生成
- [ ] secret guard
- [ ] README / SKILL.md 更新

### 19.2 Milestone 1B — rakusetsu.com live read-only validation（明示的に許可された後にのみ実行）

Milestone 1Aの完了後、**ユーザーが明示的に許可したタイミングでのみ**実行する運用上の検証フェーズ。ここで初めて「Cが実サイトを理解して有用なOpportunityを見つけられるか」を評価する。コード変更を伴わない。

- [ ] `rakusetsu.com` をHTTP read-onlyで取得できる（sitemap優先、無ければ浅いクロールにフォールバック）
- [ ] GSCが設定されていればread-only取得できる（未設定でも `understand` は完走する）
- [ ] `site-understanding.json` が生成される
- [ ] Opportunity discoveryが実行され、意味のある候補が得られる
- [ ] prioritizeが妥当な順位を出す
- [ ] proposalのMarkdown reportが生成される
- [ ] `rakusetsu.com`・そのソースリポジトリ・本番環境へのmutationが0件であることを確認する
- [ ] 生成された初回proposalを人間がレビューする（品質判断はここで行い、Milestone 2投資の可否を決める）

Milestone 1Bの実行そのものが「本番不可逆変更」や「secret/外部アカウント設定」に該当するため、[§0](#0-実装指示実装開始が許可された時点で有効)のユーザー確認ルールにより、実装agentが独断で着手してはならない。

---

## 20. Tests（Milestone 1で最低限実装するもの）

現行testの多くは**ドメイン型の置き換えに合わせて書き直すだけで方針は再利用できる**。

- `store.test`（新規スキーマでのjson-store読み書き、旧を継承）
- `fs-lock.test`（現行のまま再利用可）
- `gsc-normalize.test` → `gsc-query-page-matrix.test`（query+page dimensionへの変更に合わせて改名・改修）
- `site-reader.test`（HttpSiteReaderAdapterのsitemapパース、クロール上限、テキスト抽出、excerpt切り詰め+contentHash算出。fixture HTMLを使う）
- `opportunity-dedupe.test`: 以下を満たすことを検証する
  - 同一 `identity`（`scopeKey`+`intentKey`）のOpportunityは重複作成されない（evidence追記のみ）
  - 同一 `scopeKey` でも `intentKey` が異なれば別Opportunityとして共存する（同一ページに複数Opportunity）
  - `status: 'promoted'` のOpportunityと同一identityの再提示はスキップされ、reportに記載される
  - `status: 'rejected'` のOpportunityは `reopen: true` + 理由が無い限り再浮上しない。理由付きなら `open` に戻り `reopened` イベントが追記される
- `prioritize.test`（[§10.4](#104-prioritize)のbucket 1〜5とtie breakerを固定入力で検証。旧`select-keyword.test`の設計を踏襲するが、position値は判断材料に使わない）
- `experiment-lifecycle.test`: status遷移の許可/禁止、historyのappend-only、**Active experiment guard**（同一opportunityIdに非終端状態のExperimentがある間、新規作成が拒否されること。`--opportunity-id`直接指定でも拒否されること）、`concluded`/`rejected`到達時にOpportunityが自動的に`open`へ戻ること（`released`イベント）
- `measurement-plan.test`: `MeasurementPlan.targetPages`/`targetQueries` にscopeした `before` snapshotが、scope外のページ/クエリを含まないことをfixture rank-historyで検証。`minimumImpressions` 未達時に `insufficient_data` となり `no_effect` と区別されることも検証
- `dry-run.test`（現行の設計を踏襲、対象コマンドを新CLIに合わせる）
- `e2e-fixture.test`（fixtureサイト+fixture GSCデータで `understand -> discover -> prioritize -> propose` が一周し、reportが生成されることを確認。Milestone 1Aの範囲であり `rakusetsu.com` へは一切アクセスしない）

---

## 21. 実装順序（Milestone 1A、Codexが実装時に迷わないための骨子）

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
| 「1 run 1 keyword」 | 「1 discover/propose あたりの提案数上限」+ Active experiment guard | 一般化 |
| Skill (`seo-rank-watch`) | 新Skillへ改名・改修（意味理解/AI担当の分離は維持） | 改修 |
| （新規）`OpportunityIdentity`（`scopeKey`+`intentKey`） | dedupeキー。同一ページの複数Opportunity共存を許容 | 新規 |
| （新規）`MeasurementPlan` | before/afterのscope・primary metric・sufficient-data条件を固定 | 新規 |
| `PageSummary`（title/headings/wordCountのみ） | `PageSnapshot`（+bounded excerpt, contentHash） | 拡張（本文の根拠を保持） |

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
