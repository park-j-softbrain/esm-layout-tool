/*
 * Regenerates test/fixtures/relation-create.json and reference-create.json from a
 * local HAR in which one 紐づけ項目 was added and saved, on a sheet that already
 * carries one 紐づけ参照.
 *
 *   node test/make-relation-fixture.js /path/to/savelinkeditem.har
 *
 * The HAR is never committed. It is a real customer tenant and its sheets carry
 * company and personal names in field labels and choice lists, so this keeps
 * only the two item definitions the reproduction test compares, remaps the two
 * sheet numbers to distinct fakes, and rewrites every label through an explicit
 * atom map. Composed labels ("<項目>（<シート>）") survive because the atoms are
 * replaced globally rather than the composed string being replaced whole.
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'fixtures');

const harPath = process.argv[2];
if (!harPath) { console.error('usage: node test/make-relation-fixture.js <har>'); process.exit(1); }
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));

const api = (u) => /\/sheet-fs\/v1\//.test(u);
const put = har.log.entries.find((e) => e.request.method === 'PUT' && /\/design\/layout\/.*\/part/.test(e.request.url));
const design = har.log.entries.find((e) => api(e.request.url) && /\/design\/sheet_/.test(e.request.url));
if (!put || !design) throw new Error('HAR must contain both GET /design/{sheet} and PUT /design/layout/{sheet}/part');

const sheetName = put.request.url.match(/\/design\/layout\/([^/?#]+)\/part/)[1];
const body = JSON.parse(put.request.postData.text);
const created = Object.entries(body.sheetDefs[0].itemDefs)[0];
const [createdKey, createdDef] = created;
if (createdDef.itemType !== 'SB_RELATION') throw new Error('the saved item is not a 紐づけ項目');

const target = createdDef.itemTypeDef.sheetName;
const dDefs = JSON.parse(design.response.content.text).sheetDefs[0].itemDefs;
const donorEntry = Object.entries(dDefs).find(([k, v]) =>
  v.itemType === 'SB_RELATION' && v.itemTypeDef.sheetName === target && k !== createdKey);
if (!donorEntry) throw new Error('no existing link to ' + target + ' to use as the donor');
const [donorKey, donorDef] = donorEntry;

// The one 紐づけ参照 already on this sheet: a column of a third sheet, carried
// through a link, placed but with no entry in the layout property map. It is the
// only observed example of the shape, so it is what the reference test compares to.
const layoutRoot = body.tenantLayout[sheetName].pc.sheetDefs;
const refPlaceKey = Object.keys(layoutRoot.sheetTypeDefs[0].itemDefs).filter((k) => k.indexOf('@') > -1)[0];
if (!refPlaceKey) throw new Error('this HAR has no 紐づけ参照 to copy the shape from');
const refParentKey = refPlaceKey.split('@')[0];
const refColumnKey = refPlaceKey.split('@')[1];
const refParentDef = dDefs[refParentKey];
if (!refParentDef) throw new Error('the 紐づけ参照 parent link is not in the design response');
const refSheet = refParentDef.itemTypeDef.sheetName;
const refColumnDef = refParentDef.itemTypeDef.itemDefs[refPlaceKey];
if (!refColumnDef) throw new Error('the referenced column is not nested in its link');

const revDef = createdDef.itemTypeDef.reverseRelationItemDef;
const selfLabel = revDef.labelName.match(/[（(]([^（）()]+)[）)]\s*$/)[1];
const idKey = Object.keys(donorDef.itemTypeDef.itemDefs).find((k) => /\.id$/.test(k));
const idDef = donorDef.itemTypeDef.itemDefs[idKey];

// Atoms replaced everywhere, longest first so no atom eats another's prefix.
const atoms = [
  [sheetName, 'sheet_10000000000001'],
  [target, 'sheet_10000000000002'],
  [sheetName.replace('sheet_', 'appextender_'), 'appextender_10000000000001'],
  [target.replace('sheet_', 'appextender_'), 'appextender_10000000000002'],
  [createdDef.labelName, '追加項目'],
  [selfLabel, 'このシート'],
  [String(idDef.labelName || '').replace(/(ID|コード|CODE)$/i, ''), '相手シート'],
  [donorDef.labelName, '既存の紐づけ'],
  [refSheet, 'sheet_10000000000003'],
  [refSheet.replace('sheet_', 'appextender_'), 'appextender_10000000000003'],
  [refParentDef.labelName, '参照元の紐づけ'],
  [refColumnDef.labelName, '参照する項目'],
  [String(refColumnDef.columnName || ''), 'col10000']
].filter(([a]) => a).sort((x, y) => y[0].length - x[0].length);

function scrub(v) {
  let t = JSON.stringify(v);
  atoms.forEach(([from, to]) => { t = t.split(from).join(to); });
  const o = JSON.parse(t);
  // Internal numeric ids leak the tenant's sheet ordering; they are never
  // compared by the tests, so blank them rather than remapping.
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.sheetId === 'number') n.sheetId = 0;
    Object.values(n).forEach(walk);
  };
  walk(o);
  return o;
}

const out = {
  sheetName: 'sheet_10000000000001',
  target: 'sheet_10000000000002',
  selfLabel: 'このシート',
  label: '追加項目',
  newKey: scrub(createdKey),
  donorIdDef: scrub(idDef),
  itemOrder: createdDef.itemOrder,
  revKey: scrub(revDef.itemId),
  revItemOrder: revDef.itemOrder,
  expected: scrub(createdDef)
};

// Refuse to write a fixture that still contains anything from the source tenant.
const text = JSON.stringify(out);
const leaks = atoms.map(([from]) => from).filter((a) => a.length > 2 && text.indexOf(a) >= 0);
if (leaks.length) throw new Error('fixture still contains source values: ' + leaks.join(', '));
const KNOWN = /このシート|相手シート|追加項目|既存の紐づけ|参照元の紐づけ|参照する項目|以内で入力してください/g;
if (/[一-龥ぁ-んァ-ヶ]/.test(text.replace(KNOWN, '')))
  throw new Error('fixture still contains unexpected Japanese text — inspect before committing');

fs.writeFileSync(path.join(OUT, 'relation-create.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote fixtures/relation-create.json');

// The 紐づけ参照: what the linked sheet's own design gives for the column, and
// the two entries it turns into. `columnDef` is that design entry — the nested
// copy with the server's own back-pointer cleared, which is what a fresh one
// carries. `expectedNested` is the observed nested entry, back-pointer and all.
const refOut = {
  sheet: 'sheet_10000000000003',
  parentKey: scrub(refParentKey),
  parentLabel: '参照元の紐づけ',
  columnKey: scrub(refColumnKey),
  columnLabel: '参照する項目',
  nestedKey: scrub(refPlaceKey),
  columnDef: Object.assign(scrub(refColumnDef), { relationalItemDefPass: [] }),
  expectedNested: scrub(refColumnDef),
  placement: layoutRoot.sheetTypeDefs[0].itemDefs[refPlaceKey],
  inPropertyMap: Object.prototype.hasOwnProperty.call(layoutRoot.itemDefs, refPlaceKey)
};
const refText = JSON.stringify(refOut);
const refLeaks = atoms.map(([from]) => from).filter((a) => a.length > 2 && refText.indexOf(a) >= 0);
if (refLeaks.length) throw new Error('reference fixture still contains source values: ' + refLeaks.join(', '));
if (/[一-龥ぁ-んァ-ヶ]/.test(refText.replace(KNOWN, '')))
  throw new Error('reference fixture still contains unexpected Japanese text');
fs.writeFileSync(path.join(OUT, 'reference-create.json'), JSON.stringify(refOut, null, 2) + '\n');
console.log('wrote fixtures/reference-create.json');
