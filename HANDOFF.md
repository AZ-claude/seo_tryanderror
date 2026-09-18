# Handoff — seo_tryanderror

最終更新: 2026-09-18

## 1. このPJの目的（更新版）

`seo_tryanderror`（C）は、**テーマまたは既存サイトを与えると、検索市場・サイト・保有データを理解し、
Opportunityを発見し、仮説を立て、コンテンツの新規作成または改善を行い、公開後の実測結果から学習しながら
サイトそのものを育てていく自律サイト育成エンジン**である。

旧HANDOFF（2026-09-10版）では「SEO Rank Watchの1キーワード改善ループをそのまま模倣する」ことを目指していたが、
本セッションでその前提を見直した。詳細は [DESIGN.md](DESIGN.md) を参照。ここでは**なぜ変えたか・何を残したか・
最初の実運用をどう行うか**を人間向けに説明する。

責務分担（A/B/Cの3分離）はそのまま維持する。

- **A: 作業ログの素材化** — 既存 `/kiji` が担当。CはAに依存しない
- **B: 自然な日本語生成** — 別PJ（`seo_japanese`）。事実を変えず自然な日本語へ変換するだけ
- **C: サイト育成の意思決定** — この `seo_tryanderror` が担当

---

## 2. なぜ設計を変えたか

### 2.1 旧設計の前提が狭すぎた

旧設計は「SEO Rank Watch」という公開実装（`daichi-ikeda-170329/study-route-compendium`）の
`measure -> 1 keyword選択 -> gap分析 -> 1箇所改善 -> 7日観察 -> 順位判定` ループをほぼそのまま模倣していた。
これは動くものとしては優れているが、以下の前提を暗黙に置いていた。

- **主語がkeyword**: 「どのキーワードで何位か」から出発する。しかし実際にサイトを育てる際、最初にあるのは
  「このキーワードで上位を取りたい」という意思ではなく、「このサイトにはこういう需要／データ／強みがある」
  という発見であるべき。キーワードは発見の**結果**であって**出発点**ではない。
- **主語がユーザー指定のkeyword前提**: ユーザーが最初にキーワードを決める運用を想定していなかったわけではないが、
  Cが自律的に「何を試すべきか」を発見する部分が弱かった。今回のゴールでは、Cが既存サイトを自分で読んで
  Opportunityを見つけるところまでを主機能にする。
- **改善単位が`1 keyword`固定**: 実際には「1ページ × 1検索意図クラスタ × 1仮説」という単位のほうが、
  複数クエリが1ページに集約される実態（GSCのquery×page行列を見れば分かる）に合う。
- **ゴールが「1位達成」**: 順位はdiagnostic signalの一つに過ぎない。impressions/clicks/CTR/organic sessions/
  conversion/AI検索での可視性まで含めた成果指標へ広げられる設計にしておく必要がある。
- **Actionが「REVISE」固定**: 将来的にCREATE（新規作成）/LINK（内部リンク）/MERGE/SPLIT/RETIREまで扱える
  必要がある。全部をv1で自動化する必要はないが、型として拡張可能にしておく。
- **本番への自動書き込みを前提にしていた**: `SiteAdapter.apply()` が最初から書き込み系だった。しかし
  最初の実運用対象 `rakusetsu.com` は別リポジトリ・別ホストであり、このPJからは**読むことしかできない/
  すべきでない**。read-onlyのフェーズを明示的に切り出す必要があった。

### 2.2 何が変わったか（要約）

- 主語を `keyword` から `Opportunity` / `Hypothesis` へ変更した
- 改善単位を `1 keyword` から `page × search intent cluster × hypothesis` へ変更した
- ワークフローを `measure -> select -> plan -> apply -> observe` から
  `READ -> UNDERSTAND -> DISCOVER -> PRIORITIZE -> PROPOSE`（v1はここまで）へ変更し、
  `apply -> PR -> test -> review -> publish` を明確に後続フェーズとして切り離した
- Existing Site Mode（rakusetsu.com起点）とBootstrap Mode（theme起点）という2つの利用形態を定義した
- Experiment（旧: ImprovementKeywordState + ImprovementAction）を「このサイトで何が効いたか」を
  学習するためのExperiment Memoryとして明確に位置づけた

---

## 3. 何を残したか

現行実装の中で**良い部分は捨てていない**。以下はDESIGN.md上でも「ほぼそのまま再利用」と明記した。

- GSC adapterの認証部分（Service Account JWT、`searchAnalytics/query`呼び出し）
- json-storeのatomic write（temp file + rename）
- fs-lockによる二重実行防止
- append-onlyの強制パターン（`rank-history.json`、および新設する`opportunities.json`/`experiments.json`の`history[]`）
- dry-runの設計（読み取りはしてよいが永続ファイル・サイトへの書き込みをしない）
- transaction semantics（build/test失敗時にstateを進めない、失敗を成功扱いにしない）
- `insufficient_data` を「効果なし」と混同しない判定方針
- fixtureのみでE2Eを完結させるテスト方針
- provider非依存のadapter構造（GSC/Search/Writer/Siteをinterfaceで切る設計）
- 破壊的変更（noindex/canonical/URL/大規模IA変更）を自動実行しないガードレール
- Bとのinterface契約（`NaturalWriterAdapter.transform`）は完全に無変更

なぜ残したか: これらは「キーワード中心か機会中心か」というドメインモデルの選択とは独立した、
**安全性と再現性のためのインフラ**だからである。ドメインが変わっても価値は変わらない。

---

## 4. 最初の実運用をどう行うか

### 4.1 対象

`rakusetsu.com`。ただし**このセッション・このリポジトリの範囲では `rakusetsu.com` にも他repoにも一切変更を加えない**。
実装が進んでもMilestone 1はread-onlyのみ。

### 4.2 最初のマイルストーン（Milestone 1、1A/1Bの2段階）

「fixtureのテストが通ること」と「`rakusetsu.com` で実際に役立つこと」は別の問いである。この2つを混同しないよう、
Milestone 1を明示的に2段階へ分けた（DESIGN.md §19）。

**Milestone 1A — Implementation qualification（coding agentのDefinition of Done）**

`rakusetsu.com` や実GSCには一切アクセスせず、fixtureデータのみで
`understand -> discover -> prioritize -> propose`（DESIGN.md §10, §17）の一連の型・ロジック・安全機構
（identity単位のOpportunity dedupe、active experiment guard、MeasurementPlanに基づくbefore/after算出等）
を実装・テストする。実装agentが承認待ちせず完了させるのはここまで。

**Milestone 1B — rakusetsu.com live read-only validation（明示的に許可された後にのみ実行）**

1Aの完了後、ユーザーが明示的に許可したタイミングでのみ実行する運用検証。

1. `seo understand` — `rakusetsu.com` を読み取り専用（HTTP経由、sitemap + 浅いクロール）で読み、
   GSCが設定されていればクエリ×ページ行列も取得し、`site-understanding.json` を作る
2. `seo discover` — そこからOpportunity候補をAI（Skill）が構造化JSONとして生成し、CLIが検証・保存する
3. `seo prioritize` — 優先順位付け
4. `seo propose` — 1件のExperiment（提案）を生成し、Markdown reportを出す

ここで初めて「Cが自力で筋の良いOpportunityと施策案を出せるか」を人間が評価する。PRの作成やサイトへの実適用
（apply mode）は行わない。この評価結果を見てから、Milestone 2（apply mode、PR作成、B接続）へ進むかどうかを判断する。

### 4.3 GSCアクセスについて

`rakusetsu.com` のGSCプロパティ所有権・Service Account credentialの設定はこのセッションの範囲外。
DESIGN.md §7 (旧DESIGN §28相当) のとおり、これは「外部依存の値」としてcore実装の完了をブロックしない。
GSC未設定でも `understand` は失敗せず、`GSC_NOT_CONFIGURED` を明示して他の処理を続行する。

---

## 5. Bootstrap Modeとの関係

将来、新規サブドメイン等で「ページ0・GSCデータ0」から育てるBootstrap Modeを使う想定がある。
DESIGN.md §18 に設計は書いたが、**V1では実装しない**。`discover` コマンドがtheme起点の入力を
受け付けられる設計フックだけ用意しておき、実際のmarket/SERP research自動化・初期ページ自動生成は
後続milestoneに委ねる。理由: Existing Site Modeで「Cが自力で筋の良い判断をできるか」を先に検証しないと、
Bootstrap Modeの自動化に投資する価値があるか判断できないため。

---

## 6. Codex/Claude運用方針

実装agentには、`DESIGN.md` を正本として最後まで実装させる。途中で儀式的な承認待ちは入れない。

止まってよいのは次のみ。

- `rakusetsu.com` や他repoへの書き込みが必要になったとき（Milestone 1では発生しないはず）
- secret不足（GSC credential等）
- GSC所有権・認証にユーザー操作が必要なとき
- B側インターフェースが存在せず実運用統合が不可能なとき（Milestone 1では未使用のため通常発生しない）

それ以外はfixture/stub/dry-runで進め、実装・test・commitまで完了する。

---

## 7. Definition of Done

### 7.1 Milestone 1A（coding agent）

DESIGN.md §19.1 Acceptance Criteria を正とする。要約:

- fixtureだけで `understand -> discover -> prioritize -> propose` が一周できる
- サイトへの書き込みが一切発生しない（read-onlyアダプタのみ使用）
- GSC credentialなしでも `not_configured` を明確にして進める
- Opportunityのdedupeが `identity`（`scopeKey`+`intentKey`）単位で行われ、同一ページに複数Opportunityが共存できる
- 同一Opportunityに未終結のExperimentがある間、新規Experimentを作れない（active experiment guard）
- `MeasurementPlan` に基づき `before`/`after` が正しいscopeで算出され、データ不足は `no_effect` と混同されない
- `history[]` のappend-only性が保証される
- dry-runでファイルを書き換えない
- reportを生成する
- READMEだけでセットアップと運用が分かる

### 7.2 Milestone 1B（ユーザー明示許可後）

DESIGN.md §19.2 を正とする。`rakusetsu.com` への実アクセスで、上記が実サイトに対しても機能し、かつサイト・
リポジトリ・本番環境へのmutationが0件であることを確認する。ここで生成された初回proposalの品質を人間がレビューし、
Milestone 2（apply mode: B接続、PR作成、REVISE実行）へ進むかどうかを判断する。
