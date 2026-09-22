---
name: seo-multi-site-loop
description: >
  複数サイトぶんの `seo-growth-loop` を直列に1回ずつ実行し、最後にサイト別の
  統合reportを出す薄いwrapper。新しい状態管理・並行実行・orchestrator機構は
  持たない(state/lock/Experiment上限/reports/learningの分離は既存の
  site.keyベースのcore実装がそのまま担う)。
  「両方のPDCA回して」「全サイトのデイリーサイクル」「rakusetsu-mainと
  pokecaのPDCA」と言われたら起動する。site名を1つだけ指定された場合は
  このSkillではなく `seo-growth-loop` を直接使う。
---

# seo-multi-site-loop

`seo-growth-loop`(特定1サイトの1 daily cycle)を、対象サイトの数だけ
**直列に** 呼び出すだけのSkill。それ以上のことはしない——大きな
orchestratorやスケジューラは作らない。

## 起動条件

- 両方のPDCA回して / 全サイトのデイリーサイクル / 全部のPDCA / rakusetsu-main
  とpokecaのPDCA、のように複数site(または「全部」)を指す依頼。
- site名を1つだけ指定された依頼はこのSkillの対象外(`seo-growth-loop` を
  直接使う)。

## 対象siteの決定

`config/*.config.json` を実際に列挙し、`site.key` を持つ既知の実サイトすべて
を対象にする(2026-09時点で `rakusetsu-main`/`pokeca` の2つ。増減があれば
実ファイルに従う——このSkillに件数をハードコードしない)。ユーザーが
「rakusetsu-mainとpokecaのPDCA」のように対象を明示した場合はその集合だけを
対象にする。

## 手順

**直列実行。同時プロセス起動はしない。** 1サイトぶんの `seo-growth-loop` が
完全に終わってから次のサイトへ進む(lockの取り合いを避けるためではなく
——state/lockはsite.keyで既に分離されているので同時実行しても技術的には
安全——単純に、複数siteを並行で追うと人間のレビュー・判断の質が落ちるため)。

1. 対象siteの1つ目について、`seo-growth-loop`(`.claude/skills/seo-growth-loop/
   SKILL.md`)の手順をそのconfigPathで最初から最後まで実行する。
2. 1つ目が終わったら(正常終了でも、no-opでも、途中で打ち切りでも)、
   2つ目のsiteについて同じことを行う。
   - **1つ目のsiteで失敗(test/build/independent review不通過、apply失敗等)
     があっても、2つ目のsiteの安全なread専用処理(status/understand --dry-run
     /review --dump-inputs等)まで止める必要はない。** ただし、失敗した
     site側では、その日の新規applyを続行しない(`seo-growth-loop`の
     「6. 安全に新しいExperimentを開始できるか確認」の基準に従って、
     そのsiteはreview/discover/prioritizeまでで打ち切ってよい)。
   - 1サイトの失敗を理由に、もう片方のsiteの処理自体をスキップしない。
3. 全site終わったら、最後に統合reportをまとめる(下記フォーマット)。

サイト数が3つ以上に増えても、この手順(直列に回して最後にまとめる)は
そのまま変わらない前提で書いている——サイトごとの分岐ロジックを増やさない。

## 統合report フォーマット

サイトごとに分けて書く。stateを混ぜない(数値・Experiment ID等を他サイトと
合算・混同しない)。

```
## <site.key 1>
- active: <active Experiment数>/<maxActiveExperiments>
- reviews: <このcycleで行ったcheckpoint reviewの要約、無ければ「なし」>
- new opportunity: <discoverで新規作成したOpportunity、無ければ「なし」>
- apply: <proposeからapplyまで進んだExperiment、無ければ「なし」>
- result: <このsiteの今日の結論を一文で>

## <site.key 2>
- active: ...
- reviews: ...
- new opportunity: ...
- apply: ...
- result: ...
```

## Guardrails

- このSkill自身は `npm run seo -- ...` を直接呼ばない。すべて
  `seo-growth-loop` に委譲する(ロジックの二重実装をしない)。
- 対象site数・site一覧をこのSkillのコードやテキストに決め打ちしない。
  `config/*.config.json` を都度確認する。
- 1サイトの失敗が他サイトの安全なread専用処理をブロックしてはいけないが、
  失敗したサイトで新規applyを無理に続行してもいけない。
- schedulerへの自動登録はまだ行わない。手動/Claude起動でのみ動く。
