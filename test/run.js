require('./shim.js');
const fs=require('fs'), assert=require('assert');
new Function(fs.readFileSync(__dirname+'/../esm-layout-tool.js','utf8'))();
const T=window.__esmLayoutTool, S=T.S;

// Fixtures are generated from local HAR captures by test/make-fixtures.js.
// The HARs are never committed; the fixtures are scrubbed of tenant identifiers.
const FIX=__dirname+'/fixtures/';
const readFix=n=>JSON.parse(fs.readFileSync(FIX+n,'utf8'));
const SHEET='sheet_10000000000001';
const PUTS={text:'put-text.json',pulldown:'put-pulldown.json'};

function loadPut(which){
  return {url:'https://gateway.example/sheet-fs/v1/design/layout/'+SHEET+'/part',
          headers:{}, body:readFix(PUTS[which])};
}
function designFrom(){ return readFix('design.json'); }

let pass=0, fail=0;
const pending=[];
function check(name, fn){
  try{
    const r=fn();
    if(r && typeof r.then==='function'){
      pending.push(r.then(()=>{console.log('  PASS  '+name);pass++;},
                          e=>{console.log('  FAIL  '+name+'\n        '+e.message);fail++;}));
      return;
    }
    console.log('  PASS  '+name); pass++;
  }
  catch(e){ console.log('  FAIL  '+name+'\n        '+e.message); fail++; }
}

// ---- Replay: use the real PUT as template, remove the item it created,
// ---- then ask the tool to recreate it from a spec row and compare.
// The design GET only exists in HAR1 (pre-text-item state). For HAR2 we must add
// the item HAR1 created, otherwise the itemOrder baseline is one behind reality.
function designPlus(extraKey, extraDef){
  const d=JSON.parse(JSON.stringify(designFrom()));
  let m=null;
  const walk=(o)=>{ if(!o||typeof o!=='object') return;
    if(o.itemDefs && typeof o.itemDefs==='object' && Object.keys(o.itemDefs).some(k=>k.indexOf('.')>-1)
       && (!m || Object.keys(o.itemDefs).length>Object.keys(m).length)) m=o.itemDefs;
    Object.values(o).forEach(v=>{ if(v&&typeof v==='object') walk(v); }); };
  walk(d); if(m && extraKey) m[extraKey]=extraDef;
  return d;
}
function replay(which, specRow, design){
  const tpl=loadPut(which);
  const sheetName=Object.keys(tpl.body.tenantLayout)[0];
  const realDefs=tpl.body.sheetDefs[0].itemDefs;
  const newKey=Object.keys(realDefs).find(k=>realDefs[k].itemId===null);
  const realDef=JSON.parse(JSON.stringify(realDefs[newKey]));
  const realPlace=JSON.parse(JSON.stringify(
    tpl.body.tenantLayout[sheetName].pc.sheetDefs.sheetTypeDefs[0].itemDefs[newKey]));

  // roll back to the pre-save state
  delete tpl.body.sheetDefs[0].itemDefs[newKey];
  delete tpl.body.tenantLayout[sheetName].pc.sheetDefs.itemDefs[newKey];
  delete tpl.body.tenantLayout[sheetName].pc.sheetDefs.sheetTypeDefs[0].itemDefs[newKey];

  S.tpl=tpl; S.sheetName=sheetName; S.design=design||designFrom();
  const p=T.parseSpec(specRow); assert.strictEqual(p.errors.length,0,'spec errors: '+p.errors);
  S.spec=p.items;
  S.plan=T.buildPlan();
  assert.strictEqual(S.plan.add.length,1,'expected 1 addition, got '+S.plan.add.length+' (skips: '+JSON.stringify(S.plan.skip.map(s=>s.label))+')');
  const payload=T.buildPayload();
  const gotKey=Object.keys(payload.sheetDefs[0].itemDefs)[0];
  const gotDef=payload.sheetDefs[0].itemDefs[gotKey];
  const gotPlace=payload.tenantLayout[sheetName].pc.sheetDefs.sheetTypeDefs[0].itemDefs[gotKey];
  return {newKey,gotKey,realDef,gotDef,realPlace,gotPlace,payload,sheetName,tpl};
}

console.log('\n=== HAR 1: テキスト "the text I added" ===');
{
  const r=replay('text','the text I added\tテキスト');
  check('item key regenerated identically', ()=>assert.strictEqual(r.gotKey,r.newKey));
  check('itemDef deep-equals the real payload', ()=>assert.deepStrictEqual(r.gotDef,r.realDef));
  check('displaySpan matches', ()=>assert.strictEqual(r.gotPlace.displaySpan,r.realPlace.displaySpan));
  check('appends past the end of the layout', ()=>{
    const place=r.tpl.body.tenantLayout[r.sheetName].pc.sheetDefs.sheetTypeDefs[0].itemDefs;
    const max=Math.max(...Object.values(place).map(p=>p.order+(p.displaySpan||1)));
    assert.ok(r.gotPlace.order>=max, 'order '+r.gotPlace.order+' must be >= '+max);
  });
  if(JSON.stringify(r.gotDef)!==JSON.stringify(r.realDef)){
    console.log('    real:',JSON.stringify(r.realDef));
    console.log('    got :',JSON.stringify(r.gotDef));
  }
}
console.log('\n=== HAR 2: プルダウン "Pulldown with 3" ===');
{
  const textDef={itemId:'x',labelName:'the text I added',itemOrder:32,itemType:'STRING',itemTypeDef:{'@type':'StringItemTypeDef'}};
  const r=replay('pulldown','Pulldown with 3\tプルダウン\t\tpick 1,pick 2,pick 3',
                 designPlus('appextender.'+SHEET+'.type_text2',textDef));
  check('item key regenerated identically', ()=>assert.strictEqual(r.gotKey,r.newKey));
  check('itemDef deep-equals the real payload', ()=>assert.deepStrictEqual(r.gotDef,r.realDef));
  check('does not renumber any existing item', ()=>{
    const before=r.tpl.body.tenantLayout[r.sheetName].pc.sheetDefs.sheetTypeDefs[0].itemDefs;
    const after=r.payload.tenantLayout[r.sheetName].pc.sheetDefs.sheetTypeDefs[0].itemDefs;
    Object.keys(before).forEach(k=>assert.deepStrictEqual(after[k],before[k],'changed '+k));
  });
  if(JSON.stringify(r.gotDef)!==JSON.stringify(r.realDef)){
    console.log('    real:',JSON.stringify(r.realDef,null,1));
    console.log('    got :',JSON.stringify(r.gotDef,null,1));
  }
  check('layout itemDefs entry present for new key', ()=>assert.ok(
    r.payload.tenantLayout[r.sheetName].pc.sheetDefs.itemDefs[r.gotKey]));
}
console.log('\n=== spec parsing ===');
check('rejects unknown type', ()=>assert.ok(T.parseSpec('x\tなにか').errors.length===1));
check('rejects pulldown without options', ()=>assert.ok(T.parseSpec('x\tプルダウン').errors.length===1));
check('accepts header row', ()=>assert.strictEqual(T.parseSpec('ラベル\t型\n担当\tテキスト').items.length,1));
check('required marker ○', ()=>assert.strictEqual(T.parseSpec('担当\tテキスト\t○').items[0].required,true));
check('english alias', ()=>assert.strictEqual(T.parseSpec('a\ttext').items[0].type,'テキスト'));
console.log('\n=== batch behaviour ===');
{
  const tpl=loadPut('pulldown');
  const textDef2={itemId:'x',labelName:'the text I added',itemOrder:32,itemType:'STRING',itemTypeDef:{'@type':'StringItemTypeDef'}};
  S.tpl=tpl; S.sheetName=Object.keys(tpl.body.tenantLayout)[0];
  S.design=designPlus('appextender.'+SHEET+'.type_text2',textDef2);
  S.spec=T.parseSpec([
    '担当者名\tテキスト\t○',
    'ステータス\tプルダウン\t\t未対応,対応中,完了',
    '補足\tテキスト',
    'the text I added\tテキスト'
  ].join('\n')).items;
  S.plan=T.buildPlan();
  check('4 rows -> 3 additions, 1 skipped as duplicate', ()=>{
    assert.strictEqual(S.plan.add.length,3,'add='+S.plan.add.length);
    assert.strictEqual(S.plan.skip.length,1,'skip='+S.plan.skip.length);
    assert.strictEqual(S.plan.skip[0].label,'the text I added');
  });
  check('key indices continue without collision', ()=>{
    const keys=S.plan.add.map(a=>a.key.split('.').pop());
    assert.deepStrictEqual(keys,['type_text3','type_pulldown3','type_text4'],'got '+keys);
  });
  check('orders strictly increase and never collide', ()=>{
    const os=S.plan.add.map(a=>a.order);
    assert.deepStrictEqual(os,[...os].sort((x,y)=>x-y));
    assert.strictEqual(new Set(os).size,os.length);
  });
  check('buildPayload sends only the new defs', ()=>{
    const pl=T.buildPayload();
    assert.strictEqual(Object.keys(pl.sheetDefs[0].itemDefs).length,3);
    assert.ok(Object.values(pl.sheetDefs[0].itemDefs).every(d=>d.itemId===null));
  });
  check('required flag reaches the payload', ()=>{
    const pl=T.buildPayload();
    const d=Object.values(pl.sheetDefs[0].itemDefs).find(x=>x.labelName==='担当者名');
    assert.strictEqual(d.isRequired,true);
  });
  check('radio/checkbox get the right selectDisplayType', ()=>{
    S.spec=T.parseSpec('区分\tラジオボタン\t\tA,B\n興味\tチェックボックス\t\tX,Y').items;
    S.plan=T.buildPlan();
    const pl=T.buildPayload();
    const lay=pl.tenantLayout[S.sheetName].pc.sheetDefs.itemDefs;
    const radio=S.plan.add.find(a=>a.type==='ラジオボタン');
    const cb=S.plan.add.find(a=>a.type==='チェックボックス');
    assert.strictEqual(lay[radio.key].itemTypeDef.selectDisplayType,'radio');
    assert.strictEqual(lay[cb.key].itemTypeDef.selectDisplayType,'checkbox');
    assert.strictEqual(pl.sheetDefs[0].itemDefs[cb.key].itemTypeDef.isMultiSelect,true);
  });
}

console.log('\n=== spec column order + unsupported types ===');
{
  const fs2=require('fs');
  check('detects 型-first (sample-spec.tsv)', ()=>{
    const r=T.parseSpec(fs2.readFileSync(__dirname+'/../sample-spec.tsv','utf8'));
    assert.strictEqual(r.col.type,0,'type col='+r.col.type);
    assert.strictEqual(r.errors.length,0,r.errors.join('; '));
    assert.strictEqual(r.items.length,14,'items='+r.items.length);
    assert.strictEqual(r.items[0].label,'担当者名');
    assert.strictEqual(r.items[0].type,'テキスト');
    assert.strictEqual(r.items[0].required,true);
  });
  check('detects 名前-first (reversed columns)', ()=>{
    const rev=fs2.readFileSync(__dirname+'/../sample-spec.tsv','utf8').trim().split('\n')
      .map(l=>{const c=l.split('\t');return [c[1],c[0]].concat(c.slice(2)).join('\t');}).join('\n');
    const r=T.parseSpec(rev);
    assert.strictEqual(r.col.type,1,'type col='+r.col.type);
    assert.strictEqual(r.errors.length,0,r.errors.join('; '));
    assert.strictEqual(r.items[0].label,'担当者名');
  });
  check('rejects 演算/紐づけ参照 with an explanation', ()=>{
    const r=T.parseSpec(fs2.readFileSync(__dirname+'/../sample-unsupported.tsv','utf8'));
    assert.strictEqual(r.items.length,0);
    assert.strictEqual(r.errors.length,3,r.errors.join('; '));
    assert.ok(r.errors.every(e=>/追加できません/.test(e)),r.errors.join('; '));
    assert.ok(/計算式/.test(r.errors[0]));
    assert.ok(/紐づけ先のどの項目/.test(r.errors[2]),r.errors[2]);
  });
  check('all 14 sample rows build a valid payload', ()=>{
    const tpl=loadPut('pulldown');
    S.tpl=tpl; S.sheetName=Object.keys(tpl.body.tenantLayout)[0]; S.design=designFrom();
    S.spec=T.parseSpec(fs2.readFileSync(__dirname+'/../sample-spec.tsv','utf8')).items;
    S.plan=T.buildPlan();
    assert.strictEqual(S.plan.add.length,14,'add='+S.plan.add.length);
    const pl=T.buildPayload();
    const defs=pl.sheetDefs[0].itemDefs;
    assert.strictEqual(Object.keys(defs).length,14);
    Object.values(defs).forEach(d=>{
      assert.strictEqual(d.itemId,null);
      assert.ok(d.itemTypeDef['@type'],'missing @type for '+d.labelName);
      assert.ok(d.labelName);
    });
    const place=pl.tenantLayout[S.sheetName].pc.sheetDefs.sheetTypeDefs[0].itemDefs;
    S.plan.add.forEach(a=>assert.ok(place[a.key],'no placement for '+a.label));
    console.log('        types: '+S.plan.add.map(a=>a.type).join(', '));
  });
}
console.log('\n=== stale /design snapshot (capture race) ===');
{
  // HAR2's template contains the hand-added pulldown (itemOrder 33); HAR1's
  // design snapshot predates it. The tool must still see it.
  const tpl=loadPut('pulldown');
  S.tpl=tpl; S.sheetName=Object.keys(tpl.body.tenantLayout)[0]; S.design=designFrom();
  S.spec=T.parseSpec('プルダウン\tPulldown with 3\t\ta,b\nテキスト\t新しい項目').items;
  S.plan=T.buildPlan();
  check('the just-saved item is seen as a duplicate', ()=>{
    assert.strictEqual(S.plan.skip.length,1,'skip='+JSON.stringify(S.plan.skip.map(x=>x.label)));
    assert.strictEqual(S.plan.skip[0].label,'Pulldown with 3');
  });
  check('itemOrder does not collide with it', ()=>{
    assert.strictEqual(S.plan.add.length,1);
    assert.ok(S.plan.add[0].itemOrder>33,'itemOrder='+S.plan.add[0].itemOrder+' must exceed 33');
  });
}

console.log('\n=== degraded mode (item list unavailable) ===');
{
  const tpl=loadPut('pulldown');
  S.tpl=tpl; S.sheetName=Object.keys(tpl.body.tenantLayout)[0]; S.design=null;
  S.spec=T.parseSpec('テキスト\t新項目').items;
  S.plan=T.buildPlan();
  check('still allocates a non-colliding key from the template alone', ()=>{
    const k=S.plan.add[0].key.split('.').pop();
    assert.strictEqual(k,'type_text3','got '+k);
  });
  check('itemOrder falls back to the template value, not 1', ()=>{
    assert.ok(S.plan.add[0].itemOrder>33,'itemOrder='+S.plan.add[0].itemOrder);
  });
}

console.log('\n=== delimiter handling ===');
{
  check('tab separated', ()=>{
    const r=T.parseSpec('テキスト\t担当者名\t○');
    assert.strictEqual(r.delim,'\t'); assert.strictEqual(r.items[0].label,'担当者名');
  });
  check('comma separated', ()=>{
    const r=T.parseSpec('テキスト,担当者名,○\nプルダウン,ステータス,,未対応,対応中');
    assert.strictEqual(r.delim,',');
    assert.strictEqual(r.items.length,2,JSON.stringify(r.errors));
    assert.strictEqual(r.items[0].label,'担当者名');
  });
  check('quoted CSV keeps commas inside the choices column', ()=>{
    const r=T.parseSpec('プルダウン,ステータス,,"未対応,対応中,完了"');
    assert.strictEqual(r.errors.length,0,r.errors.join(';'));
    assert.deepStrictEqual(r.items[0].options,['未対応','対応中','完了']);
  });
  check('space separated (pasted from a document)', ()=>{
    const r=T.parseSpec('テキスト   担当者名\nプルダウン   ステータス');
    assert.strictEqual(r.delim,' ');
    assert.strictEqual(r.items.length,1,'only the text row is valid without choices');
    assert.strictEqual(r.items[0].label,'担当者名');
  });
  check('single-column paste is rejected clearly', ()=>{
    const r=T.parseSpec('テキスト\nプルダウン');
    assert.strictEqual(r.items.length,0);
    assert.ok(r.errors.length>0);
  });
}

console.log('\n=== per-item payloads ===');
{
  const tpl=loadPut('pulldown');
  S.tpl=tpl; S.sheetName=Object.keys(tpl.body.tenantLayout)[0]; S.design=designFrom();
  S.spec=T.parseSpec(require('fs').readFileSync(__dirname+'/../sample-spec-rest.tsv','utf8')).items;
  S.plan=T.buildPlan();
  check('each item can be sent alone', ()=>{
    S.plan.add.forEach(a=>{
      const pl=T.buildPayload([a]);
      assert.strictEqual(Object.keys(pl.sheetDefs[0].itemDefs).length,1,'for '+a.label);
      assert.strictEqual(Object.keys(pl.sheetDefs[0].itemDefs)[0],a.key);
    });
  });
  check('a single-item payload is far smaller than the batch', ()=>{
    const one=JSON.stringify(T.buildPayload([S.plan.add[0]])).length;
    const all=JSON.stringify(T.buildPayload()).length;
    assert.ok(one<all,'one='+one+' all='+all);
  });
}

console.log('\n=== itemTypeDef shapes match the server model ===');
{
  // Compare every generated itemTypeDef against a real field of the same type
  // from GET /design. Shared keys must agree on JS type — this is exactly the
  // check that would have caught sum:false vs sum:0.
  const design=designFrom();
  let real={};
  const walk=o=>{if(!o||typeof o!=='object')return;
    if(o.itemDefs&&typeof o.itemDefs==='object'&&Object.keys(o.itemDefs).length>Object.keys(real).length
       &&Object.keys(o.itemDefs).some(k=>k.indexOf('.')>-1))real=o.itemDefs;
    Object.values(o).forEach(v=>{if(v&&typeof v==='object')walk(v)});};
  walk(design);
  const tpl=loadPut('pulldown');
  S.tpl=tpl; S.sheetName=Object.keys(tpl.body.tenantLayout)[0]; S.design=design;
  const IGNORE=new Set(['messages','message','options','defaultSelected','isMultiSelect',
                        'isBoolean','max_OPTION_SIZE','isNotUseOptionMap','isUseOptionMap',
                        'validator','isNameItem','asPassword','allowFullWidth',
                        'allowHalfWidthAlphabet','allowHalfWidthNumeric']);
  const kind=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
  Object.keys(T.TYPES).forEach(typeName=>{
    const cfg=T.TYPES[typeName];
    const realKey=Object.keys(real).find(k=>new RegExp('\\.'+cfg.prefix+'\\d+$').test(k));
    if(!realKey) return;
    if(cfg.relation) return;   // needs a link target; covered by the replay below
    check('itemTypeDef shape: '+typeName, ()=>{
      S.spec=[{line:1,label:'__t_'+cfg.prefix,type:typeName,required:false,
               options:cfg.itemType==='SELECT'?['a','b']:[],span:1,explanation:''}];
      S.plan=T.buildPlan();
      const gen=T.buildPayload().sheetDefs[0].itemDefs[S.plan.add[0].key].itemTypeDef;
      const rt=real[realKey].itemTypeDef;
      const bad=[];
      Object.keys(gen).forEach(k=>{
        if(IGNORE.has(k)||!(k in rt)) return;
        if(kind(gen[k])!==kind(rt[k])) bad.push(k+': sent '+kind(gen[k])+'('+JSON.stringify(gen[k])+') but server has '+kind(rt[k])+'('+JSON.stringify(rt[k])+')');
      });
      assert.deepStrictEqual(bad,[],bad.join('; '));
    });
  });
}

console.log('\n=== safety: request behaviour ===');
{
  const X=global.__xhr;
  S.tpl={url:'https://gateway.example/sheet-fs/v1/design/layout/'+SHEET+'/part',headers:{},body:{}};
  S.profile={headers:{'authorization':'Bearer x'},withCredentials:false};

  check('a failed PUT is never retried', async()=>{
    X.sends=[]; X.mode='error';
    await T.request('PUT','https://gateway.example/sheet-fs/v1/design/layout/'+SHEET+'/part','{}').then(
      ()=>{throw new Error('should have failed')},()=>{});
    assert.strictEqual(X.sends.length,1,'sent '+X.sends.length+' times; a retried PUT could duplicate items');
  });
  check('a failed POST is never retried', async()=>{
    X.sends=[]; X.mode='error';
    await T.request('POST','https://gateway.example/sheet-fs/v1/transaction/doBegin',null).then(
      ()=>{throw new Error('should have failed')},()=>{});
    assert.strictEqual(X.sends.length,1,'sent '+X.sends.length+' times');
  });
  check('an HTTP 500 is never retried either', async()=>{
    X.sends=[]; X.mode='http500';
    await T.request('PUT','https://gateway.example/sheet-fs/v1/design/layout/'+SHEET+'/part','{}').then(
      ()=>{throw new Error('should have failed')},()=>{});
    assert.strictEqual(X.sends.length,1);
  });
  check('credentials mode mirrors the app, never flips', async()=>{
    X.sends=[]; X.mode='error'; S.profile.withCredentials=false;
    await T.request('GET','https://gateway.example/sheet-fs/v1/x',null).catch(()=>{});
    assert.strictEqual(S.profile.withCredentials,false,'must not mutate the captured profile');
  });
}

console.log('\n=== safety: the payload only ever adds ===');
{
  const tpl=loadPut('pulldown');
  S.tpl=tpl; S.sheetName=Object.keys(tpl.body.tenantLayout)[0]; S.design=designFrom();
  S.spec=T.parseSpec(require('fs').readFileSync(__dirname+'/../sample-spec.tsv','utf8')).items;
  S.plan=T.buildPlan();
  const before=JSON.parse(JSON.stringify(tpl.body));
  const pl=T.buildPayload();
  const sn=S.sheetName;
  const lay=b=>b.tenantLayout[sn].pc.sheetDefs.itemDefs;
  const place=b=>b.tenantLayout[sn].pc.sheetDefs.sheetTypeDefs[0].itemDefs;

  check('deleteItemKeys is always empty', ()=>assert.deepStrictEqual(pl.deleteItemKeys,[]));
  check('no existing item is removed from either layout map', ()=>{
    Object.keys(lay(before)).forEach(k=>assert.ok(k in lay(pl),'dropped from itemDefs: '+k));
    Object.keys(place(before)).forEach(k=>assert.ok(k in place(pl),'dropped from placement: '+k));
  });
  check('no existing item is modified in either layout map', ()=>{
    Object.keys(lay(before)).forEach(k=>assert.deepStrictEqual(lay(pl)[k],lay(before)[k],'changed '+k));
    Object.keys(place(before)).forEach(k=>assert.deepStrictEqual(place(pl)[k],place(before)[k],'changed '+k));
  });
  check('authority and admin settings are passed through untouched', ()=>{
    assert.deepStrictEqual(pl.initialSheetAuthority,before.initialSheetAuthority);
    assert.deepStrictEqual(pl.adminSettings,before.adminSettings);
  });
  check('every itemDef sent is a creation (itemId null), never an edit', ()=>{
    Object.values(pl.sheetDefs[0].itemDefs).forEach(d=>assert.strictEqual(d.itemId,null,d.labelName));
  });
  check('sheetDefs metadata is unchanged', ()=>{
    const strip=o=>{const c=Object.assign({},o);delete c.itemDefs;return c;};
    assert.deepStrictEqual(strip(pl.sheetDefs[0]),strip(before.sheetDefs[0]));
  });
}

console.log('\n=== UI wiring ===');
{
  const src=require('fs').readFileSync(__dirname+'/../esm-layout-tool.js','utf8');
  const declared=new Set([...src.matchAll(/id="(elt-[a-z-]+)"/g)].map(m=>m[1]));
  const used=new Set([...src.matchAll(/\$\('(elt-[a-z-]+)'\)/g)].map(m=>m[1]));
  used.add('elt-log');
  check('every referenced element id exists in the panel', ()=>{
    const missing=[...used].filter(i=>!declared.has(i));
    assert.deepStrictEqual(missing,[],'missing from HTML: '+missing);
  });
  check('every declared id is actually used', ()=>{
    const unused=[...declared].filter(i=>!used.has(i));
    assert.deepStrictEqual(unused,[],'declared but unused: '+unused);
  });
  check('save button lookup matches the real markup and prefers the footer', ()=>{
    const m=src.match(/const ordered = \[([\s\S]*?)\];/);
    assert.ok(m,'ordered selector list not found');
    const list=m[1];
    // Observed markup: <div data-test-id="detail-footer"> … <button class="… modify-btn">保存</button>
    assert.ok(/detail-footer.*modify-btn/.test(list.split('\n')[0]),
      'the first candidate must be the footer primary button, got: '+list.split('\n')[0].trim());
    assert.ok(/sb-footer/.test(list),'sb-footer fallback missing');
  });
  check('both run modes are primary buttons wired to the same flow', ()=>{
    assert.ok(/id="elt-run"/.test(src) && /id="elt-run-one"/.test(src),'both primary buttons must exist');
    assert.ok(/\$\('elt-run'\)\.onclick = \(\) => runAll\('batch'\)/.test(src),'一括 must call runAll(batch)');
    assert.ok(/\$\('elt-run-one'\)\.onclick = \(\) => runAll\('one'\)/.test(src),'1件ずつ must call runAll(one)');
    assert.ok(/mode === 'one' \? applyOneByOne\(\) : apply\(\)/.test(src),'runAll must branch on mode');
  });
  check('both primary buttons are disabled together while a run is in flight', ()=>{
    assert.ok(/btns\.forEach\(\(b\) => \{ b\.disabled = true; \}\)/.test(src));
    assert.ok(/btns\.forEach\(\(b\) => \{ b\.disabled = false; \}\)/.test(src));
  });
  check('an ambiguous 保存 button is refused rather than guessed', ()=>{
    assert.ok(/hit\.length > 1\)\s*return null/.test(src),
      'multiple matching 保存 buttons must return null so the operator presses it');
  });
}


console.log('\n=== 紐づけ項目 (SB_RELATION) ===');
{
  const F=readFix('relation-create.json');
  // Rebuild the state the app was in when it sent the captured PUT: this sheet
  // already links to the target once, which is where the donor comes from.
  function relState(opts){
    const o=opts||{};
    const donorKey='appextender.'+F.sheetName+'.type_suggest2';
    const donor={itemType:'SB_RELATION',labelName:'既存の紐づけ',itemOrder:F.itemOrder-1,
      itemTypeDef:{'@type':'SBRelationItemTypeDef',sheetName:F.target,
        itemDefs:{[donorKey+'@'+F.donorIdDef.itemId]:F.donorIdDef},
        reverseRelationItemDef:{labelName:'既存の紐づけ（'+F.selfLabel+'）'}}};
    const defs={}; defs[donorKey]=donor;
    S.design={sheetDefs:[{sheetName:F.sheetName,itemDefs:defs}]};
    S.sheetName=F.sheetName;
    // enough of a template to append to; the item key counter must reach 116
    const place={}, lay={};
    for(let i=1;i<=(o.existing||115);i++){
      const k='appextender.'+F.sheetName+'.type_suggest'+i;
      lay[k]={label:{readOnly:false,hideProperty:false}}; place[k]={order:2+i,displaySpan:1};
    }
    S.tpl={url:'https://gw.example/sheet-fs/v1/design/layout/'+F.sheetName+'/part',headers:{},
      body:{tenantLayout:{[F.sheetName]:{pc:{sheetDefs:{itemDefs:lay,sheetTypeDefs:[{itemDefs:place}]}}}},
            sheetDefs:[{sheetId:1,sheetName:F.sheetName,itemDefs:{}}],deleteItemKeys:[],
            initialSheetAuthority:{},adminSettings:{}}};
    // the target sheet, as /design and /layout/tenant/search would return it
    const tDefs={}; for(let i=1;i<=(o.targetItems||101);i++)
      tDefs['appextender.'+F.target+'.type_suggest'+i]={itemOrder:i+23,itemType:'SB_RELATION'};
    const tLay={}; Object.keys(tDefs).forEach(k=>{tLay[k]={label:{readOnly:false,hideProperty:false}};});
    S.targetMaxOrder={};
    S.targetDesign={[F.target]:{sheetDefs:[{sheetName:F.target,itemDefs:tDefs}]}};
    S.targetLayout={[F.target]:{[F.target]:{pc:{sheetDefs:{itemDefs:tLay,sheetTypeDefs:[{itemDefs:{}}]}}}}};
    return {donorKey};
  }
  const specRow=(label,target)=>({line:1,label:label,type:'紐づけ項目',required:false,
    target:target||'相手シート',options:[],span:1,explanation:''});

  check('reproduces the captured 紐づけ create payload byte for byte', ()=>{
    relState();
    S.spec=[specRow(F.label)];
    S.plan=T.buildPlan();
    assert.strictEqual(S.plan.add.length,1,S.plan.skip.map(s=>s.reason).join('; '));
    const a=S.plan.add[0];
    assert.strictEqual(a.key,F.newKey,'forward key');
    assert.strictEqual(a.rel.revKey,F.revKey,'reverse key');
    assert.strictEqual(a.itemOrder,F.itemOrder,'forward itemOrder');
    assert.strictEqual(a.rel.revItemOrder,F.revItemOrder,'reverse itemOrder');
    const gen=T.buildPayload().sheetDefs[0].itemDefs[a.key];
    assert.deepStrictEqual(gen,F.expected);
  });

  check('resolves the target sheet from its display name, not just sheet_N', ()=>{
    relState();
    S.spec=[specRow('A','相手シート'),specRow('B',F.target)];
    S.plan=T.buildPlan();
    assert.strictEqual(S.plan.add.length,2,S.plan.skip.map(s=>s.reason).join('; '));
    assert.strictEqual(S.plan.add[0].rel.target,F.target);
    assert.strictEqual(S.plan.add[1].rel.target,F.target);
  });

  check('refuses a target this sheet has never linked to', ()=>{
    relState();
    S.spec=[specRow('A','見たことのないシート')];
    S.plan=T.buildPlan();
    assert.strictEqual(S.plan.add.length,0);
    assert.ok(/見つかりません/.test(S.plan.skip[0].reason),S.plan.skip[0].reason);
  });

  check('reverse keys are consecutive and never reuse one the target holds', ()=>{
    relState();
    S.spec=[specRow('A'),specRow('B'),specRow('C')];
    S.plan=T.buildPlan();
    const rev=S.plan.add.map(a=>a.rel.revKey);
    assert.deepStrictEqual(rev,[102,103,104].map(n=>'appextender.'+F.target+'.type_suggest'+n));
    const orders=S.plan.add.map(a=>a.rel.revItemOrder);
    assert.deepStrictEqual(orders,[125,126,127]);
  });

  check('a reverse key already used on the target is refused, not overwritten', ()=>{
    relState();
    // the target already holds type_suggest102, so max+1 would collide
    S.targetDesign[F.target].sheetDefs[0].itemDefs['appextender.'+F.target+'.type_suggest103']={itemOrder:9};
    delete S.targetDesign[F.target].sheetDefs[0].itemDefs['appextender.'+F.target+'.type_suggest101'];
    S.spec=[specRow('A')];
    S.plan=T.buildPlan();
    // allocation restarts from the true max (103) so it must not land on 102 either
    assert.strictEqual(S.plan.add[0].rel.revKey,'appextender.'+F.target+'.type_suggest104');
  });

  check('the target sheet receives exactly one new entry per link', ()=>{
    relState();
    S.spec=[specRow('A'),specRow('B')];
    S.plan=T.buildPlan();
    const pl=T.buildPayload();
    const before=S.targetLayout[F.target][F.target].pc.sheetDefs.itemDefs;
    const after=pl.tenantLayout[F.target].pc.sheetDefs.itemDefs;
    const added=Object.keys(after).filter(k=>!(k in before));
    assert.strictEqual(added.length,2,'added '+added.length);
    assert.deepStrictEqual(added.sort(),S.plan.add.map(a=>a.rel.revKey).sort());
    Object.keys(before).forEach(k=>{
      assert.deepStrictEqual(after[k],before[k],'existing target entry '+k+' was modified');
    });
    assert.strictEqual(after[added[0]].componentType,'suggest#sheet');
  });

  check('the target sheet is not touched when the batch has no links', ()=>{
    relState();
    S.spec=[{line:1,label:'ただのテキスト',type:'テキスト',required:false,options:[],span:1,explanation:''}];
    S.plan=T.buildPlan();
    const pl=T.buildPayload();
    assert.deepStrictEqual(Object.keys(pl.tenantLayout),[F.sheetName]);
  });

  check('a foreign sheet in the captured template is dropped, not resent', ()=>{
    relState();
    S.tpl.body.tenantLayout['sheet_99999999999999']={pc:{sheetDefs:{itemDefs:{stale:1}}}};
    S.spec=[{line:1,label:'ただのテキスト',type:'テキスト',required:false,options:[],span:1,explanation:''}];
    S.plan=T.buildPlan();
    assert.deepStrictEqual(Object.keys(T.buildPayload().tenantLayout),[F.sheetName]);
  });

  // The bug this guards: one transaction per item means the second batch builds
  // on the fetched target layout. Without rolling it forward, that map is missing
  // the first batch's reverse field and would send it back deleted.
  check('a second batch keeps the first batch reverse field on the target', ()=>{
    relState();
    S.spec=[specRow('A')];
    S.plan=T.buildPlan();
    const first=T.buildPayload();
    // simulate what writeBatch does after doCommit
    S.tpl.body=first;
    S.targetLayout[F.target]={[F.target]:first.tenantLayout[F.target]};
    S.design.sheetDefs[0].itemDefs[S.plan.add[0].key]=first.sheetDefs[0].itemDefs[S.plan.add[0].key];
    S.targetMaxOrder[F.target]=S.plan.add[0].rel.revItemOrder;   // what writeBatch records
    const firstRev=S.plan.add[0].rel.revKey;
    const firstOrder=S.plan.add[0].rel.revItemOrder;

    S.spec=[specRow('B')];
    S.plan=T.buildPlan();
    const second=T.buildPayload();
    const after=second.tenantLayout[F.target].pc.sheetDefs.itemDefs;
    assert.ok(after[firstRev],'the first batch reverse field '+firstRev+' vanished from the second payload');
    assert.notStrictEqual(S.plan.add[0].rel.revKey,firstRev,'the second batch reused the first reverse key');
    assert.strictEqual(S.plan.add[0].rel.revItemOrder,firstOrder+1,'the second batch reused the first reverse itemOrder');
  });
}

console.log('\n=== the real onboarding spec shape ===');
{
  const src=require('fs').readFileSync(__dirname+'/../sample-onboarding.tsv','utf8');
  const r=T.parseSpec(src);
  const by=l=>r.items.find(i=>i.label===l);

  check('reads the columns from the header row, not from their position', ()=>{
    assert.strictEqual(r.col.label,1,'label col='+r.col.label);
    assert.strictEqual(r.col.type,2,'type col='+r.col.type);
    assert.strictEqual(r.col.target,3,'target col='+r.col.target);
    assert.strictEqual(r.col.options,4,'options col='+r.col.options);
  });

  check('a mostly-empty No. column does not become the label column', ()=>{
    assert.strictEqual(r.items[0].label,'物件　情報');
    assert.ok(!r.items.some(i=>/^\d+$/.test(i.label)),'a row number was read as a label');
  });

  check('※システム項目 rows are reported and skipped, never re-added', ()=>{
    assert.ok(!by('依頼書ID'),'依頼書ID was queued for creation');
    assert.ok(!by('登録日'),'登録日 was queued for creation');
    assert.strictEqual(r.notes.filter(n=>/システム項目/.test(n)).length,2,r.notes.join('\n'));
  });

  check('a choice list continued on the next row is joined to its field', ()=>{
    assert.deepStrictEqual(by('確認済証交付者').options,
      ['第一検査機関','第二検査機関','第三検査機関','第四検査機関','第五検査機関']);
  });

  check('choices spread across columns are not comma-split, and (仮) is a choice', ()=>{
    assert.deepStrictEqual(by('建方').options,['4t','2tL']);
    assert.deepStrictEqual(by('設計担当').options,['（仮）']);
  });

  check('※小数点以下2桁 becomes decimalDigit', ()=>{
    assert.strictEqual(by('建物面積・延床面積').decimalDigit,2);
  });
  check('※後ろに単位「号」 becomes unitPostfix', ()=>{
    assert.strictEqual(by('確認番号').unitPostfix,'号');
    assert.ok(!by('確認番号').unitPrefix);
  });
  check('※初期値本日 becomes a today default on a date field', ()=>{
    assert.strictEqual(by('確認年月日').defaultToday,true);
  });

  check('a remark that carries no setting is reported, not silently dropped', ()=>{
    assert.ok(r.notes.some(n=>/備考欄：氏名/.test(n)),r.notes.join('\n'));
    assert.ok(r.notes.some(n=>/赤系/.test(n)),r.notes.join('\n'));
    assert.deepStrictEqual(by('物件名').options,[]);
  });

  check('紐づけ and 紐付け both resolve, carrying their target', ()=>{
    assert.strictEqual(by('建物形状').type,'紐づけ項目');
    assert.strictEqual(by('建物形状').target,'建物形状');
    assert.strictEqual(by('基礎').type,'紐づけ項目');
    assert.strictEqual(by('基礎').target,'業者');
  });

  check('a 紐づけ row with no target is an error, not a half-built field', ()=>{
    const bad=T.parseSpec('項目名\t項目タイプ\t紐づけ先レコード\n担当\t紐付け\t\n');
    assert.strictEqual(bad.items.length,0);
    assert.ok(/紐づけ先レコード/.test(bad.errors[0]),bad.errors.join('; '));
  });

  // A row may produce both an item and a remark note, so this counts the rows
  // each outcome mentions rather than the outcomes themselves. What it rules out
  // is a row that produced nothing at all — silently dropped.
  check('no row of the spec is lost: every one is an item, a note or an error', ()=>{
    const lineOf=t=>{const m=String(t).match(/^行(\d+):/);return m?+m[1]:null;};
    const seen=new Set();
    r.items.forEach(i=>seen.add(i.line));
    r.notes.concat(r.errors).forEach(t=>{const l=lineOf(t); if(l) seen.add(l);});
    const total=src.trim().split('\n').length;            // header + data rows
    const continued=[12];                                 // the choice-list overflow row
    const missing=[];
    for(let l=2;l<=total;l++) if(!seen.has(l)&&continued.indexOf(l)<0) missing.push(l);
    assert.deepStrictEqual(missing,[],'these spec rows produced nothing: '+missing.join(','));
  });
}

console.log('\n=== grid placement ===');
{
  function place(spec,startOrders){
    const lay={},pl={};
    (startOrders||[[3,1],[4,1]]).forEach(([o,s],i)=>{
      const k='appextender.'+SHEET+'.type_text'+(i+1);
      lay[k]={label:{readOnly:false,hideProperty:false}}; pl[k]={order:o,displaySpan:s};
    });
    S.sheetName=SHEET; S.design={sheetDefs:[{itemDefs:{}}]}; S.targetDesign={}; S.targetLayout={};
    S.tpl={url:'https://gw.example/sheet-fs/v1/design/layout/'+SHEET+'/part',headers:{},
      body:{tenantLayout:{[SHEET]:{pc:{sheetDefs:{itemDefs:lay,sheetTypeDefs:[{itemDefs:pl}]}}}},
            sheetDefs:[{sheetId:1,sheetName:SHEET,itemDefs:{}}],deleteItemKeys:[],
            initialSheetAuthority:{},adminSettings:{}}};
    S.spec=spec; S.plan=T.buildPlan();
    return S.plan.add.map(a=>[a.label,a.order,a.span]);
  }
  const row=(label,type)=>({line:1,label:label,type:type,required:false,options:type==='プルダウン'?['a']:[],span:1,explanation:''});

  check('plain fields pack four to a row instead of one per row', ()=>{
    const got=place([row('a','テキスト'),row('b','テキスト'),row('c','テキスト'),row('d','テキスト')]);
    assert.deepStrictEqual(got.map(g=>g[1]),[5,6,7,8]);
  });

  check('見出し takes the whole row and starts a new one', ()=>{
    const got=place([row('a','テキスト'),row('見出し1','見出し'),row('b','テキスト')]);
    assert.deepStrictEqual(got,[['a',5,1],['見出し1',7,4],['b',11,1]]);
  });

  check('the row boundary is read from the sheet, not assumed', ()=>{
    // a sheet whose grid starts at 0 puts row starts on multiples of 4
    const got=place([row('見出し1','見出し')],[[0,1],[1,1]]);
    assert.deepStrictEqual(got,[['見出し1',4,4]]);
  });

  check('an empty layout still places the first 見出し on a row start', ()=>{
    const got=place([row('見出し1','見出し'),row('a','テキスト')],[]);
    assert.strictEqual(got[0][2],4);
    assert.strictEqual(got[1][1],got[0][1]+4);
  });
}

console.log('\n=== the sheet under edit is identified by URL ===');
{
  check('a link save does not point later writes at the target sheet', ()=>{
    // tenantLayout key order puts the TARGET first in a real link save
    const body={tenantLayout:{'sheet_10000000000002':{pc:{}},[SHEET]:{pc:{}}},
                sheetDefs:[{itemDefs:{}}]};
    T.captureForTest('https://gw.example/sheet-fs/v1/design/layout/'+SHEET+'/part',{},JSON.stringify(body));
    assert.strictEqual(S.sheetName,SHEET,'sheetName='+S.sheetName);
  });
}

console.log('\n=== duplicate names ===');
{
  const row=(label,type)=>({line:1,label:label,type:type,required:false,options:[],span:1,explanation:''});
  function bare(){
    S.sheetName=SHEET; S.targetDesign={}; S.targetLayout={};
    S.design={sheetDefs:[{itemDefs:{['appextender.'+SHEET+'.type_text1']:{labelName:'既にある',itemType:'STRING',itemOrder:1}}}]};
    S.tpl={url:'https://gw.example/sheet-fs/v1/design/layout/'+SHEET+'/part',headers:{},
      body:{tenantLayout:{[SHEET]:{pc:{sheetDefs:{itemDefs:{},sheetTypeDefs:[{itemDefs:{}}]}}}},
            sheetDefs:[{sheetId:1,sheetName:SHEET,itemDefs:{}}],deleteItemKeys:[],
            initialSheetAuthority:{},adminSettings:{}}};
  }
  // The real spec lists 解体 twice, once as 日時 and once as 紐付け.
  check('a name repeated inside the spec is flagged as a spec problem', ()=>{
    bare(); S.spec=[row('解体','日時'),row('解体','テキスト')];
    S.plan=T.buildPlan();
    assert.strictEqual(S.plan.add.length,1);
    assert.strictEqual(S.plan.add[0].type,'日時');
    assert.ok(/項目リスト内/.test(S.plan.skip[0].reason),S.plan.skip[0].reason);
  });
  check('a name already on the sheet is flagged as an existing field', ()=>{
    bare(); S.spec=[row('既にある','テキスト')];
    S.plan=T.buildPlan();
    assert.strictEqual(S.plan.add.length,0);
    assert.ok(/既に存在/.test(S.plan.skip[0].reason),S.plan.skip[0].reason);
  });
}

console.log('\n=== concurrency covers the link target too ===');
{
  // Mutate the shared recorder in place: other tests hold a reference to it.
  const X=(global.__xhr=global.__xhr||{sends:[]});
  const arm=(resp)=>{ X.sends=[]; X.mode='ok'; X.response=resp; return X; };
  const disarm=()=>{ delete X.response; X.mode='error'; };
  const base=()=>{
    S.sheetName='sheet_A'; S.baselineUpdatedAt='2026/09/09 09:00:00';
    S.profile={headers:{authorization:'Bearer x'},withCredentials:false};
    S.tpl={url:'https://gateway.example/sheet-fs/v1/design/layout/sheet_A/part',headers:{},body:{}};
  };

  check('the exclusive check names every sheet the payload writes to', ()=>{
    base(); S.targetBaseline={'sheet_B':'2026/09/09 08:00:00'};
    arm(JSON.stringify([{sheetName:'sheet_A',isUpdated:false},{sheetName:'sheet_B',isUpdated:false}]));
    const sent=X.sends;
    return T.checkConcurrentEdits(['sheet_B']).then(names=>{
      disarm();
      assert.deepStrictEqual(names,['sheet_A','sheet_B']);
      const body=JSON.parse(sent[sent.length-1].body);
      assert.deepStrictEqual(body.map(r=>r.sheetName),['sheet_A','sheet_B']);
      assert.strictEqual(body[1].localUpdatedAt,'2026/09/09 08:00:00');
    },e=>{disarm();throw e;});
  });

  check('an edit to the link target aborts the write', ()=>{
    base(); S.targetBaseline={'sheet_B':'2026/09/09 08:00:00'};
    arm(JSON.stringify([{sheetName:'sheet_A',isUpdated:false},{sheetName:'sheet_B',isUpdated:true}]));
    return T.checkConcurrentEdits(['sheet_B']).then(
      ()=>{disarm();throw new Error('a concurrent edit to the target was not caught');},
      e=>{disarm();assert.ok(/sheet_B/.test(e.message),e.message);});
  });

  check('a target with no baseline refuses to write rather than guessing', ()=>{
    base(); S.targetBaseline={};
    return T.checkConcurrentEdits(['sheet_B']).then(
      ()=>{throw new Error('wrote without a baseline for the target');},
      e=>{assert.ok(/基準時刻/.test(e.message),e.message);});
  });
}

// Registered checks can be added anywhere above; this waits for whatever is
// pending when the file finishes, rather than for a snapshot taken part-way
// through it — a block appended later would otherwise not be waited on at all.
(async () => {
  while (pending.length) await Promise.all(pending.splice(0));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();

console.log('\n=== the operator is told about the second sheet ===');
{
  const src=require('fs').readFileSync(__dirname+'/../esm-layout-tool.js','utf8');
  check('both confirm dialogs name the link targets', ()=>{
    const calls=src.match(/relationWarning\([^)]*\)/g)||[];
    assert.ok(calls.length>=3,'relationWarning is used '+calls.length+' times; expected a definition plus both confirms');
    const apply=src.slice(src.indexOf('件の項目を追加します'),src.indexOf('件の項目を追加します')+200);
    assert.ok(/relationWarning/.test(apply),'the 一括 confirm does not mention the link targets');
    const one=src.slice(src.indexOf('件を1件ずつ追加します'),src.indexOf('件を1件ずつ追加します')+200);
    assert.ok(/relationWarning/.test(one),'the 1件ずつ confirm does not mention the link targets');
  });
  check('the warning counts links per target and stays silent without them', ()=>{
    const fn=T.relationWarning;
    assert.strictEqual(fn([{label:'a'},{label:'b'}]),'');
    assert.strictEqual(fn([]),'');
    assert.strictEqual(fn(null),'');
    const w=fn([{rel:{target:'sheet_B'}},{rel:{target:'sheet_B'}},{rel:{target:'sheet_C'}}]);
    assert.ok(/sheet_B に逆側の項目 2 件/.test(w),w);
    assert.ok(/sheet_C に逆側の項目 1 件/.test(w),w);
  });
}

console.log('\n=== link target: design is picked by name, not by position ===');
{
  const F=readFix('relation-create.json');
  check('a design listing several sheetDefs uses the one that is the target', ()=>{
    S.targetMaxOrder={};
    const wrong={}; wrong['appextender.other.type_suggest900']={itemOrder:9000};
    const right={}; right['appextender.'+F.target+'.type_suggest7']={itemOrder:70};
    S.targetDesign={[F.target]:{sheetDefs:[
      {sheetName:F.target,itemDefs:right},
      {sheetName:'sheet_other',itemDefs:wrong}]}};
    S.targetLayout={[F.target]:{[F.target]:{pc:{sheetDefs:{itemDefs:{}}}}}};
    const a=T.targetAllocatorForTest(F.target);
    assert.strictEqual(a.itemOrder,71,'took itemOrder from the wrong sheetDef');
    assert.strictEqual(a.next,8,'took the key counter from the wrong sheetDef');
  });
}

console.log('\n=== a spec pasted without its header row ===');
{
  // Exactly the shape an operator gets by copying the data rows only:
  // 項目名 | 項目タイプ | 紐づけ先レコード | 選択肢…
  const paste=[
    '物件　情報\t見出し\t\t赤系の見やすい色で',
    '依頼書ID\t※システム項目\t\t',
    '物件名\tテキスト\t\t※備考欄：氏名',
    '契約支店\t紐付け参照\t案件\t※権限は参照のみ',
    '工事担当\t紐付け\t案件\t',
    '建物形状\t紐づけ\t建物形状\t',
    '設計担当\tプルダウン\t\t（仮）',
    '確認番号\t数値\t\t※後ろに単位「号」',
    '確認済証交付者\tプルダウン\t\t第一機関',
    '\t\t\t第二機関'
  ].join('\n');
  const r=T.parseSpec(paste);
  const by=l=>r.items.find(i=>i.label===l);

  // The old fallback assumed ラベル/型/必須/選択肢 and read 紐づけ先 as 必須,
  // which cost every link row its target.
  check('the 紐づけ先 column is found by content, not by position', ()=>{
    assert.strictEqual(r.col.target,2,'target col='+r.col.target);
    assert.strictEqual(r.col.options,3,'options col='+r.col.options);
    assert.strictEqual(r.col.required,undefined,'a target column was mistaken for 必須');
    assert.strictEqual(by('工事担当').target,'案件');
    assert.strictEqual(by('建物形状').target,'建物形状');
  });

  check('a headerless spec still reads choices, remarks and continuations', ()=>{
    assert.deepStrictEqual(by('確認済証交付者').options,['第一機関','第二機関']);
    assert.strictEqual(by('確認番号').unitPostfix,'号');
    assert.deepStrictEqual(by('設計担当').options,['（仮）']);
    assert.ok(!by('依頼書ID'),'a システム項目 row was queued');
  });

  check('a headerless 必須 column is still recognised when there is no target', ()=>{
    const old=T.parseSpec('テキスト\t担当者名\t○\nプルダウン\t状態\t\t未対応,完了\n');
    assert.strictEqual(old.col.required,2,'required col='+old.col.required);
    assert.strictEqual(old.col.options,3,'options col='+old.col.options);
    assert.strictEqual(old.items[0].required,true);
    assert.deepStrictEqual(old.items[1].options,['未対応','完了']);
  });

  check('a pulldown with no choices says what to write instead', ()=>{
    const e=T.parseSpec('改良の有無\tプルダウン\t\t\n').errors[0];
    assert.ok(/（仮）/.test(e),e);
  });
}

console.log('\n=== an unsaved edit on the screen is called out ===');
{
  check('a captured template carrying item defs warns that they were committed', ()=>{
    const logged=[];
    const el=document.getElementById('elt-log');
    const before=el.appendChild;
    el.appendChild=function(n){ logged.push(n.textContent); return before.call(this,n); };
    T.captureForTest('https://gw.example/sheet-fs/v1/design/layout/'+SHEET+'/part',{},
      JSON.stringify({tenantLayout:{[SHEET]:{pc:{sheetDefs:{itemDefs:{}}}}},
                      sheetDefs:[{itemDefs:{'appextender.x.type_text9':{itemId:null}}}]}));
    el.appendChild=before;
    assert.ok(logged.some(t=>/未保存の項目が 1 件/.test(t)),logged.join(' | '));
  });
}

console.log('\n=== every spec row is accounted for in the dry run ===');
{
  check('rejected rows are returned with their line, label and reason', ()=>{
    const r=T.parseSpec(['契約支店\t紐付け参照\t案件',
                         '工事担当\t紐付け\t',
                         '改良の有無\tプルダウン\t\t',
                         '物件名\tテキスト\t\t'].join('\n'));
    assert.strictEqual(r.items.length,1,'the good row should survive its neighbours');
    assert.strictEqual(r.items[0].label,'物件名');
    assert.deepStrictEqual(r.errorRows.map(e=>[e.line,e.label]),
      [[1,'契約支店'],[2,'工事担当'],[3,'改良の有無']]);
    assert.strictEqual(r.errorRows.length,r.errors.length,'errorRows and errors disagree');
    r.errorRows.forEach(e=>{
      assert.ok(e.reason,'no reason for '+e.label);
      assert.ok(r.errors.some(t=>t.indexOf(e.label)>=0),'no sentence for '+e.label);
    });
  });

  const src=require('fs').readFileSync(__dirname+'/../esm-layout-tool.js','utf8');
  check('the dry run table is built from adds, skips and rejects together', ()=>{
    const dry=src.slice(src.indexOf('async function doDry'),src.indexOf('$(\'elt-dry\')'));
    assert.ok(/S\.plan\.add\.map/.test(dry)&&/S\.plan\.skip\.map/.test(dry)&&/errRows\.map/.test(dry),
      'the preview table does not draw all three outcomes');
    assert.ok(/sort\(/.test(dry),'the table is not put back into spec order');
    assert.ok(/追加不可/.test(dry),'rejected rows are not labelled in the table');
  });

  check('a spec with some bad rows still runs the good ones', ()=>{
    const parse=src.slice(src.indexOf('function doParse'),src.indexOf('$(\'elt-parse\')'));
    assert.ok(!/r\.errors\.length === 0/.test(parse),
      'doParse still refuses the whole spec when any single row is bad');
    assert.ok(/if \(!r\.items\.length\)/.test(parse),'doParse no longer checks for an empty spec');
    assert.ok(/中止/.test(parse),'doParse can still stop without saying why');
  });
}
