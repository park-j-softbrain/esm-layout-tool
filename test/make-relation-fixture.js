/*
 * Regenerates test/fixtures/relation-*.json from a local HAR in which one
 * 紐づけ項目 was added and saved.
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
  [donorDef.labelName, '既存の紐づけ']
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
if (/[一-龥ぁ-んァ-ヶ]/.test(text.replace(/このシート|相手シート|追加項目|既存の紐づけ/g, '')))
  throw new Error('fixture still contains unexpected Japanese text — inspect before committing');

fs.writeFileSync(path.join(OUT, 'relation-create.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote fixtures/relation-create.json');
