# seo_tryanderror

AIがSEO改善を自律的に繰り返す仕組み「C」を実装するプロジェクト。

```text
A → B   = ユーザー自身の作業ログを自然な記事にする(別リポジトリ)
C → B   = SEO上必要な記事/改善を自然な記事にする(このリポジトリ)
```

- **A: 作業ログの素材化** — 別リポジトリ(`/kiji`)。このリポジトリは依存しない。
- **B: 自然な日本語生成** — 別プロジェクト。事実を変えず自然な日本語へ変換する。
  未接続の間は `StubNaturalWriterAdapter` で代替する。
- **C: SEO自己改善(このリポジトリ)** — GSCとSERPを基に、何を作る/直すべきか判断し、
  改善→観察→実測→次の改善を回す。

ループの本体は次の1本だけ。

```text
measure -> review due experiments -> choose exactly one keyword ->
analyze search need/SERP gap -> produce one change plan ->
apply via B/site adapters -> validate -> record -> cooldown -> later measure again
```

設計の詳細は [DESIGN.md](./DESIGN.md)、背景は [HANDOFF.md](./HANDOFF.md) を参照。

## Quick start(credential不要)

```bash
npm install
npm test
npm run seo -- run --fixture --date 2026-09-10
npm run seo -- status --fixture --date 2026-09-10
```

`--fixture` は `fixtures/` 配下のサンプルデータ(3キーワード: active / observing /
achieved)を `.tmp/fixture-run/` にコピーして実行する。**git管理下の `fixtures/`
自体は書き換わらない**ので、何度でも安全に試せる。まっさらな状態からやり直したい
場合は `.tmp/` を削除すればよい。

```bash
rm -rf .tmp
```

## Daily operation(実サイト運用)

1. `config/seo.config.example.json` を `config/seo.config.json` にコピーし、
   実サイトの値に書き換える。
2. `data/seo/watchwords.example.json` などを参考に `data/seo/` 配下へ
   実データを作成する(`watchwords.json` / `rank-history.json` /
   `improvement-log.json`)。
3. 通常は `.claude/skills/seo-rank-watch/SKILL.md` に従って
   coding agent(Codex/Claude Code等)が一連の操作を行う。手動で叩く場合は
   次の順。

```bash
# 1. 現状確認
npm run seo -- status --config config/seo.config.json

# 2. GSCから順位を取得して追記
npm run seo -- fetch-ranks --config config/seo.config.json --append

# 3. 改善案(SERP調査結果・plan)を用意した上でrun
npm run seo -- run \
  --config config/seo.config.json \
  --serp-file /path/to/serp.json \
  --plan-file /path/to/plan.json
```

`run` は dry-run にもできる(サイト・状態ファイルへの書き込みなし)。

```bash
npm run seo -- run --config config/seo.config.json --dry-run \
  --serp-file /path/to/serp.json --plan-file /path/to/plan.json
```

GSC以外の順位計測(WebSearchや手動確認)を記録する場合:

```bash
cat ranks.json | npm run seo -- record-ranks --config config/seo.config.json --source websearch
```

`ranks.json` は `RankMeasurement` の配列(`src/core/types.ts` 参照)。
`watchwords.json` に登録されていないkeywordは拒否される。

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

認証情報が未設定のまま `fetch-ranks` を実行すると、exit code `2`
(`GSC_NOT_CONFIGURED`)で明確に止まる。「順位0件」と「未設定」は区別される。

## 実サイトへの接続

`config/seo.config.json` の `adapters.site` を `"filesystem"` にすると、
`FilesystemSiteAdapter`(`src/adapters/site.ts`)が有効になる。
`site.contentRoot` 配下のMarkdownソースを対象とし、`commands.build` /
`commands.test` を実行して検証する。v1では `pathMap` 等のカスタムresolverは
持たない(YAGNI)。HTML生成物を直接編集するようなサイトでは、別途adapterの
拡張が必要。

## B(自然な日本語生成)への接続

`config/seo.config.json` の `adapters.writer` を `"cli"` にすると、
`CliNaturalWriterAdapter`(`src/adapters/natural-writer.ts`)が有効になる。
次の契約に従う任意のコマンドを `SEO_WRITER_COMMAND` 環境変数で指定する。

```text
writer-command --input tmp/request.json --output tmp/response.json
```

入出力の形は `NaturalWriterAdapter`(`src/core/types.ts`)を参照。
Bが未完成の間は `"stub"`(`StubNaturalWriterAdapter`)のままでよい。

## 状態ファイルの意味

| ファイル | 役割 |
| --- | --- |
| `data/seo/watchwords.json` | 監視対象のkeywordと対象ページ |
| `data/seo/rank-history.json` | 順位計測の履歴。**追記専用**、過去entryは変更・削除しない |
| `data/seo/improvement-log.json` | keywordごとの状態(`active` / `observing` / `achieved`)と改善履歴 |
| `data/seo/.run.lock` | 二重実行防止のロック(`.gitignore`済み) |
| `reports/` | 各runのMarkdownレポート(`.gitignore`済み) |

`active` / `observing` / `achieved` の3状態については [HANDOFF.md](./HANDOFF.md)
と [DESIGN.md](./DESIGN.md) を参照。

## Guardrails

- 1 runで新規改善は1 keywordのみ
- `observing` は `nextReviewDate` 前に触らない、`achieved` は監視のみ
- `rank-history.json` は追記専用
- GSC未登録の生クエリを永続化しない(reportの提案としてのみ表示)
- secretをログ・commitに含めない
- 独自Google SERPスクレイパーは作らない
- noindex / canonical / URL の自動変更、大規模構造変更、複数記事一括rewriteは禁止
- 改善効果を予測で断定しない(観測結果のみ報告する)
- 候補がなければ何もしない
- build/test失敗時は状態を進めない(ロールバックする)

詳細は [.claude/skills/seo-rank-watch/SKILL.md](./.claude/skills/seo-rank-watch/SKILL.md)
を参照。

## Troubleshooting

- **`RUN_ALREADY_ACTIVE`**: 別プロセスが実行中、または前回異常終了した
  ロックが残っている。10分以上古いロックは自動的に無効化されるので、
  それ未満であれば少し待つ。手動で消す場合は `data/seo/.run.lock` を削除する。
- **`GSC_NOT_CONFIGURED`**: 上記「GSC setup」を参照。
- **`fetch-ranks` が exit 1**: GSC呼び出し自体は成功したが、
  登録済みwatchwordに一致する計測可能なqueryがなかった。
  keywordの表記(全角/半角・大文字小文字・空白)を確認する。
- **`record-ranks` が "rejected: unregistered watchwords"**: 記録しようとした
  keywordが `watchwords.json` に未登録。先に登録するか、記録対象から除く。
- **dry-runで何も変わらない**: 仕様通り。`--dry-run` を外して実行する。
- **fixtureを試したらリポジトリが汚れた**: 起きない設計だが、もし
  `fixtures/` 配下がgit差分に出たら `git checkout -- fixtures/` で戻し、
  `.tmp/fixture-run/` を使っているか確認する。
