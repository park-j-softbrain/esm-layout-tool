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
    assert.strictEqual(r.typeCol,0,'typeCol='+r.typeCol);
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
    assert.strictEqual(r.typeCol,1,'typeCol='+r.typeCol);
    assert.strictEqual(r.errors.length,0,r.errors.join('; '));
    assert.strictEqual(r.items[0].label,'担当者名');
  });
  check('rejects 演算/紐づけ with an explanation', ()=>{
    const r=T.parseSpec(fs2.readFileSync(__dirname+'/../sample-unsupported.tsv','utf8'));
    assert.strictEqual(r.items.length,0);
    assert.strictEqual(r.errors.length,3,r.errors.join('; '));
    assert.ok(r.errors.every(e=>/追加できません/.test(e)),r.errors.join('; '));
    assert.ok(/計算式/.test(r.errors[0]));
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
  check('an ambiguous 保存 button is refused rather than guessed', ()=>{
    assert.ok(/hit\.length > 1\)\s*return null/.test(src),
      'multiple matching 保存 buttons must return null so the operator presses it');
  });
}

Promise.all(pending).then(()=>{
  console.log('\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
});
