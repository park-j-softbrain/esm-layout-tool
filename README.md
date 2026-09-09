# esm-layout-tool

Bulk-adds items (項目) to an eSM sheet layout from a spec pasted out of Excel.

Built for onboarding setup work that has to be performed inside a customer's
environment over AdminOne, where nothing can be installed. It is therefore a
**single DevTools console snippet** — paste `esm-layout-tool.js` into the
console on the sheet's item-edit page. No extension, no Node, no file transfer;
identical behaviour on Windows and macOS.

## How it works

The tool does **not** synthesise the save request. It hooks XHR/fetch, waits for
the operator to save one item through the real UI, and keeps that
`PUT /sheet-fs/v1/design/layout/{sheetId}/part` as its template. It then swaps in
the generated `itemDefs` and re-sends within a fresh transaction.

Everything outside the item maps — auth headers, `x-esm-tenantid`,
`initialSheetAuthority`, `adminSettings`, the layout skeleton — is passed through
byte-for-byte. That is what removes the guesswork: the parts we don't understand
are never authored, only carried.

    POST /transaction/doBegin
    PUT  /design/layout/{sheetId}/part     ← template with our itemDefs merged in
    POST /transaction/doCommit

`GET /sheetdef/state/{sheetId}` + `POST /sheetdef/state/isUpdated` run first as
the same optimistic-lock check the UI performs; the tool aborts if someone else
has touched the sheet.

## Creating an item

Adding a field is one entry in `sheetDefs[0].itemDefs` with `itemId: null`. The
server assigns `itemId`, `columnName`, `entityName` and `sheetId` afterwards.
`/part` is a partial update — only new/changed defs are sent — while the two
layout maps under `tenantLayout` are full and must be read-modify-written.

## Spec format

Tab-separated, straight out of Excel. **Paste the header row too** — the columns
are located by name, so their order does not matter and unknown columns are
ignored.

| No. | 項目名 | 項目タイプ | 紐づけ先レコード | 選択肢 | | |
|---|---|---|---|---|---|---|
| 1 | 物件　情報 | 見出し | | | | |
| 2 | 依頼書ID | ※システム項目 | | | | |
| 3 | 物件名 | テキスト | | ※備考欄：氏名 | | |
| 4 | 工事担当 | 紐付け | 業者 | | | |
| 5 | 確認番号 | 数値 | | ※後ろに単位「号」 | | |
| 6 | 確認済証交付者 | プルダウン | | 第一検査機関 | 第二検査機関 | 第三検査機関 |
| | | | | 第四検査機関 | | |

Recognised headers: 項目名 / 項目タイプ / 紐づけ先レコード / 選択肢 / 必須 / 幅 / 説明
(plus ラベル, 型, 種別, 参照先, label, type, target… — see `HEAD` in the source).

- **A No. column is ignored.** It is usually blank on most rows, so a parser that
  guesses by position picks it as the label column and produces 190 fields named
  after row numbers.
- **`※システム項目` rows are skipped and reported.** Onboarding sheets list the
  whole sheet including the fields eSM makes itself.
- **Choices may span any number of columns**, and a list too long for one row
  continues on the next with 項目名 and 項目タイプ blank. A single cell holding
  `a,b,c` is still split on commas; several cells are not, so a choice containing
  a comma is safe as long as it has its own column.
- **`（仮）` is a choice, not a placeholder** — that is what an operator working
  from these sheets actually enters.
- 必須: `○ / 1 / true / yes / はい`.
- 幅: 1–4. 見出し always takes the full row.

### Remarks in the choice columns

A cell starting with `※`, and every cell on a non-choice field, is a note to the
operator rather than a value. Three shapes carry a real setting and are applied:

| written in the spec | applied as |
|---|---|
| `※小数点以下2桁` | `decimalDigit: 2` |
| `※後ろに単位「号」` | `unitPostfix: "号"` (and `前に単位「…」` → `unitPrefix`) |
| `※初期値本日` | `defaultValue.applyValue: "today"` on a 日付 field |

**Everything else is listed in the log and applied to nothing.** `※備考欄：氏名`
and `赤系の見やすい色で` are real examples from a real spec; guessing at them is
how a tool starts writing things nobody asked for. Nothing is dropped silently.

## Type table

Derived from `GET /design/{sheetId}` on a sheet holding one field of every type.

| 型 | key prefix | itemType | itemTypeDef | verified |
|---|---|---|---|---|
| テキスト | type_text | STRING | StringItemTypeDef | ✅ |
| テキスト（複数行） | type_textarea | MEMO | MemoItemTypeDef | ✅ |
| プルダウン | type_pulldown | SELECT | SelectItemTypeDef | ✅ |
| ラジオボタン | type_radio_button | SELECT | SelectItemTypeDef | ✅ |
| チェックボックス | type_checkbox | SELECT | SelectItemTypeDef | ✅ |
| 数値 | type_number | NUMBER | NumberItemTypeDef | ✅ |
| 日付 | type_date | DATE | DateItemTypeDef | ✅ |
| 時間 | type_time | TIME | TimeItemTypeDef | ✅ |
| 日時 | type_datetime | DATETIME | DateTimeItemTypeDef | ✅ |
| ファイル | type_file | FILE | FileItemTypeDef | ✅ |
| リンク | type_link | URL | URLItemTypeDef | ✅ |
| 電話番号 | type_telno | TELNO | TelNoItemTypeDef | ✅ |
| 住所 | type_address | ADDRESS | AddressItemTypeDef | ✅ |
| メールアドレス | type_email | EMAIL | EmailItemTypeDef | ✅ |
| 紐づけ項目 | type_suggest | SB_RELATION | SBRelationItemTypeDef | ✅ payload |
| 見出し | type_title | SECTION | SectionItemTypeDef | inferred |

✅ types were created successfully against a live tenant. 紐づけ項目 is marked
"payload" because the create request is reproduced byte for byte from a captured
save (`test/fixtures/relation-create.json`) but the tool has not yet written one
itself. 見出し's shape is taken from real SECTION fields, never from a create.

Choice options are sent with placeholder codes `-1, -2, -3…` and `order`
starting at 2, as the UI does.

**`sum` is an int, not a bool.** `NumberItemTypeDef` needs
`{decimalDigit, unitPrefix: null, unitPostfix: null, sum: 0, validScale: true}`.
Sending `sum: false` is answered with a generic HTTP 500 — the gateway reports
every deserialisation failure as 「ただいまシステムが込み合っております」, so a
500 there means a malformed payload, not load. `test/run.js` compares every
generated `itemTypeDef` against a real field of the same type and fails on a
JS-type mismatch.

## 紐づけ項目 writes to two sheets

This is the one thing the tool does outside the sheet on screen, so it is worth
stating plainly. Adding a link to 業者 also creates the reverse field **on the
業者 sheet**, named `<項目名>（<このシート>）` and disabled — exactly what eSM
does when the same field is added by hand.

What that requires, and how each part is obtained rather than invented:

| needed | where it comes from |
|---|---|
| the target's `sheetName` | this sheet's existing links: the target's id field is labelled `業者ID`, so `業者` resolves to `sheet_134` |
| the target's id definition | copied from an existing link to the same target, with `relationalItemDefPass` cleared |
| this sheet's display name | the `（依頼書）` suffix every existing reverse label already carries |
| the reverse field's key | `GET /design/{target}` → highest `type_suggestN` + 1 |
| the reverse field's `itemOrder` | the same design's highest `itemOrder` + 1 |
| the target's layout map | `POST /layout/tenant/search {keys:[target]}`, added to and sent back |

**A target this sheet has never linked to is refused.** There is no donor to copy
from, so the operator makes the first link by hand and the tool does the rest.
On the spec that motivated this, that is one manual field and 130 automatic ones.

Guards specific to this path:

- The predicted reverse key is checked against the target's own design and layout
  before use; a collision skips the field rather than overwriting one.
- The target's layout map is diffed before sending: any change to an existing
  entry throws.
- The concurrent-edit check covers **every** sheet in the payload, not just the
  one on screen — the target is a sheet nobody is watching.
- After each transaction the target's layout and timestamp are rolled forward, so
  a 1件ずつ run of 130 links cannot send back a map missing the previous 129.
- A sheet left over in the captured template is dropped rather than resent.

### Not supported, by design

| 型 | why |
|---|---|
| 演算（文字） | formula lives in `defaultValue.ref` (e.g. `[[…id]&[…memo]&'']`) plus a `reference` array of the items it reads |
| 演算（数値） | same |
| 紐づけ参照 | pulls a named field *through* a link; the spec says which target sheet but not which of its fields |

They stay manual until someone captures a HAR of creating one.

## Tests

    node test/run.js

96 checks, no dependencies. The important ones replay real captured saves: the recorded PUT is rolled back
to its pre-save state, the tool is asked to recreate the item from a spec row,
and the generated `itemDefs` entry is compared to what eSM actually sent. Both
match exactly. Others cover key-index allocation, duplicate skipping, batch
ordering, delimiter detection, the safety properties above, and that no existing
item is ever renumbered.

Fixtures under `test/fixtures/` are generated from local HAR captures and
scrubbed of tenant identifiers. The HARs themselves are gitignored — they
contain a real tenant's full sheet definitions. To regenerate:

    node test/make-fixtures.js <text-save.har> <pulldown-save.har>

## Safety properties

Everything the tool sends, in full — seven endpoints, one of which writes:

| # | request | kind | when |
|---|---|---|---|
| 1 | `GET /design/{sheetId}?checkAuthorization=false` | read | after capture |
| 2 | `GET /sheetdef/state/{sheetId}` | read | after capture, and after each write |
| 3 | `POST /sheetdef/state/isUpdated` | read-only check | before each write |
| 4 | `GET /design/{target}` and `POST /layout/tenant/search {keys:[target]}` | read | once per link target, only when the spec has 紐づけ項目 |
| 5 | `POST /transaction/doBegin` → `PUT /design/layout/{sheetId}/part` → `POST /transaction/doCommit` | **write** | on 適用 |

Plus one indirect write: capturing the template presses the page's own 保存
button once. On a freshly opened screen that is a no-op save, but it is a real
save, so the tool asks for confirmation first.

What the payload can and cannot do:

- **Additive only.** `deleteItemKeys` is always `[]`, every `itemDef` sent has
  `itemId: null` (a creation, never an edit), and `buildPayload` throws if it
  would alter any existing entry in either layout map. Tested.
- **Nothing outside the item maps is authored.** `initialSheetAuthority`,
  `adminSettings` and the `sheetDefs` metadata are passed through from the
  captured save byte-for-byte. Tested.
- **No request is ever retried.** A network or CORS failure does not tell us
  whether the server processed it, so re-sending a PUT could create the items
  twice. One request, one attempt. Tested for PUT, POST and HTTP 500.
- **Concurrent edits abort the run.** `isUpdated` is checked against the
  timestamp from when our baseline was taken, and a failure of that check is
  **not** skippable — our PUT replays the whole layout, so writing past a
  concurrent edit would silently discard it. Every sheet in the payload is
  checked, link targets included; a missing baseline for one refuses the write
  rather than skipping the check. Tested.
- **The link target is written to additively too.** It gains one entry per link
  and nothing else; its existing entries are diffed before sending, and it is
  absent from the payload entirely when the batch has no links. Tested.
- **Sheet identity is checked** against the URL before every write, so an
  SPA navigation with the panel open cannot write one sheet's items into another.
- **Duplicates are skipped** on exact label match, and near-matches (NFKC,
  whitespace, case) are warned about rather than silently created.
- **Failures leave nothing committed.** `doCommit` is what persists; a failed
  PUT never reaches it.
- **A snapshot is downloaded before every write.**
- **閉じる restores** the patched `XMLHttpRequest`/`fetch` prototypes and removes
  the panel.

Residual risks the operator must be told about:

- The template capture presses 保存, which commits anything already pending on
  the screen. Open the item-edit page fresh and change nothing before running.
- Fields are appended at the bottom of the default area; ordering and tab
  placement stay manual.
- **A 紐づけ項目 changes a second sheet** — the reverse field on the link target.
  The dry run names each target and the count before anything is written. This is
  what eSM itself does, but it is a sheet the operator is not looking at.
- A type with no existing field of the same type on the sheet uses a generic
  layout property block — an untested path. The dry run warns and it should be
  trialled one item at a time.
- An open transaction cannot be rolled back (no such endpoint). The window
  between `doBegin` and `doCommit` is a single request.

## Gateway quirks learned the hard way

- Auth is an `authorization` header with `withCredentials: false`. Sending
  `credentials: 'include'` breaks CORS and the request never leaves the browser.
- `XMLHttpRequest.setRequestHeader` **appends** on repeat calls. Setting
  `Content-Type` when the captured profile already carries it produces
  `application/json, application/json`, which the gateway answers with a
  generic HTTP 500 (`ただいまシステムが込み合っております`). Headers are
  deduplicated case-insensitively before being applied.
- eSM's own code calls `fetch` unbound, so a wrapper must coerce `this` to
  `window` or the page's own requests fail with `Illegal invocation`.
- **`tenantLayout` is not keyed by the sheet you are editing.** Saving a
  紐づけ項目 puts the link target in there too, and in the capture we have it
  comes *first*. The sheet under edit is named by the request URL
  (`/design/layout/{sheetName}/part`) and nowhere else reliably; reading it off
  `Object.keys(tenantLayout)[0]` sends every later write to the wrong sheet.
- `sheetDefs[0].sheetId` is an internal integer (72) while `sheetName` is the
  `sheet_202` form used in URLs and item keys. Item keys use the name.
- `sheetDefs[0].itemDefs` is a **map keyed by item key**, not an array, and on
  the `/part` endpoint it is a partial update — send only the new definitions.
  The layout maps in `tenantLayout` are the opposite: full read-modify-write.

## Known limits

- **Tabs are not supported.** "Put item B on page C" is the original
  requirement and it is not implemented — `mainTabDefs` was empty in all three
  captures, including the customer sheet the spec was written for, so tab
  placement is unverified. Items land at the end of the default
  area. A capture on a sheet with 2+ custom tabs is needed to finish this.
- **Layout position is append-only.** `order` is a cell index in a four-wide
  grid: an item occupies `displaySpan` cells, and a full-width one must begin a
  row. On a 172-field customer sheet every `displaySpan > 1` entry sits at
  `(order − 3) % 4 == 0`, and that phase is read from the sheet rather than
  assumed. New fields pack four to a row after the existing layout, with 見出し
  taking a whole row of its own; nothing already placed is renumbered, because
  inserting mid-layout renumbers everything after it by an amount two samples
  were not enough to pin down. Fields therefore arrive at the bottom in spec
  order; moving them stays manual.
- **`※` remarks are applied only in the three mechanical shapes** listed under
  Spec format. A remark that means something else is reported and ignored.
- There is **no rollback endpoint** — `/transaction/doRollback` returns 404
  (confirmed against staging). `doCommit` is what persists the write, so a
  failure between `doBegin` and `doCommit` leaves nothing committed; the tool
  says so and asks the operator to verify by reloading.
- Production gateway host is discovered from the captured request, so nothing is
  hardcoded to staging.

## Before a customer run

1. Run it against a throwaway sheet in your own tenant with the real spec.
2. Confirm the ⚠ types you actually need, one at a time.
3. Keep the `esm-layout-before-*.json` the tool downloads — it is the rollback.
