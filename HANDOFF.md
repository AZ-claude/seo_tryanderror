# Handoff — seo_tryanderror

最終更新: 2026-09-10

## 1. このPJの目的

このリポジトリ `seo_tryanderror` は、**AIがSEO改善を自律的に繰り返す仕組み（C）**を独立して実装するためのPJである。

既存 `/kiji` をそのまま拡張するのではなく、責務を次の3つに分離する方針を採る。

- **A: 作業ログの素材化** — 既存 `/kiji` が担当。ユーザーの作業ログを取得・要約・整理し、記事化可能な素材にするところまで。
- **B: 自然な日本語生成** — 別PJ。AまたはCから与えられた素材・要件を、事実を変えず自然な日本語へ変換する。
- **C: SEO自己改善** — この `seo_tryanderror` が担当。GSCとSERPを基に、何を作る/直すべきか判断し、改善→観察→実測→次の改善を回す。

運用形は2系統。

```text
A → B   = ユーザー自身の作業ログを自然な記事にする
C → B   = SEO上必要な記事/改善を自然な記事にする
```

AとCは直接依存しない。Bは共通の文章生成部品として扱う。

---

## 2. このセッションで得た結論

### 2.1 最重要の設計判断

SEO改善ループは新規発明しない。

2026-09-09のX投稿で公開された `SEO Rank Watch` の考え方を、**仕様としてほぼそのまま模倣する**。

核となるループはこれ。

```text
測定
↓
1位に近いキーワードを1つ選ぶ
↓
検索意図と上位ページを調べる
↓
検索ニーズに対する不足を1つ特定
↓
必要最小限の改善を1つ実施
↓
観察状態にする
↓
7日以上待つ
↓
GSCの実測値で評価
↓
未達なら別の仮説で再挑戦
```

「大量に改善する」「SEO用に文字数を増やす」「同じ語を連日いじる」は行わない。

### 2.2 公開実装から分かったこと

X投稿とほぼ同じ構成を、公開GitHubリポジトリ `daichi-ikeda-170329/study-route-compendium` が再現している。

そこでは以下が実装されている。

```text
.claude/skills/seo-rank-watch/
  SKILL.md
  scripts/
    status.mjs
    fetch_gsc_ranks.mjs
    record_ranks.mjs

data/seo/
  watchwords.json
  rank-history.json
  improvement-log.json
```

重要点:

- `active / observing / achieved` の3状態
- `observing` は `nextReviewDate` まで再改善禁止
- GSCを正とする
- WebSearchは補助
- `rank-history.json` は追記専用
- 同日・同sourceの重複測定を拒否
- 1回1キーワード
- 対象がなければ何もしない
- GSC未登録の有望クエリは候補表示する
- 検索意図分析→上位1〜3件比較→gap特定を必須化
- 改善理由と実施内容を履歴化
- noindexや大規模構造変更は勝手に行わない

この設計の特徴は、**状態管理・履歴・再実行制御は決定論的コード、意味理解と改善仮説はAI**に分けていること。

これはそのまま採用する。

---

## 3. ありもので出来る部分 / ここで実装すべき部分

### 3.1 ありもので出来る部分

以下は独自開発しない。

#### Google Search Console

使用用途:

- query別の平均掲載順位
- impressions
- clicks
- 期間別比較

Google Search Console APIを使用する。

既知の実装パターン:

- service account
- `webmasters.readonly`
- `searchAnalytics/query`
- `dimensions: ['query']`
- `dataState: 'final'`
- 日次データは遅延を考慮

#### Web検索

使用用途:

- 現在の上位1〜3ページの確認
- 検索意図推定
- GSC未利用時の順位概算
- GSCで `rank:null` の補助確認

Google SERPを独自スクレイパーでクロールしない。

#### Git

使用用途:

- SEO状態ファイルの永続化
- 改善差分の記録
- rollback可能性
- AI間の引継ぎ

専用DBはv1では不要。

#### Codex / Claude Code等のcoding agent

使用用途:

- 対象サイトのコード/コンテンツを読む
- SERP調査結果をもとに改善する
- test/buildを実行する
- SEO状態ファイルを更新する
- commitする

v1で専用オーケストレータは作らない。

### 3.2 このPJで実装する部分

Cとして以下だけを実装する。

1. SEO Skill本体
2. GSC取得スクリプト
3. 状態表示スクリプト
4. WebSearch/manual順位記録スクリプト
5. SEO状態JSON schema
6. 改善選定ルール
7. review判定ルール
8. 対象サイトとのadapter契約
9. B（自然日本語生成）とのadapter契約
10. test fixture
11. dry-run
12. 実行レポート

---

## 4. Cの責務

Cは「文章を書くPJ」ではない。

Cの仕事は次だけ。

- GSCから現状を測る
- 改善候補を優先順位付けする
- 1キーワードを選ぶ
- 検索ニーズを定義する
- 競合との差を特定する
- 何を変更すべきか仕様化する
- Bに文章生成/改稿を依頼する
- サイトに反映する
- build/testする
- 改善ログを残す
- 観察期間終了後に結果を判定する

Cは自然な日本語そのものを研究しない。

Bが未完成の間は、B adapterをstub/CLI契約で用意しておく。

---

## 5. A/B/Cの境界

### Aの出力

Aは記事素材を作る。

例:

```json
{
  "sourceType": "work_log",
  "facts": [],
  "timeline": [],
  "decisions": [],
  "lessons": [],
  "rawEvidence": []
}
```

CはAに依存しない。

### Bの入力

Bは自然な文章への変換だけを行う。

CからBへの最低限の契約:

```json
{
  "mode": "create|revise",
  "targetLanguage": "ja",
  "contentType": "article",
  "existingText": "optional",
  "searchNeed": "string",
  "requiredFacts": [],
  "requiredChanges": [],
  "forbiddenChanges": [],
  "targetKeyword": "string"
}
```

Bの出力:

```json
{
  "text": "...",
  "preservedFacts": [],
  "warnings": []
}
```

Bは順位・CTR・検索ボリューム・競合順位を見ない。

### Cの出力

Cはサイト反映可能な改善仕様と履歴を持つ。

---

## 6. Rank Watchの状態モデル

### watchwords.json

監視するキーワードと対象ページ。

```json
{
  "schemaVersion": 1,
  "site": "https://example.com",
  "gscProperty": "sc-domain:example.com",
  "keywords": [
    {
      "keyword": "example keyword",
      "targetPath": "/example/",
      "priority": "high"
    }
  ]
}
```

### rank-history.json

追記専用。

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "date": "2026-09-10",
      "source": "gsc",
      "window": {
        "start": "2026-08-11",
        "end": "2026-09-07",
        "days": 28
      },
      "measurements": [
        {
          "keyword": "example keyword",
          "rank": 4.2,
          "impressions": 500,
          "clicks": 45
        }
      ]
    }
  ]
}
```

### improvement-log.json

```json
{
  "schemaVersion": 1,
  "keywords": [
    {
      "keyword": "example keyword",
      "targetPath": "/example/",
      "status": "observing",
      "nextReviewDate": "2026-09-17",
      "actions": [
        {
          "date": "2026-09-10",
          "rankAtAction": 4.2,
          "rankSource": "gsc",
          "searchNeed": "誰が何を知りたいか",
          "gap": ["不足点"],
          "done": "実際に行った変更",
          "changeType": "title|intro|faq|content|internal_link|data|other",
          "sources": []
        }
      ]
    }
  ]
}
```

status:

- `active`: 改善候補
- `observing`: 改善済み・観察中
- `achieved`: 1位達成、監視のみ

---

## 7. キーワード選定ルール

1回につき必ず1つ。

優先順位:

1. 2〜10位 + impressionsあり
2. 11〜20位 + impressions多い
3. 過去改善済みだが1位未達
4. 高priorityのrank:null
5. GSCで見つかった有望未登録query

除外:

- observing
- achieved
- review期限未到来

候補がなければ終了。

「改善するために改善対象を捏造する」ことは禁止。

---

## 8. 改善前にAIが必ず行う分析

対象を決めたら次を必須化。

1. 「誰が・何を知りたくて検索しているか」を1〜2文で書く
2. 現在のSERP上位1〜3ページを確認
3. 対象ページと比較
4. 検索ニーズに対する不足をgapとして特定
5. 変更はgapを埋める最低限にする

文章量を増やすこと自体を目的にしない。

---

## 9. 改善可能な範囲

自動適用してよい候補:

- title
- meta description
- intro
- FAQ
- 不足セクション
- 内部リンク
- 実データ/一次情報の補足
- 見出し表現

自動適用禁止:

- noindex変更
- canonical変更
- URL変更
- 大規模IA変更
- 大量削除
- 全記事一括変更
- ドメイン設定変更

これらはproposalのみ。

---

## 10. 観察と効果判定

投稿仕様では改善から7日観察。

ただしGSC finalデータは通常遅延するため、実装上は次の2値を分ける。

- `cooldownDays = 7`
- `reviewDataLagDays = 3`

再改善禁止は7日。

効果判定は「改善後の7日分のfinalデータが十分揃った時点」を推奨。

v1では設定値化する。

結果:

- 1位 → achieved
- 改善あり・1位未達 → active
- 効果なし/悪化 → active + 次回は異なるchangeTypeを優先

未来の順位を予測で断定しない。

---

## 11. v1で作らないもの

YAGNI。

以下は作らない。

- 専用Web管理画面
- 専用DB
- ベクトルDB
- 複雑なmulti-agent orchestration
- 独自SERP scraper
- SEOスコア独自算出エンジン
- 自動被リンク営業
- LLM fine-tuning
- 強化学習
- Aとの統合
- B本体

必要になってから追加する。

---

## 12. Codex運用方針

Codexには、このリポジトリの `DESIGN.md` を正本として最後まで実装させる。

途中で儀式的な承認待ちは入れない。

止まってよいのは次のみ。

- 本番サイトへの不可逆変更
- secret不足
- GSC所有権/認証のユーザー操作が必要
- B側インターフェースが存在せず実site統合不能

それ以外はfixture/stub/dry-runで進め、実装・test・commitまで完了する。

---

## 13. Definition of Done

C単体v1完了条件:

- fixtureだけで一周できる
- GSC credentialなしでも明確に `not_configured` で止まれる
- GSC adapterを実環境で差し替え可能
- 1キーワードだけ選ばれる
- observingを触らない
- rank historyを上書きしない
- review期限を正しく判定できる
- searchNeed/gap/change planを構造化できる
- B adapterがstubで動く
- site adapterがfixtureで変更を適用できる
- build/test失敗時に改善ログをobservingへ進めない
- successful runのみ改善ログを記録
- dry-runではファイルを書き換えない
- reportを生成する
- READMEだけでセットアップと運用が分かる

この状態で、B完成後にadapterを差し替えればBC運用へ進める。
