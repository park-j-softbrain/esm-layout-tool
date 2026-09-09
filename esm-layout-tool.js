/*!
 * esm-layout-tool v0.1
 * Bulk-adds items (項目) to an eSM sheet layout from a pasted Excel/TSV spec.
 *
 * Usage: open the sheet's item-edit page, F12 -> Console, paste this whole file, Enter.
 * A panel appears at the top-right. Follow the steps in it.
 *
 * Design note: this tool does NOT synthesise the save payload from scratch. It captures
 * the PUT that eSM itself sends when you press 保存, and uses that as the template.
 * Only `sheetDefs[0].itemDefs` and the two layout maps are modified; everything else
 * (auth headers, tenant id, authority, admin settings) is passed through untouched.
 */
(() => {
  'use strict';
  const VERSION = 'esm-layout-tool v0.1';

  if (window.__esmLayoutTool) { window.__esmLayoutTool.show(); return; }

  /* ------------------------------------------------------------------ *
   * Type table.
   * Derived from GET /sheet-fs/v1/design/{sheetId} on a sheet containing
   * one field of every palette type.
   *   verified: a create-payload for this type was observed in a HAR.
   *   inferred: shape taken from an existing (already-created) field.
   * ------------------------------------------------------------------ */
  const P = () => ({ readOnly: false, hideProperty: false });
  const TYPES = {
    'テキスト':          { prefix: 'type_text',              itemType: 'STRING',            def: 'StringItemTypeDef',           verified: true,  emptyValue: '' },
    'テキスト（複数行）': { prefix: 'type_textarea',          itemType: 'MEMO',              def: 'MemoItemTypeDef',             verified: true, emptyValue: '' },
    'プルダウン':        { prefix: 'type_pulldown',          itemType: 'SELECT',            def: 'SelectItemTypeDef',           verified: true,  select: 'dropdown' },
    'ラジオボタン':      { prefix: 'type_radio_button',      itemType: 'SELECT',            def: 'SelectItemTypeDef',           verified: true, select: 'radio' },
    'チェックボックス':  { prefix: 'type_checkbox',          itemType: 'SELECT',            def: 'SelectItemTypeDef',           verified: true, select: 'checkbox', multi: true },
    '数値':              { prefix: 'type_number',            itemType: 'NUMBER',            def: 'NumberItemTypeDef',           verified: true },
    '日付':              { prefix: 'type_date',              itemType: 'DATE',              def: 'DateItemTypeDef',             verified: true },
    '時間':              { prefix: 'type_time',              itemType: 'TIME',              def: 'TimeItemTypeDef',             verified: true },
    '日時':              { prefix: 'type_datetime',          itemType: 'DATETIME',          def: 'DateTimeItemTypeDef',         verified: true },
    'ファイル':          { prefix: 'type_file',              itemType: 'FILE',              def: 'FileItemTypeDef',             verified: true },
    'リンク':            { prefix: 'type_link',              itemType: 'URL',               def: 'URLItemTypeDef',              verified: true },
    '電話番号':          { prefix: 'type_telno',             itemType: 'TELNO',             def: 'TelNoItemTypeDef',            verified: true },
    '住所':              { prefix: 'type_address',           itemType: 'ADDRESS',           def: 'AddressItemTypeDef',          verified: true },
    'メールアドレス':    { prefix: 'type_email',             itemType: 'EMAIL',             def: 'EmailItemTypeDef',            verified: true },
    '見出し':            { prefix: 'type_title',             itemType: 'SECTION',           def: 'SectionItemTypeDef',          verified: false }
  };
  // Aliases so the spec sheet can use ASCII or sloppy variants.
  const ALIAS = {
    'text': 'テキスト', 'string': 'テキスト', 'テキスト(複数行)': 'テキスト（複数行）',
    'textarea': 'テキスト（複数行）', 'memo': 'テキスト（複数行）', 'メモ': 'テキスト（複数行）',
    'pulldown': 'プルダウン', 'select': 'プルダウン', 'ドロップダウン': 'プルダウン',
    'radio': 'ラジオボタン', 'checkbox': 'チェックボックス',
    'number': '数値', 'date': '日付', 'time': '時間', 'datetime': '日時',
    'file': 'ファイル', 'link': 'リンク', 'url': 'リンク',
    'tel': '電話番号', 'telno': '電話番号', 'address': '住所',
    'email': 'メールアドレス', 'mail': 'メールアドレス',
    'section': '見出し', 'heading': '見出し', 'title': '見出し'
  };
  // Types that cannot be created from a name alone. Each needs a reference to
  // other items or sheets that a two-column spec does not carry.
  const UNSUPPORTED = {
    '演算（文字）': '計算式が必要です (defaultValue.ref に式と参照項目を指定)',
    '演算（数値）': '計算式が必要です (defaultValue.ref に式と参照項目を指定)',
    '紐づけ項目': '参照先シートの指定が必要です (SB_RELATION)'
  };
  const UNSUP_ALIAS = { '演算(文字)': '演算（文字）', '演算(数値)': '演算（数値）', '紐付け項目': '紐づけ項目', '紐づけ': '紐づけ項目' };
  const unsupportedName = (raw) => {
    const t = String(raw || '').trim();
    if (UNSUPPORTED[t]) return t;
    if (UNSUP_ALIAS[t] && UNSUPPORTED[UNSUP_ALIAS[t]]) return UNSUP_ALIAS[t];
    return null;
  };

  const resolveType = (raw) => {
    const t = String(raw || '').trim();
    if (TYPES[t]) return t;
    const a = ALIAS[t.toLowerCase()] || ALIAS[t];
    return TYPES[a] ? a : null;
  };
  const TRUEY = ['1', 'true', 'yes', 'y', '○', '◯', '〇', 'はい', '必須', 'true'];
  const isTrue = (v) => TRUEY.includes(String(v || '').trim().toLowerCase());

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const S = {
    tpl: null,        // captured PUT: {url, headers, body(parsed)}
    design: null,     // GET /design/{sheetName} response
    spec: [],         // parsed rows
    plan: null,       // computed additions
    sheetName: null
  };

  const log = (msg, cls) => {
    const el = document.getElementById('elt-log');
    if (!el) return;
    const d = document.createElement('div');
    if (cls) d.className = 'elt-' + cls;
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
    console.log('[esm-layout-tool]', msg);
  };

  /* ------------------------------------------------------------------ *
   * 1. Capture the app's own save request (XHR + fetch)
   * ------------------------------------------------------------------ */
  const isSaveUrl = (u) => /\/design\/layout\/[^/?#]+\/part(\?|$)/.test(String(u || ''));

  function capture(url, headers, bodyText) {
    try {
      const body = JSON.parse(bodyText);
      S.tpl = { url: new URL(url, location.href).href, headers: headers || {}, body };
      S.sheetName = Object.keys(body.tenantLayout || {})[0] || null;
      log('保存リクエストを取得しました。sheet=' + S.sheetName, 'ok');
      log('  通信方式: ' + (S.profile ? ('withCredentials=' + S.profile.withCredentials +
          ' / headers=' + Object.keys(S.profile.headers).filter((k) => !SKIP_HEADERS.test(k)).join(',')) : '不明'));
      log('  itemDefs(送信分)=' + Object.keys(((body.sheetDefs || [])[0] || {}).itemDefs || {}).length +
          ' / レイアウト項目=' + Object.keys(layoutItemDefs(body) || {}).length);
      refresh();
      if (S.onCapture) { const f = S.onCapture; S.onCapture = null; try { f(); } catch (e) {} }
      // Give the save a moment to commit before reading the item list back.
      setTimeout(() => {
        loadDesign().catch((e) => {
          log('項目一覧の取得に失敗: ' + e.message, 'err');
          log('※ 既存項目名との重複チェックができません。ドライランの結果を必ず目視で確認してください。', 'err');
          refresh();
        });
      }, 800);
    } catch (e) {
      log('保存リクエストの解析に失敗: ' + e.message, 'err');
    }
  }

  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  const oSetH = XMLHttpRequest.prototype.setRequestHeader;
  const isApiUrl = (u) => /\/sheet-fs\/v1\//.test(String(u || ''));

  // How the app itself talks to the gateway. Auth is not visible to us (Chrome
  // strips cookie/authorization from HAR exports and we never read cookies), so
  // we copy the request shape verbatim instead of guessing at it.
  function noteProfile(headers, withCredentials) {
    S.profile = { headers: headers || {}, withCredentials: !!withCredentials };
  }

  XMLHttpRequest.prototype.open = function (m, u) {
    if (isApiUrl(u)) { this.__eltM = m; this.__eltU = u; this.__eltH = {}; }
    return oOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__eltH) this.__eltH[k] = v; } catch (e) {}
    return oSetH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      if (this.__eltU) noteProfile(this.__eltH, this.withCredentials);
      if (String(this.__eltM).toUpperCase() === 'PUT' && isSaveUrl(this.__eltU) && typeof b === 'string') capture(this.__eltU, this.__eltH, b);
    } catch (e) {}
    return oSend.apply(this, arguments);
  };

  const oFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const body = init && init.body;
      if (isApiUrl(url)) {
        const h = {};
        const hh = (init && init.headers) || {};
        if (hh && typeof hh.forEach === 'function') hh.forEach((v, k) => { h[k] = v; });
        else Object.keys(hh).forEach((k) => { h[k] = hh[k]; });
        noteProfile(h, String((init && init.credentials) || 'same-origin') === 'include');
        if (method === 'PUT' && isSaveUrl(url) && typeof body === 'string') capture(url, h, body);
      }
    } catch (e) {}
    return oFetch.apply(this === undefined || this === null ? window : this, arguments);
  };

  // Prefer the page footer's primary button, so an open modal's own 保存 is
  // never the one we press.
  function findSaveButton() {
    const ordered = ['[data-test-id="detail-footer"] button.modify-btn',
                     '.sb-footer button.modify-btn',
                     '[data-test-id="detail-footer"] button',
                     '.sb-footer button'];
    for (let i = 0; i < ordered.length; i++) {
      const hit = Array.from(document.querySelectorAll(ordered[i])).filter((b) => b.textContent.trim() === '保存');
      if (hit.length === 1) return hit[0];
      if (hit.length > 1) return null;   // ambiguous: make the operator press it
    }
    return null;
  }

  function autoCapture(timeout) {
    if (S.tpl) return Promise.resolve();
    const btn = findSaveButton();
    if (!btn) return Promise.reject(new Error('保存ボタンが見つかりません。画面上で「保存」を手で押してください。'));
    // Pressing 保存 commits whatever is currently pending on the screen. On a
    // freshly opened page that is nothing, but we must not decide that for the
    // operator in a customer environment.
    if (!confirm('画面の「保存」を1回押します。\n\n' +
                 '画面上に未保存の編集が残っている場合、それも一緒に保存されます。\n' +
                 '項目編集画面を開いた直後で、まだ何も変更していないことを確認してください。\n\n' +
                 '続行しますか？')) {
      return Promise.reject(new Error('中止しました。'));
    }
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      S.onCapture = resolve;
      log('「保存」を押して保存リクエストを取得しています…');
      btn.click();
      const iv = setInterval(() => {
        if (S.tpl) { clearInterval(iv); }
        else if (Date.now() - t0 > (timeout || 12000)) {
          clearInterval(iv); S.onCapture = null;
          reject(new Error('保存リクエストを取得できませんでした。画面上で「保存」を手で押してください。'));
        }
      }, 200);
    });
  }

  function waitForDesign(timeout) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        if (S.design || Date.now() - t0 > (timeout || 10000)) { clearInterval(iv); resolve(!!S.design); }
      }, 200);
    });
  }

  /* ------------------------------------------------------------------ *
   * Payload helpers
   * ------------------------------------------------------------------ */
  const layoutRoot = (body) => (((body.tenantLayout || {})[S.sheetName] || {}).pc || {}).sheetDefs || {};
  const layoutItemDefs = (body) => layoutRoot(body).itemDefs || {};
  const layoutPlacement = (body) => ((layoutRoot(body).sheetTypeDefs || [])[0] || {}).itemDefs || {};
  const apiBase = () => S.tpl.url.split('/design/layout/')[0];

  const SKIP_HEADERS = /^(content-length|host|origin|referer|connection|cookie|user-agent|accept-encoding|sec-|:)/i;

  function rawRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      const prof = S.profile || { headers: {}, withCredentials: false };
      const x = new XMLHttpRequest();
      oOpen.call(x, method, url, true);
      try { x.withCredentials = !!prof.withCredentials; } catch (e) {}
      // XHR appends when the same header is set twice ("application/json,
      // application/json"), which the gateway rejects with a 500. Deduplicate
      // case-insensitively and set each header exactly once.
      const hdrs = {};
      Object.keys(prof.headers).forEach((k) => {
        if (SKIP_HEADERS.test(k)) return;
        hdrs[String(k).toLowerCase()] = prof.headers[k];
      });
      if (body != null) hdrs['content-type'] = 'application/json';
      else delete hdrs['content-type'];
      Object.keys(hdrs).forEach((k) => { try { oSetH.call(x, k, hdrs[k]); } catch (e) {} });
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) {
          try { resolve(x.responseText ? JSON.parse(x.responseText) : null); } catch (e) { resolve(null); }
        } else {
          reject(new Error('HTTP ' + x.status + ' ' + String(x.responseText || '').slice(0, 200)));
        }
      };
      x.onerror = () => reject(new Error('NETWORK'));
      oSend.call(x, body == null ? null : body);
    });
  }

  // Never retry. A network/CORS failure does not tell us whether the server
  // processed the request, so re-sending a PUT could create the items twice.
  // One request, one attempt; the operator decides what to do about a failure.
  S.sent = 0;
  async function request(method, url, body) {
    S.sent++;
    try {
      return await rawRequest(method, url, body);
    } catch (e) {
      throw new Error(e.message === 'NETWORK'
        ? 'ネットワーク/CORS エラー: ' + method + ' ' + url + ' に到達できません'
        : e.message);
    }
  }

  function req(path, opts) {
    const method = (opts && opts.method) || 'GET';   // headers come from the captured profile
    return request(method, apiBase() + path, (opts && opts.body) || null)
      .catch((e) => { throw new Error(path + ' -> ' + e.message); });
  }

  // Remember the sheet's timestamp at the moment our baseline was taken. The
  // concurrent-edit check compares against THIS, not against a freshly fetched
  // value (comparing the current value with itself always says "unchanged").
  async function loadState() {
    const st = await req('/sheetdef/state/' + encodeURIComponent(S.sheetName));
    S.baselineUpdatedAt = st && st.updatedAt;
    return S.baselineUpdatedAt;
  }

  async function loadDesign() {
    S.design = await req('/design/' + encodeURIComponent(S.sheetName) + '?checkAuthorization=false');
    const n = Object.keys(existingDefs()).length;
    await loadState().catch(() => { S.baselineUpdatedAt = null; });
    log('既存項目 ' + n + ' 件を取得しました。(基準時刻 ' + (S.baselineUpdatedAt || '取得失敗') + ')', 'ok');
    refresh();
  }

  function existingDefs() {
    // The design response nests itemDefs; take the largest map containing type_ keys.
    let best = {};
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.itemDefs && typeof o.itemDefs === 'object' && Object.keys(o.itemDefs).length > Object.keys(best).length) {
        const ks = Object.keys(o.itemDefs);
        if (ks.some((k) => k.indexOf('.') > -1)) best = o.itemDefs;
      }
      Object.values(o).forEach((v) => { if (v && typeof v === 'object') walk(v); });
    };
    walk(S.design || {});
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 2. Parse the pasted TSV spec
   * Columns: ラベル / 型 / 必須 / 選択肢 / 幅 / 説明   (header row optional)
   * ------------------------------------------------------------------ */
  // Excel puts TABs on the clipboard, but specs also arrive as CSV or as text
  // pasted out of a document. Detect the delimiter per paste instead of demanding one.
  function splitLine(line, delim) {
    if (delim === '\t') return line.split('\t');
    if (delim === ',') {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') q = false;
          else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out;
    }
    return line.split(/\s{2,}|\u3000+/);   // 2+ spaces, or full-width spaces
  }

  function detectDelimiter(lines) {
    const has = (d) => lines.filter((l) => splitLine(l, d).length >= 2).length;
    if (has('\t') >= Math.ceil(lines.length / 2)) return '\t';
    if (has(',') >= Math.ceil(lines.length / 2)) return ',';
    return ' ';
  }

  function parseSpec(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
    const delim = detectDelimiter(lines);
    const rows = lines.map((l) => splitLine(l, delim).map((c) => String(c).trim())).filter((r) => r.some((c) => c !== ''));
    if (!rows.length) return { items: [], errors: [], typeCol: 1, delim: delim };
    const head = rows[0].map((c) => String(c).trim());
    const looksHeader = /ラベル|項目名|項目名称|項目種別|項目タイプ|型|種別|label|name|type/i.test(head[0] || '') &&
                        !resolveType(head[0]) && !unsupportedName(head[0]);
    const body = looksHeader ? rows.slice(1) : rows;

    // The spec sheet may be "型 / 名前" or "名前 / 型" — decide by which of the
    // first two columns actually looks like a type name.
    const score = (c) => body.reduce((n, r) => n + ((resolveType(r[c]) || unsupportedName(r[c])) ? 1 : 0), 0);
    const typeCol = score(0) > score(1) ? 0 : 1;
    const labelCol = typeCol === 0 ? 1 : 0;

    const items = [], errors = [];
    body.forEach((r, i) => {
      const line = (looksHeader ? i + 2 : i + 1);
      const label = String(r[labelCol] || '').trim();
      const rawType = String(r[typeCol] || '').trim();
      if (!label) { errors.push('行' + line + ': 項目名が空です'); return; }
      const bad = unsupportedName(rawType);
      if (bad) { errors.push('行' + line + ': 「' + label + '」の型 ' + bad + ' はこのツールでは追加できません — ' + UNSUPPORTED[bad] + '。手動で追加してください'); return; }
      const type = resolveType(rawType);
      if (!type) { errors.push('行' + line + ': 型「' + rawType + '」は未対応です'); return; }
      const opts = String(r[3] || '').split(/[,、\n]/).map((s) => s.trim()).filter(Boolean);
      if (TYPES[type].itemType === 'SELECT' && !opts.length) { errors.push('行' + line + ': 「' + label + '」は選択肢が必要です'); return; }
      const span = parseInt(String(r[4] || '1').trim(), 10);
      items.push({
        line, label, type,
        required: isTrue(r[2]),
        options: opts,
        span: (span === 2 ? 2 : 1),
        explanation: String(r[5] || '').trim()
      });
    });
    return { items, errors, typeCol, delim: delim };
  }

  /* ------------------------------------------------------------------ *
   * 3. Plan
   * ------------------------------------------------------------------ */
  function buildPlan() {
    const defs = existingDefs();
    const layoutDefs = layoutItemDefs(S.tpl.body);
    const place = layoutPlacement(S.tpl.body);

    // The captured template is newer than the /design snapshot: it contains the
    // item the operator just added by hand, which the server may not have
    // committed when we fetched the item list. Merge both sources or we would
    // reuse that item's itemOrder and miss it in the duplicate check.
    const tplDefs = ((S.tpl.body.sheetDefs || [])[0] || {}).itemDefs || {};
    const allDefs = Object.assign({}, defs, tplDefs);

    const existingLabels = new Set(Object.values(allDefs).map((d) => String((d && d.labelName) || '').trim()).filter(Boolean));
    const usedKeys = new Set(Object.keys(allDefs).concat(Object.keys(layoutDefs)));

    let maxItemOrder = 0;
    Object.values(allDefs).forEach((d) => { if (d && typeof d.itemOrder === 'number') maxItemOrder = Math.max(maxItemOrder, d.itemOrder); });
    // `order` is a sparse grid position (observed: 1,3,5,11,12,15,...,51) and each
    // item occupies `displaySpan` cells. Inserting mid-layout renumbers every
    // following item; the exact arithmetic is not established, so we only ever
    // append past the end and never touch an existing item's order.
    let maxOrder = 0;
    Object.values(place).forEach((p) => {
      if (p && typeof p.order === 'number') maxOrder = Math.max(maxOrder, p.order + (p.displaySpan || 1));
    });
    const ORDER_GAP = 4;   // leave a clear row boundary after the existing layout

    const nextIndex = (prefix) => {
      let n = 0;
      usedKeys.forEach((k) => {
        const m = k.match(new RegExp('\\.' + prefix + '(\\d+)$'));
        if (m) n = Math.max(n, parseInt(m[1], 10));
      });
      return n + 1;
    };
    const counters = {};

    const add = [], skip = [];
    S.spec.forEach((it) => {
      if (existingLabels.has(it.label)) { skip.push(Object.assign({ reason: '同名の項目が既に存在' }, it)); return; }
      const T = TYPES[it.type];
      if (!(it.type in counters)) counters[it.type] = nextIndex(T.prefix);
      const key = 'appextender.' + S.sheetName + '.' + T.prefix + (counters[it.type]++);
      usedKeys.add(key);
      existingLabels.add(it.label);
      maxOrder += ORDER_GAP;
      add.push(Object.assign({ key, itemOrder: ++maxItemOrder, order: maxOrder }, it));
    });
    return { add, skip };
  }

  function makeItemDef(a) {
    const T = TYPES[a.type];
    const td = { '@type': T.def };
    if (T.itemType === 'SELECT') {
      td.options = a.options.map((label, i) => ({ label, code: -(i + 1), order: i + 2, isEnabled: true, typeInfo: null }));
      td.defaultSelected = [];
      td.isMultiSelect = !!T.multi;
    } else if (T.def === 'StringItemTypeDef' || T.def === 'MemoItemTypeDef') {
      Object.assign(td, { validator: null, allowHalfWidthNumeric: false, allowHalfWidthAlphabet: false, allowFullWidth: false, asPassword: false, isNameItem: false });
    } else if (T.def === 'NumberItemTypeDef') {
      // `sum` is an int, not a bool, and the unit fields are null rather than "".
      // Sending a boolean here is rejected by the gateway as a generic HTTP 500.
      Object.assign(td, { decimalDigit: 0, unitPrefix: null, unitPostfix: null, sum: 0, validScale: true });
    } else if (T.def === 'URLItemTypeDef') {
      Object.assign(td, { displayText: '', isFixedDefault: false });
    } else if (T.def === 'FileItemTypeDef') {
      td.isMultiSelectable = false;
    } else {
      td.messages = null;
    }
    const blank = (T.emptyValue !== undefined) ? T.emptyValue : null;
    return {
      itemId: null,
      isSheetReferenceItemDef: true,
      isKey: false,
      isRequired: !!a.required,
      labelName: a.label,
      defaultValue: { ref: '', value: blank, applyValue: 'none', options: {}, reference: null },
      isDisabled: false,
      isEditable: true,
      itemOrder: a.itemOrder,
      isMaster: false,
      isDefault: false,
      explanation: a.explanation || '',
      difference: null,
      authority: null,
      preSheetItemDefInfo: null,
      isName: false,
      itemType: T.itemType,
      itemTypeDef: td,
      isKeywordSearchItem: false
    };
  }

  // Prefer cloning the layout property-block of an existing field of the same
  // type; fall back to a generic block if the sheet has none.
  function donorFor(type) {
    const T = TYPES[type];
    const defs = layoutItemDefs(S.tpl.body);
    return Object.keys(defs).find((k) => new RegExp('\\.' + T.prefix + '\\d+$').test(k)) || null;
  }

  function makeLayoutEntry(a) {
    const T = TYPES[a.type];
    const defs = layoutItemDefs(S.tpl.body);
    const donorKey = donorFor(a.type);
    let e;
    if (donorKey) {
      e = JSON.parse(JSON.stringify(defs[donorKey]));
    } else {
      e = {
        label: P(), required: P(), editable: P(), disabled: P(), explanation: P(),
        defaultValue: { readOnly: false, hideProperty: true },
        difference: { enable: false, increaseLabel: '前進', increaseColor: '#DBF8E6', decreaseLabel: '後退', decreaseColor: '#FFDDDF', hideProperty: false, readOnly: false },
        authority: P(), matrixSetting: P(),
        copied: { copied: true, readOnly: false, hideProperty: false },
        itemTypeDef: {}
      };
    }
    if (T.itemType === 'SELECT') {
      e.itemTypeDef = Object.assign({}, e.itemTypeDef, { selectDisplayType: T.select, choices: P() });
    }
    return { entry: e, donor: donorKey || null };
  }

  function buildPayload(list) {
    const adds = list || S.plan.add;
    const body = JSON.parse(JSON.stringify(S.tpl.body));
    const sd = body.sheetDefs[0];
    sd.itemDefs = {};                       // /part is a partial update: send only the new defs
    const lDefs = layoutItemDefs(body);
    const place = layoutPlacement(body);
    adds.forEach((a) => {
      sd.itemDefs[a.key] = makeItemDef(a);
      lDefs[a.key] = makeLayoutEntry(a).entry;
      place[a.key] = { order: a.order, displaySpan: a.span };
    });
    body.deleteItemKeys = [];

    // Safety: the only existing entries we may have touched are the ones we added.
    const beforePlace = layoutPlacement(S.tpl.body);
    const afterPlace = layoutPlacement(body);
    const changed = Object.keys(beforePlace).filter((k) => JSON.stringify(beforePlace[k]) !== JSON.stringify(afterPlace[k]));
    if (changed.length) throw new Error('内部エラー: 既存項目の配置を変更しようとしました (' + changed.join(', ') + ')');
    return body;
  }

  /* ------------------------------------------------------------------ *
   * 4. Apply
   * ------------------------------------------------------------------ */
  function download(name, obj) {
    const b = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // One transaction, one PUT. Returns nothing on success, throws on failure.
  async function writeBatch(adds) {
    const payload = buildPayload(adds);
    await req('/transaction/doBegin', { method: 'POST' });
    try {
      await request('PUT', S.tpl.url, JSON.stringify(payload));
    } catch (e) {
      // doCommit is what persists; not reaching it leaves nothing committed.
      throw e;
    }
    await req('/transaction/doCommit', { method: 'POST' });
    S.tpl.body = payload;          // roll the baseline forward
    await loadState().catch(() => { S.baselineUpdatedAt = null; });
  }

  // Applies each item in its own transaction and reports which types the server
  // accepts. Slower, but a rejected item no longer takes the whole batch with it.
  async function applyOneByOne() {
    if (!S.plan || !S.plan.add.length) { log('追加対象がありません。', 'err'); return; }
    if (!preflight()) return;
    const adds = S.plan.add.slice();
    if (!confirm(adds.length + ' 件を1件ずつ追加します。\n失敗した項目はスキップして続行します。\n\nよろしいですか？')) return;

    try {
      if (!S.baselineUpdatedAt) throw new Error('基準時刻が未取得です');
      const chk = await req('/sheetdef/state/isUpdated', {
        method: 'POST',
        body: JSON.stringify([{ sheetName: S.sheetName, localUpdatedAt: S.baselineUpdatedAt }])
      });
      if (chk && chk[0] && chk[0].isUpdated) { log('中止: 他の人がこのシートを更新しています。', 'err'); return; }
      log('排他チェック OK', 'ok');
    } catch (e) {
      log('中止: 排他チェックに失敗しました: ' + e.message, 'err');
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    download('esm-layout-before-' + S.sheetName + '-' + stamp + '.json', { capturedSave: S.tpl.body, design: S.design });

    const ok = [], ng = [];
    for (let i = 0; i < adds.length; i++) {
      const a = adds[i];
      log('(' + (i + 1) + '/' + adds.length + ') ' + a.label + ' [' + a.type + '] …');
      try {
        await writeBatch([a]);
        ok.push(a);
        log('   OK', 'ok');
      } catch (e) {
        ng.push({ item: a, error: e.message });
        log('   NG ' + e.message, 'err');
      }
    }
    S.plan = { add: [], skip: S.plan.skip };
    const lines = ['=== ' + VERSION + ' 1件ずつ実行 結果 ===', 'sheet: ' + S.sheetName, ''];
    ok.forEach((a) => lines.push('OK  ' + a.type + '  ' + a.label));
    ng.forEach((x) => lines.push('NG  ' + x.item.type + '  ' + x.item.label + '  -- ' + x.error.slice(0, 160)));
    const t = lines.join('\n');
    log('成功 ' + ok.length + ' 件 / 失敗 ' + ng.length + ' 件', ng.length ? 'err' : 'ok');
    if (ng.length) {
      log('貼り付けた項目リストはそのまま残しています。原因を直してもう一度実行すると、', 'ok');
      log('追加済みの項目は自動でスキップされ、失敗した分だけが再試行されます。', 'ok');
    }
    log(t);
    try { navigator.clipboard.writeText(t); log('(結果をクリップボードにコピーしました)', 'ok'); } catch (e) {}
    loadDesign().catch(() => {});
    refresh();
  }

  // The sheet id in the URL must still match the captured template.
  function sheetMatchesPage() {
    const m = String(location.pathname).match(/\/(sheet_[0-9]+)\//);
    if (!m || !S.sheetName) return true;          // unknown URL shape: don't block
    return m[1] === S.sheetName;
  }

  function preflight() {
    if (!sheetMatchesPage()) {
      log('中止: 画面のシートと取得済みの保存リクエストが一致しません。', 'err');
      log('  画面: ' + location.pathname + ' / 取得済み: ' + S.sheetName, 'err');
      log('  画面を再読み込みしてから、もう一度実行してください。', 'err');
      return false;
    }
    if (!S.design) { log('中止: 既存項目一覧を取得できていません。「項目一覧を再取得」を押してください。', 'err'); return false; }
    return true;
  }

  async function apply() {
    if (!S.plan || !S.plan.add.length) { log('追加対象がありません。', 'err'); return; }
    // itemOrder allocation and the duplicate check both need the real item list.
    // Without it we would restart numbering from 1 and collide with existing items.
    if (!preflight()) return;
    const n = S.plan.add.length;
    if (n > 50 && !confirm(n + ' 件を1回のリクエストで追加しようとしています。\n' +
        '件数が多い場合は分けて実行することをおすすめします。\n\nこのまま続行しますか？')) return;
    if (!confirm(n + ' 件の項目を追加します。よろしいですか？\n(事前に現在の状態を .json で保存します)')) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    download('esm-layout-before-' + S.sheetName + '-' + stamp + '.json', { capturedSave: S.tpl.body, design: S.design });
    log('現在の状態を保存しました (ダウンロードフォルダ)。', 'ok');

    try {
      if (!S.baselineUpdatedAt) throw new Error('基準時刻が未取得です');
      const chk = await req('/sheetdef/state/isUpdated', {
        method: 'POST',
        body: JSON.stringify([{ sheetName: S.sheetName, localUpdatedAt: S.baselineUpdatedAt }])
      });
      if (chk && chk[0] && chk[0].isUpdated) {
        log('中止: 基準時刻(' + S.baselineUpdatedAt + ')以降に他の人がこのシートを更新しています。', 'err');
        log('画面を再読み込みしてやり直してください。', 'err');
        return;
      }
      log('排他チェック OK (基準時刻 ' + S.baselineUpdatedAt + ')', 'ok');
    } catch (e) {
      // Not skippable: our PUT replays the entire layout, so writing without
      // this check risks silently discarding someone else's concurrent edit.
      log('中止: 排他チェックに失敗しました: ' + e.message, 'err');
      log('画面を再読み込みしてやり直してください。解消しない場合は担当者に連絡してください。', 'err');
      return;
    }

    let began = false;
    try {
      began = true;
      log('トランザクション開始');
      await writeBatch(S.plan.add);
      log('完了: ' + n + ' 件を追加しました。', 'ok');
      report();
      S.plan = null;
      S.spec = [];
      $('elt-tsv').value = '';
      try { localStorage.removeItem('elt-spec'); } catch (e) {}
      $('elt-preview').innerHTML = '';
      loadDesign().catch(() => log('項目一覧の再取得に失敗しました。次の実行前に「項目一覧を再取得」を押してください。', 'err'));
      log('続けて次の項目リストを貼り付けて実行できます。', 'ok');
      refresh();
    } catch (e) {
      log('失敗: ' + e.message, 'err');
      log('※ どの項目が原因か切り分けるには「1件ずつ実行」を使ってください。', 'err');
      // There is no rollback endpoint (/transaction/doRollback returns 404).
      // doCommit is what persists the write, so not reaching it IS the rollback.
      if (began) log('doCommit を呼んでいないため、この変更は確定していません。', 'ok');
      log('画面を再読み込みし、項目が増えていないことを確認してください。', 'ok');
      log('増えている場合は、保存した .json を担当者に送ってください。', 'err');
    }
  }

  function report() {
    const lines = ['=== ' + VERSION + ' 実行結果 ===', 'sheet: ' + S.sheetName, 'time: ' + new Date().toLocaleString('ja-JP'), ''];
    S.plan.add.forEach((a) => lines.push('追加  ' + a.label + '  [' + a.type + ']  ' + a.key));
    S.plan.skip.forEach((s) => lines.push('スキップ ' + s.label + '  (' + s.reason + ')'));
    const t = lines.join('\n');
    log('--- 以下をコピーして担当者に送ってください ---');
    log(t);
    try { navigator.clipboard.writeText(t); log('(クリップボードにコピーしました)', 'ok'); } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * 5. UI
   * ------------------------------------------------------------------ */
  const css = `
  #elt-panel{position:fixed;top:8px;right:8px;width:440px;max-height:94vh;z-index:2147483647;
    background:#1e2430;color:#e6edf3;font:12px/1.5 -apple-system,"Segoe UI",Meiryo,sans-serif;
    border:1px solid #3d4757;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.5);display:flex;flex-direction:column}
  #elt-panel header{padding:8px 10px;background:#2a3242;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center}
  #elt-panel header b{font-size:12px}
  #elt-panel .body{padding:10px;overflow:auto}
  #elt-panel textarea{width:100%;height:120px;box-sizing:border-box;background:#141a24;color:#e6edf3;
    border:1px solid #3d4757;border-radius:4px;padding:6px;font:11px/1.4 Consolas,monospace;resize:vertical}
  #elt-panel button{background:#2f6feb;color:#fff;border:0;border-radius:4px;padding:6px 10px;cursor:pointer;font-size:12px;margin:0 4px 4px 0}
  #elt-panel button:disabled{background:#40485a;color:#8b95a7;cursor:not-allowed}
  #elt-panel button.danger{background:#c0392b}
  #elt-panel .elt-runrow{display:flex;gap:6px;margin-top:6px}
  #elt-panel .elt-runrow button{flex:1;margin:0;padding:9px 6px;font-size:13px;font-weight:bold}
  #elt-panel .elt-runrow button.alt{background:#3d5a80}
  #elt-panel details summary::-webkit-details-marker{color:#8b95a7}
  #elt-log{background:#0d1117;border:1px solid #3d4757;border-radius:4px;padding:6px;height:150px;overflow:auto;
    white-space:pre-wrap;word-break:break-all;font:11px/1.4 Consolas,monospace;margin-top:6px}
  .elt-ok{color:#7ee787}.elt-err{color:#ff7b72}
  #elt-panel table{width:100%;border-collapse:collapse;margin-top:6px;font-size:11px}
  #elt-panel td,#elt-panel th{border-bottom:1px solid #2a3242;padding:2px 4px;text-align:left}
  .elt-warn{color:#e3b341}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'elt-panel';
  panel.innerHTML = `
    <header><b>${VERSION}</b><button id="elt-close" style="background:#40485a;margin:0">閉じる</button></header>
    <div class="body">
      <div style="color:#8b95a7;margin-bottom:4px">
        Excel から <b>型 / 項目名 / 必須 / 選択肢 / 幅 / 説明</b> の列をコピーして貼り付け（型と項目名は順不同）
      </div>
      <textarea id="elt-tsv" placeholder="テキスト&#9;担当者名&#9;○&#10;プルダウン&#9;ステータス&#9;&#9;未対応,対応中,完了"></textarea>
      <div class="elt-runrow">
        <button id="elt-run">一括で実行</button>
        <button id="elt-run-one" class="alt">1件ずつ実行</button>
      </div>
      <div style="color:#8b95a7;margin:4px 0 0">
        どちらも 取得 → 解析 → 確認 → 追加 まで通しで実行します。<br>
        <b>一括</b>: 1トランザクション。全部成功か、全部失敗。<br>
        <b>1件ずつ</b>: 失敗した項目だけ飛ばして続行し、型ごとの成否を報告します。
      </div>
      <div id="elt-status" style="margin-top:6px">状態: 保存リクエスト未取得</div>
      <details style="margin-top:6px">
        <summary style="cursor:pointer;color:#8b95a7">個別操作（うまくいかないとき）</summary>
        <div style="margin-top:6px">
          <button id="elt-capture">保存リクエスト取得</button>
          <button id="elt-parse">解析</button>
          <button id="elt-dry" disabled>ドライラン</button>
          <button id="elt-apply" class="danger" disabled>適用（一括）</button>
          <button id="elt-apply-one" class="danger" disabled>適用（1件ずつ）</button>
          <button id="elt-reload" style="background:#40485a">項目一覧を再取得</button>
        </div>
      </details>
      <div id="elt-preview"></div>
      <div id="elt-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  function restore() {
    try { XMLHttpRequest.prototype.open = oOpen; } catch (e) {}
    try { XMLHttpRequest.prototype.send = oSend; } catch (e) {}
    try { XMLHttpRequest.prototype.setRequestHeader = oSetH; } catch (e) {}
    try { window.fetch = oFetch; } catch (e) {}
    try { panel.remove(); style.remove(); } catch (e) {}
    try { delete window.__esmLayoutTool; delete window.__eltPayload; } catch (e) {}
    console.log('[esm-layout-tool] 終了しました（フックを解除しました）。');
  }
  $('elt-close').onclick = () => {
    if (confirm('ツールを終了します。\n（画面への変更は元に戻し、貼り付けた項目リストは残します）')) restore();
    else panel.style.display = 'none';
  };

  function doParse() {
    const r = parseSpec($('elt-tsv').value);
    S.spec = r.items;
    $('elt-preview').innerHTML = '';
    const dn = { '\t': 'タブ区切り', ',': 'カンマ区切り', ' ': 'スペース区切り' }[r.delim] || r.delim;
    log('形式の判定: ' + dn + ' / ' + (r.typeCol === 0 ? '1列目=型 2列目=項目名' : '1列目=項目名 2列目=型'));
    r.errors.forEach((e) => log(e, 'err'));
    log(r.items.length + ' 行を解析しました。' + (r.errors.length ? ' (' + r.errors.length + ' 行はエラー)' : ''), r.errors.length ? 'err' : 'ok');
    try { localStorage.setItem('elt-spec', $('elt-tsv').value); } catch (e) {}
    refresh();
    return r.items.length > 0 && r.errors.length === 0;
  }
  $('elt-parse').onclick = doParse;

  function doDry() {
    S.plan = buildPlan();
    const rows = S.plan.add.map((a) => `<tr><td>${esc(a.label)}</td><td>${esc(a.type)}${TYPES[a.type].verified ? '' : ' <span class="elt-warn">⚠未検証</span>'}</td><td>${a.required ? '必須' : ''}</td><td style="color:#8b95a7">${esc(a.key.split('.').pop())}</td></tr>`).join('');
    const skips = S.plan.skip.map((s) => `<tr><td colspan="4" style="color:#8b95a7">スキップ: ${esc(s.label)} (${esc(s.reason)})</td></tr>`).join('');
    $('elt-preview').innerHTML = `<table><tr><th>ラベル</th><th>型</th><th></th><th>キー</th></tr>${rows}${skips}</table>`;
    log('ドライラン: 追加 ' + S.plan.add.length + ' 件 / スキップ ' + S.plan.skip.length + ' 件', 'ok');
    const unver = S.plan.add.filter((a) => !TYPES[a.type].verified);
    if (unver.length) log('⚠ 未検証の型が ' + unver.length + ' 件あります。まず1件だけで試してください。', 'err');
    // No existing field of this type on the sheet means we must invent the
    // layout property block instead of copying one. That path is untested.
    const noDonor = [];
    S.plan.add.forEach((a) => { if (!donorFor(a.type) && noDonor.indexOf(a.type) < 0) noDonor.push(a.type); });
    if (noDonor.length) {
      log('⚠ このシートに既存項目が無い型があります: ' + noDonor.join(', '), 'err');
      log('  この型はレイアウト設定を汎用値で作成します（未検証の経路）。まず1件だけ試してください。', 'err');
    }
    // Near-duplicate names: a stray space or full/half-width difference would
    // create a second, almost identical field rather than skipping.
    const norm = (t) => String(t).normalize('NFKC').replace(/[\s\u3000]/g, '').toLowerCase();
    const existing = {};
    Object.values(Object.assign({}, existingDefs(), ((S.tpl.body.sheetDefs || [])[0] || {}).itemDefs || {}))
      .forEach((d) => { if (d && d.labelName) existing[norm(d.labelName)] = d.labelName; });
    S.plan.add.forEach((a) => {
      const hit = existing[norm(a.label)];
      if (hit) log('⚠ 「' + a.label + '」は既存の「' + hit + '」とほぼ同名です。別項目として追加されます。', 'err');
    });
    const payload = buildPayload();
    log('送信予定サイズ: ' + JSON.stringify(payload).length + ' bytes');
    window.__eltPayload = payload;
    log('(payload は window.__eltPayload で確認できます)');
    refresh();
  }
  $('elt-dry').onclick = doDry;
  $('elt-apply').onclick = apply;
  $('elt-apply-one').onclick = applyOneByOne;

  async function runAll(mode) {
    const btns = [$('elt-run'), $('elt-run-one')];
    btns.forEach((b) => { b.disabled = true; });
    try {
      if (!$('elt-tsv').value.trim()) { log('項目リストを貼り付けてください。', 'err'); return; }
      if (!S.tpl) await autoCapture();
      if (!S.design) { log('既存項目一覧を取得しています…'); await waitForDesign(); }
      if (!preflight()) return;
      if (!doParse()) return;
      doDry();
      if (!S.plan.add.length) { log('追加対象がありません。', 'err'); return; }
      await (mode === 'one' ? applyOneByOne() : apply());
    } catch (e) {
      log('中止: ' + e.message, 'err');
    } finally {
      btns.forEach((b) => { b.disabled = false; });
      refresh();
    }
  }
  $('elt-run').onclick = () => runAll('batch');
  $('elt-run-one').onclick = () => runAll('one');
  $('elt-capture').onclick = () => autoCapture().catch((e) => log(e.message, 'err'));
  $('elt-reload').onclick = () => {
    if (!S.tpl) { log('先に保存リクエストを取得してください。', 'err'); return; }
    log('項目一覧を取得しています…');
    loadDesign().catch((e) => log('項目一覧の取得に失敗: ' + e.message, 'err'));
  };

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function refresh() {
    const ok = !!S.tpl;
    $('elt-status').innerHTML = ok
      ? '<span class="elt-ok">準備完了: ' + S.sheetName + '</span>' +
        (S.design ? ' <span style="color:#8b95a7">既存 ' + Object.keys(existingDefs()).length + ' 項目</span>'
                  : ' <span class="elt-warn">(項目一覧は未取得)</span>')
      : '状態: 保存リクエスト未取得 —「実行」で自動取得します';
    $('elt-dry').disabled = !(ok && S.spec.length);
    const canWrite = !!(ok && S.design && S.plan && S.plan.add.length);
    $('elt-apply').disabled = !canWrite;
    $('elt-apply-one').disabled = !canWrite;
  }

  window.__esmLayoutTool = {
    S, TYPES, show: () => { panel.style.display = 'flex'; }, restore,
    parseSpec, buildPlan, buildPayload, request
  };
  try {
    const saved = localStorage.getItem('elt-spec');
    if (saved) { $('elt-tsv').value = saved; log('前回の項目リストを復元しました。'); }
  } catch (e) {}

  log(VERSION + ' を読み込みました。');
  log('Excel から項目リストを貼り付けて「一括で実行」または「1件ずつ実行」を押してください。');
  refresh();
})();
