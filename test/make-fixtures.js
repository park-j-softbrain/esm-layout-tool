/*
 * Regenerates test/fixtures/*.json from local HAR captures.
 * The HARs themselves are never committed: they contain a real tenant's full
 * sheet definitions. This keeps only the structures the tests assert on, with
 * tenant/sheet identifiers replaced and nested relation data dropped.
 *
 *   node test/make-fixtures.js <har-with-design-and-text-save> <har-with-pulldown-save>
 */
const fs = require('fs');
const path = require('path');

const REAL_SHEET = /sheet_\d+/g;
const FAKE_SHEET = 'sheet_10000000000001';
// entityName carries the same tenant sheet number without the sheet_ prefix
const REAL_ENTITY = /appextender_\d+/g;
const FAKE_ENTITY = 'appextender_10000000000001';
const OUT = path.join(__dirname, 'fixtures');

function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function scrub(value) {
  return JSON.parse(JSON.stringify(value)
    .replace(REAL_SHEET, FAKE_SHEET)
    .replace(REAL_ENTITY, FAKE_ENTITY));
}

function findEntry(har, pred) {
  const hit = har.log.entries.find(pred);
  if (!hit) throw new Error('entry not found');
  return hit;
}

function savePut(har) {
  const e = findEntry(har, (x) => x.request.method === 'PUT' && /\/design\/layout\/.*\/part/.test(x.request.url));
  return scrub(JSON.parse(e.request.postData.text));
}

// Keep only the item definitions, minus validation messages and the nested
// sheet data that SB_RELATION fields carry (which is tenant configuration).
function designItemDefs(har) {
  const e = findEntry(har, (x) => x.request.method === 'GET' && /\/design\/sheet_/.test(x.request.url));
  const body = JSON.parse(e.response.content.text);
  let best = {};
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.itemDefs && typeof o.itemDefs === 'object' &&
        Object.keys(o.itemDefs).length > Object.keys(best).length &&
        Object.keys(o.itemDefs).some((k) => k.indexOf('.') > -1)) best = o.itemDefs;
    Object.values(o).forEach((v) => { if (v && typeof v === 'object') walk(v); });
  })(body);

  const out = {};
  Object.keys(best).forEach((k) => {
    const d = best[k];
    if (!d || typeof d !== 'object') return;
    const td = Object.assign({}, d.itemTypeDef);
    delete td.messages; delete td.message;
    delete td.itemDefs;        // nested relation sheets: tenant configuration
    delete td.options;         // master option lists: tenant configuration
    out[k] = {
      itemId: d.itemId, labelName: d.labelName, itemOrder: d.itemOrder,
      itemType: d.itemType, itemTypeDef: td
    };
  });
  return scrub({ sheetDefs: { itemDefs: out } });
}

const [textHar, pulldownHar] = process.argv.slice(2);
if (!textHar || !pulldownHar) {
  console.error('usage: node test/make-fixtures.js <text-save.har> <pulldown-save.har>');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const files = {
  'design.json': designItemDefs(load(textHar)),
  'put-text.json': savePut(load(textHar)),
  'put-pulldown.json': savePut(load(pulldownHar))
};
Object.entries(files).forEach(([name, data]) => {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 1));
  console.log('wrote fixtures/' + name + '  ' + fs.statSync(path.join(OUT, name)).size + ' bytes');
});
