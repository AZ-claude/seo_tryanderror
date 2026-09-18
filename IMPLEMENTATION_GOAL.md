# IMPLEMENTATION_GOAL — seo_tryanderror Milestone 1

最終更新: 2026-09-18
対象: 実装を開始するcoding agent（Codex/Claude等）

## これは何か

このドキュメントは、`DESIGN.md`（正本）と `HANDOFF.md`（背景説明）を読んだ実装agentに渡す、
Milestone 1のための短い着手用ゴール文書。**このドキュメント自体は仕様の詳細を持たない**。
迷ったら必ず `DESIGN.md` → `HANDOFF.md` → YAGNI → fixture/stubで前進、の順で解決すること。

## Milestone 1のゴール（1文で）

`rakusetsu.com` を read-only で理解し、Opportunityを発見し、優先順位をつけ、次に試す施策を
`Experiment(status: proposed)` として提案・reportできる状態を、fixtureデータで再現可能な形で実装する。

## やること

1. `DESIGN.md` §6-§7 のドメイン型・persistenceで `src/core/types.ts`/`src/core/schemas.ts` を全面書き換える
2. `DESIGN.md` §21 の Phase 1〜6 の順に実装する
3. 既存コード（`src/infra/*`, GSC認証部分, dry-run/lock/atomic writeパターン, adapterのinterface構造）は
   `DESIGN.md` §22（対応表）に従って再利用できるものは再利用し、ゼロから書き直さない
4. `.claude/skills/seo-rank-watch/` は新ワークフロー（`understand -> discover -> prioritize -> propose`）
   に合わせて改修する（起動条件の文言・手順を更新。ガードレールの精神は維持）
5. README.mdを新CLIコマンド・新データモデルに合わせて更新する

## やらないこと（Milestone 1で明確にスコープ外）

- サイトへの書き込み（`SiteWriterAdapter`、apply mode、REVISE実行）
- B（`NaturalWriterAdapter`）の実呼び出し（契約・stubは用意するが呼び出し箇所は作らない）
- PR作成・publish
- Bootstrap Modeの自動化（`discover`がtheme入力を受け付ける設計フックのみ）
- `rakusetsu.com` や他repoへの実際のアクセス（credential/URLは環境変数・configで注入できる形にし、
  実際の接続確認はこのagentの作業範囲外。fixtureで完結させる）

## Definition of Done

`DESIGN.md` §19 Acceptance Criteria を全て満たすこと。特に:

- `npm install && npm test && npm run build` が通る
- `npm run seo -- understand --fixture --date <date>` から
  `discover -> prioritize -> propose` までがfixtureデータで一周し、reportが生成される
- サイトへの書き込みコードパスがMilestone 1のコマンドから到達不可能であること（型レベルで
  `SiteReaderAdapter` にwriteメソッドが無いことで担保する）

## 止まってよい場面

- 本番サイト・他repoへの書き込みが必要に見えたとき（発生しないはず。発生したら設計解釈が誤っている可能性が高いので止まる）
- secret不足
- GSC所有権・認証にユーザー操作が必要なとき

それ以外は止まらず実装・テスト・コミットまで完了させる。

## 実装完了時の報告フォーマット

```text
STATUS: COMPLETE | BLOCKED
HEAD: <sha>

Implemented:
- ...

Tests:
- npm test: PASS/FAIL
- npm run build: PASS/FAIL
- fixture E2E (understand->discover->prioritize->propose): PASS/FAIL

External setup remaining:
- GSC credential for rakusetsu.com: ...
- rakusetsu.com base URL / crawl config: ...

Known limitations:
- ...
```
