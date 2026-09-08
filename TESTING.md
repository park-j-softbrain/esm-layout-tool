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

Expect: `列の判定: 1列目=型 / 2列目=項目名` and `14 行を解析しました`.

The sample is deliberately in your Excel's column order (型 first). Try the
reverse order too — swap the two columns and re-paste; it should still say
`14 行を解析しました` with the columns detected the other way round.

## 4. Run

Paste the spec, press **実行**, and the tool captures its template (by pressing
eSM's own 保存 button once — a no-op save, no junk item), parses, plans, shows
you what it will add, and asks for confirmation before writing.

To inspect first without any chance of writing, use the 個別操作 section and
press **ドライラン** on its own. You get a table of the 14 items with their generated keys,
and a warning that 12 of the 14 types are ⚠未検証 (only テキスト and プルダウン
have a create payload confirmed against a real save).

Nothing has been sent yet. Inspect the exact payload if you want — **in the browser console**:

    window.__eltPayload

**Start narrow.** For the first real run, cut the spec down to 2 rows —
one テキスト and one プルダウン, the two verified types — and apply those alone.
Confirm they appear correctly, then come back and run the full 14.

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
  and press 実行 again without reloading. It should work straight through; the
  tool rolls its baseline forward using the payload it just sent.
- **Duplicates** — re-paste the same spec and apply again. Everything should be
  skipped, nothing added.
- **Unsupported types** — `pbcopy < sample-unsupported.tsv` in the Terminal, paste it in. All three rows should
  be rejected with an explanation and nothing sent.
- **Concurrent edit** — open the same sheet in a second tab, save a change there,
  then apply in the first. It should abort with
  「他の人がこのシートを更新しています」.

## What to tell me afterwards

- which of the 12 ⚠ types were accepted, and which the server rejected
- the HTTP status and body of any failure (the log panel shows both)
- whether `/transaction/doRollback` exists (the log says if it 404s)

That closes out the type table. The remaining gap after that is tab placement,
which needs a sheet with 2+ custom tabs.
