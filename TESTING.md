# Trying it in your own tenant

About 10 minutes. Do this before it ever goes near a customer.

## 1. Pick a throwaway sheet

Any sheet you can freely damage. A sheet that already holds one field of every
type is ideal — the tool copies each new field's layout properties from an
existing field of the same type, and that is the tested path.

Open its item-edit page:

    https://<your-tenant>/esm/<sheet_id>/item-edit?popup=true

## 2. Load the tool

Copy the snippet to your clipboard. **In the Mac Terminal** (not the browser
console — `pbcopy` is a shell command):

    cd ~/Workspace/esm-layout-tool
    pbcopy < esm-layout-tool.js

Then **in the browser**: `F12` → **Console** → paste → `Enter`.
A panel appears top-right. (If Chrome asks, type `allow pasting` first.)

## 3. Paste the spec

**In the Terminal:**

    pbcopy < sample-spec.tsv

Then **in the browser**, paste into the panel's text box and press **解析**.

Expect: `形式の判定: タブ区切り / 1列目=項目名 2列目=項目タイプ` and
`14 行を解析しました`.

The sample is deliberately in your Excel's column order (型 first). Try the
reverse order too — swap the two columns and re-paste; it should still say
`14 行を解析しました` with the columns detected the other way round.

### Then the shape a real onboarding sheet actually has

    pbcopy < sample-onboarding.tsv

This one has a header row, a mostly-empty `No.` column, `※システム項目` rows, a
choice list continued on a second row, and `※` remarks. Press **解析** and check:

- `1列目=項目名 2列目=項目タイプ 3列目=紐づけ先 4列目=選択肢` — read from the
  header, not from position.
- `2 行は対象外/備考` naming the two システム項目 rows, plus the two remarks it
  will not act on (`※備考欄：氏名` and `赤系の見やすい色で`).
- No item named `1`, `2`, `3`… — that is what happens if the `No.` column is
  mistaken for the label column.

Then **ドライラン**. 確認済証交付者 should carry all five choices even though the
last two were on the following row, and 確認番号 / 建物面積・延床面積 /
確認年月日 should have picked up their unit, decimal places and today-default
from the `※` cells.

## 4. Run

Paste the spec and press one of the two run buttons. Both capture the template
(by pressing eSM's own 保存 button once — a no-op save, no junk item), parse,
plan, show you what they will add, and ask for confirmation before writing.

- **一括で実行** — one transaction. All the fields land or none do.
- **1件ずつ実行** — one transaction per field, failures skipped, and a per-type
  OK/NG report at the end. Slower, but a rejected field no longer takes the
  batch with it. Use this on a sheet type you have not run against before.

To inspect first without any chance of writing, use the 個別操作 section and
press **ドライラン** on its own. You get a table of the 14 items with their generated keys,
and a warning naming any ⚠未検証 type in the plan.

Nothing has been sent yet. Inspect the exact payload if you want — **in the browser console**:

    window.__eltPayload

**Start narrow.** For the first real run, cut the spec down to 2 rows —
one テキスト and one プルダウン, the two verified types — and apply those alone.
Confirm they appear correctly, then come back and run the full 14.

### 紐づけ項目 — read this before running one

This is the only thing that writes to a sheet other than the one on screen.

The sample spec's 紐付け rows point at `業者` and `建物形状`. **On your own
tenant those sheets do not exist**, so the dry run will skip them with
`紐づけ先「業者」がこのシートの既存の紐づけ項目に見つかりません` — that refusal
is itself worth seeing, because it is what protects a customer sheet from a
typo'd target name.

To exercise the path properly:

1. On your test sheet, add **one** 紐づけ項目 by hand through eSM's UI, pointing
   at any other sheet. Save.
2. Reload the item-edit page and load the tool again.
3. Paste a two-row spec whose 紐づけ先レコード column holds the same target,
   written the way a user names it (e.g. `顧客`, not `customer`).
4. **ドライラン**, and read the block that starts `── 紐づけ項目 ──`. It names
   the target sheet and how many reverse fields will be created there.
5. Apply with **1件ずつ実行**, then open the *target* sheet's item-edit page and
   confirm the reverse fields are there, named `<項目名>（<このシート>）`, and
   that nothing else on that sheet moved.

Step 5 is the one that matters. The tool diffs the target's layout before
sending and refuses to write if any existing entry changed, but a human looking
at the other sheet is the check that catches what a diff cannot describe.

### What the apply does

On confirmation the tool will:

1. download `esm-layout-before-*.json` (your rollback — keep it),
2. run the same optimistic-lock check the UI runs, and abort if the sheet changed,
3. `doBegin` → `PUT` → `doCommit`,
4. copy a result report to your clipboard.

## 5. Verify

Reload the item-edit page. The new items should be at the **bottom** of the
layout in spec order. Check specifically:

- ステータス / 優先度 / 対応チャネル show their choices, and 対応チャネル allows
  multiple selection while 優先度 is radio and ステータス is a dropdown
- 担当者名 and 開催日 are marked 必須
- each field's 設定 dialog opens without error
- open a **record** on that sheet and confirm the fields accept input and save

That last one matters most: it is what proves the server accepted our
`itemTypeDef` for the 12 inferred types, not just that the layout screen renders.

## 6. Check the failure paths

Worth five more minutes, because these are what the operator will hit:

- **Consecutive batches** — right after a successful run, paste the next rows
  and run again without reloading. It should work straight through; the
  tool rolls its baseline forward using the payload it just sent.
- **Duplicates** — re-paste the same spec and apply again. Everything should be
  skipped, nothing added.
- **Unsupported types** — `pbcopy < sample-unsupported.tsv` in the Terminal, paste it in. All three rows should
  be rejected with an explanation and nothing sent.
- **Concurrent edit** — open the same sheet in a second tab, save a change there,
  then apply in the first. It should abort with
  「他の人がこのシートを更新しています」.

## What to tell me afterwards

- whether 見出し was accepted — it is the last type with no confirmed create
- for a 紐づけ項目 run: what the target sheet looked like afterwards, and whether
  the reverse field's name and position were what eSM produces by hand
- the HTTP status and body of any failure (the log panel shows both)

That closes out the type table. The remaining gaps after that are tab placement,
which needs a sheet with 2+ custom tabs, and 演算 / 紐づけ参照, which need a
capture of each being created.
