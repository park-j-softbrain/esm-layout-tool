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

Tab-separated, straight out of Excel. Header row optional.

| 型 | 項目名 | 必須 | 選択肢 | 幅 | 説明 |
|---|---|---|---|---|---|
| テキスト | 担当者名 | ○ | | 1 | |
| プルダウン | ステータス | | 未対応,対応中,完了 | 1 | |

- **型 and 項目名 may be in either order** — the parser decides per file by
  checking which of the first two columns holds recognisable type names, which
  matches the copy-name / add-item / paste-name sheet the work is done from today.
- 型 accepts the palette names and ASCII aliases (`text`, `pulldown`, `number`…).
- 必須: `○ / 1 / true / yes / はい`.
- 選択肢 required for プルダウン / ラジオボタン / チェックボックス.
- 幅: 1 or 2.
- Rows whose ラベル already exists on the sheet are **skipped**, so a re-run
  after a partial failure is safe.

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
| 見出し | type_title | SECTION | SectionItemTypeDef | inferred |

All ✅ types were created successfully against staging. 見出し is untested only
because no sample run included one.

Choice options are sent with placeholder codes `-1, -2, -3…` and `order`
starting at 2, as the UI does.

**`sum` is an int, not a bool.** `NumberItemTypeDef` needs
`{decimalDigit, unitPrefix: null, unitPostfix: null, sum: 0, validScale: true}`.
Sending `sum: false` is answered with a generic HTTP 500 — the gateway reports
every deserialisation failure as 「ただいまシステムが込み合っております」, so a
500 there means a malformed payload, not load. `test/run.js` now compares every
generated `itemTypeDef` against a real field of the same type and fails on a
JS-type mismatch.

### Not supported, by design

Three types cannot be created from a name alone, and the tool rejects them with
an explanation rather than writing something broken:

| 型 | why |
|---|---|
| 演算（文字） | formula lives in `defaultValue.ref` (e.g. `[[…id]&[…memo]&'']`) plus a `reference` array of the items it reads |
| 演算（数値） | same |
| 紐づけ項目 | `SBRelationItemTypeDef` embeds the target `sheetName` and a nested copy of that sheet's item defs |

They stay manual until someone captures a HAR of creating one.

## Tests

    node test/run.js

63 checks, no dependencies. The important ones replay real captured saves: the recorded PUT is rolled back
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

Everything the tool sends, in full — five endpoints, one of which writes:

| # | request | kind | when |
|---|---|---|---|
| 1 | `GET /design/{sheetId}?checkAuthorization=false` | read | after capture |
| 2 | `GET /sheetdef/state/{sheetId}` | read | after capture, and after each write |
| 3 | `POST /sheetdef/state/isUpdated` | read-only check | before each write |
| 4 | `POST /transaction/doBegin` → `PUT /design/layout/{sheetId}/part` → `POST /transaction/doCommit` | **write** | on 適用 |

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
  concurrent edit would silently discard it.
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

## Known limits

- **Tabs are not supported.** "Put item B on page C" is the original
  requirement and it is not implemented — `mainTabDefs` was empty in both
  captures, so tab placement is unverified. Items land at the end of the default
  area. A capture on a sheet with 2+ custom tabs is needed to finish this.
- **Layout position is append-only.** `order` is a sparse grid index
  (`1,3,5,11,12,…,51`) with `displaySpan` 1–4, and inserting mid-layout renumbers
  every following item by a non-obvious amount (observed: 40→41, 41→43, 43→47,
  47→51). Rather than reproduce that arithmetic from two samples, the tool
  appends at `max(order+span) + 4` and refuses to modify any existing entry.
  Fields therefore arrive at the bottom in spec order; visual tidying stays manual.
- `NumberItemTypeDef` defaults (`decimalDigit: 0`, no unit prefix/suffix) are
  assumed, not observed.
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
