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
    '見出し':            { prefix: 'type_title',             itemType: 'SECTION',           def: 'SectionItemTypeDef',          verified: false, fullWidth: true },
    '紐づけ項目':        { prefix: 'type_suggest',           itemType: 'SB_RELATION',       def: 'SBRelationItemTypeDef',       verified: true,  relation: true, emptyValue: [] }
  };
  // Aliases so the spec sheet can use ASCII or sloppy variants.
  const ALIAS = {
    'text': 'テキスト', 'string': 'テキスト', 'テキスト(複数行)': 'テキスト（複数行）',
    'textarea': 'テキスト（複数行）', 'memo': 'テキスト（複数行）', 'メモ': 'テキスト（複数行）',
    'テキストエリア': 'テキスト（複数行）', '複数行テキスト': 'テキスト（複数行）',
    'テキスト（複数行）': 'テキスト（複数行）', '長文テキスト': 'テキスト（複数行）',
    'pulldown': 'プルダウン', 'select': 'プルダウン', 'ドロップダウン': 'プルダウン',
    'radio': 'ラジオボタン', 'checkbox': 'チェックボックス',
    'number': '数値', 'date': '日付', 'time': '時間', 'datetime': '日時',
    'file': 'ファイル', 'link': 'リンク', 'url': 'リンク',
    'tel': '電話番号', 'telno': '電話番号', 'address': '住所',
    'email': 'メールアドレス', 'mail': 'メールアドレス',
    'section': '見出し', 'heading': '見出し', 'title': '見出し',
    '紐付け項目': '紐づけ項目', '紐づけ': '紐づけ項目', '紐付け': '紐づけ項目',
    '関連レコード': '紐づけ項目', 'relation': '紐づけ項目', 'suggest': '紐づけ項目'
  };
  // Types that cannot be created from a name alone. Each needs a reference to
  // other items or sheets that a two-column spec does not carry.
  const UNSUPPORTED = {
    '演算（文字）': '計算式が必要です (defaultValue.ref に式と参照項目を指定)',
    '演算（数値）': '計算式が必要です (defaultValue.ref に式と参照項目を指定)',
    '紐づけ参照': '紐づけ先のどの項目を引くかの指定が必要です'
  };
  const UNSUP_ALIAS = {
    '演算(文字)': '演算（文字）', '演算(数値)': '演算（数値）',
    '紐付け参照': '紐づけ参照', '紐付参照': '紐づけ参照', '紐づけ先参照': '紐づけ参照'
  };
  // Rows describing fields eSM creates itself. The spec sheet lists the whole
  // sheet, built-ins included; those are already there and must not be re-added.
  const SYSTEM_ROW = /^※?\s*システム項目/;
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
    sheetName: null,
    targetDesign: {}, // sheetName -> GET /design/{sheetName}   (link targets)
    targetLayout: {}, // sheetName -> POST /layout/tenant/search (link targets)
    targetBaseline: {}, // sheetName -> updatedAt when the target was read
    targetMaxOrder: {} // sheetName -> highest reverse itemOrder written this run
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
      // The URL names the sheet being edited. tenantLayout is NOT a safe source:
      // saving a 紐づけ項目 puts the link target's sheet in there too, and it can
      // come first, which would point every later write at the wrong sheet.
      const um = String(url).match(/\/design\/layout\/([^/?#]+)\/part/);
      S.sheetName = (um && decodeURIComponent(um[1])) || Object.keys(body.tenantLayout || {})[0] || null;
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

  // One design + one layout read per distinct link target. Both are reads; the
  // design is what the reverse key is allocated from and the layout is the map
  // the reverse entry is added to.
  async function loadTargets(sheetNames) {
    for (let i = 0; i < sheetNames.length; i++) {
      const sn = sheetNames[i];
      if (S.targetDesign[sn] && S.targetLayout[sn]) continue;
      log('紐づけ先 ' + sn + ' の定義を取得しています…');
      S.targetDesign[sn] = await req('/design/' + encodeURIComponent(sn) + '?checkAuthorization=false');
      S.targetLayout[sn] = await req('/layout/tenant/search', { method: 'POST', body: JSON.stringify({ keys: [sn] }) });
      if (!((S.targetLayout[sn] || {})[sn] || {}).pc) throw new Error('紐づけ先 ' + sn + ' のレイアウトを取得できませんでした');
      const st = await req('/sheetdef/state/' + encodeURIComponent(sn));
      S.targetBaseline[sn] = st && st.updatedAt;
    }
  }

  // Which target sheets the parsed spec needs, resolved through this sheet's
  // existing links. Unresolvable names are left for buildPlan to report.
  function specTargets() {
    const idx = relationIndex(), out = [];
    S.spec.forEach((it) => {
      if (!TYPES[it.type] || !TYPES[it.type].relation) return;
      const d = idx[norm(it.target)];
      if (d && out.indexOf(d.sheetName) < 0) out.push(d.sheetName);
    });
    return out;
  }

  // Our PUT replays whole layout maps, so a concurrent edit to any sheet in the
  // payload would be silently discarded. Check every one of them, including the
  // link targets the operator is not even looking at.
  async function checkConcurrentEdits(targets) {
    if (!S.baselineUpdatedAt) throw new Error('基準時刻が未取得です');
    const rows = [{ sheetName: S.sheetName, localUpdatedAt: S.baselineUpdatedAt }];
    (targets || []).forEach((sn) => {
      if (!S.targetBaseline[sn]) throw new Error('紐づけ先 ' + sn + ' の基準時刻が未取得です');
      rows.push({ sheetName: sn, localUpdatedAt: S.targetBaseline[sn] });
    });
    const chk = await req('/sheetdef/state/isUpdated', { method: 'POST', body: JSON.stringify(rows) });
    const hit = (chk || []).filter((r) => r && r.isUpdated).map((r) => r.sheetName);
    if (hit.length) throw new Error('基準時刻以降に他の人が ' + hit.join(', ') + ' を更新しています');
    return rows.map((r) => r.sheetName);
  }

  const planTargets = () => Object.keys((S.plan && S.plan.targets) || {});

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

  /* Column roles, matched against the header row when there is one.
   * The real onboarding sheets look like:
   *   No. | 項目名 | 項目タイプ | 紐づけ先レコード | 選択肢 | 選択肢 | 選択肢 ...
   * i.e. a mostly-empty first column and choices spread across many columns,
   * so positional guessing alone is not enough. */
  const HEAD = [
    ['ignore',      /^\s*(no\.?|№|#|番号)\s*$/i],
    ['target',      /紐づけ先|紐付け先|紐ずけ先|参照先|関連先|リンク先|target/i],
    ['options',     /選択肢|セレクト|チェックボックス|option|choice/i],
    ['required',    /必須|required/i],
    ['span',        /幅|列数|span/i],
    ['explanation', /説明|備考|ヘルプ|explanation|description|remark/i],
    ['label',       /項目名|項目名称|ラベル|名称|名前|label|^name$/i],
    ['type',        /項目タイプ|項目種別|項目型|タイプ|種別|型|type/i]
  ];

  function mapHeader(head) {
    const col = {};
    head.forEach((cell, i) => {
      const c = String(cell || '').trim();
      if (!c) return;
      for (let j = 0; j < HEAD.length; j++) {
        if (HEAD[j][1].test(c)) {
          const role = HEAD[j][0];
          if (role !== 'ignore' && col[role] === undefined) col[role] = i;
          return;
        }
      }
    });
    return col;
  }

  // Notes written into the choice columns. Three of them carry a real setting
  // and the rest are prose; anything not recognised is reported, never guessed at.
  const N2H = (t) => String(t).replace(/[０-９]/g, (d) => '0123456789'['０１２３４５６７８９'.indexOf(d)]);
  function readNote(note, it) {
    const t = N2H(String(note));
    let used = false;
    let m = t.match(/小数点以下\s*(\d+)\s*桁/);
    if (m) { it.decimalDigit = Math.min(10, parseInt(m[1], 10)); used = true; }
    m = t.match(/(?:後ろに)?単位\s*[「『"”]([^」』"”]+)[」』"”]/);
    if (m && !/前に単位/.test(t)) { it.unitPostfix = m[1]; used = true; }
    m = t.match(/前に単位\s*[「『"”]([^」』"”]+)[」』"”]/);
    if (m) { it.unitPrefix = m[1]; used = true; }
    if (/初期値\s*(本日|今日)/.test(t)) { it.defaultToday = true; used = true; }
    return used;
  }

  function parseSpec(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
    const delim = detectDelimiter(lines);
    const rows = lines.map((l) => splitLine(l, delim).map((c) => String(c).trim())).filter((r) => r.some((c) => c !== ''));
    if (!rows.length) return { items: [], errors: [], notes: [], col: {}, delim: delim };

    // A header row names its columns and resolves nothing to a type name.
    let col = mapHeader(rows[0]);
    const looksHeader = col.label !== undefined && col.type !== undefined &&
                        !rows[0].some((c) => resolveType(c) || unsupportedName(c));
    const body = looksHeader ? rows.slice(1) : rows;

    if (!looksHeader) {
      // No header: find the column that actually holds type names, then take the
      // nearest column to its left (else right) that is mostly filled as the label.
      const width = body.reduce((n, r) => Math.max(n, r.length), 0);
      const typeScore = [];
      for (let c = 0; c < width; c++) {
        typeScore[c] = body.reduce((n, r) => n + ((resolveType(r[c]) || unsupportedName(r[c]) || SYSTEM_ROW.test(String(r[c] || ''))) ? 1 : 0), 0);
      }
      let tc = 0;
      for (let c = 1; c < width; c++) if (typeScore[c] > typeScore[tc]) tc = c;
      const filled = (c) => body.reduce((n, r) => n + (String(r[c] || '').trim() ? 1 : 0), 0);
      let lc = -1;
      for (let c = tc - 1; c >= 0; c--) if (filled(c) >= body.length / 2) { lc = c; break; }
      if (lc < 0) for (let c = tc + 1; c < width; c++) if (filled(c) >= body.length / 2) { lc = c; break; }
      if (lc < 0) lc = tc === 0 ? 1 : 0;
      col = { type: tc, label: lc };
      // The historical 6-column shape: ラベル/型/必須/選択肢/幅/説明.
      if (width > 2 && Math.min(tc, lc) === 0 && Math.max(tc, lc) === 1) {
        col.required = 2; col.options = 3; col.span = 4; col.explanation = 5;
      }
    }
    if (col.options === undefined) col.options = Math.max(col.label, col.type) + 1;

    const optCells = (r) => r.slice(col.options).map((c) => String(c || '').trim()).filter(Boolean);

    const items = [], errors = [], notes = [];
    let prev = null;
    body.forEach((r, i) => {
      const line = (looksHeader ? i + 2 : i + 1);
      const label = String(r[col.label] || '').trim();
      const rawType = String(r[col.type] || '').trim();
      const cells = optCells(r);

      // A choice list too long for one row continues on the next, with the
      // name and type columns left blank.
      if (!label && !rawType) {
        if (prev && cells.length) { prev.__cells = prev.__cells.concat(cells); return; }
        return;
      }
      if (!label) { errors.push('行' + line + ': 項目名が空です'); return; }
      if (!rawType) { notes.push('行' + line + ': 「' + label + '」は項目タイプが空のため飛ばします'); return; }
      if (SYSTEM_ROW.test(rawType)) { notes.push('行' + line + ': 「' + label + '」はシステム項目のため飛ばします'); return; }

      const bad = unsupportedName(rawType);
      if (bad) { errors.push('行' + line + ': 「' + label + '」の型 ' + bad + ' はこのツールでは追加できません — ' + UNSUPPORTED[bad] + '。手動で追加してください'); return; }
      const type = resolveType(rawType);
      if (!type) { errors.push('行' + line + ': 型「' + rawType + '」は未対応です'); return; }

      const span = parseInt(String(r[col.span] || '1').trim(), 10);
      const it = {
        line, label, type,
        required: col.required !== undefined ? isTrue(r[col.required]) : false,
        target: col.target !== undefined ? String(r[col.target] || '').trim() : '',
        options: [],
        span: TYPES[type].fullWidth ? 4 : ([1, 2, 3, 4].indexOf(span) >= 0 ? span : 1),
        explanation: col.explanation !== undefined ? String(r[col.explanation] || '').trim() : '',
        __cells: cells
      };
      items.push(it);
      prev = it;
    });

    // Second pass: split each row's trailing cells into choices and notes.
    items.forEach((it) => {
      const isSelect = TYPES[it.type].itemType === 'SELECT';
      const cells = it.__cells; delete it.__cells;
      const opts = [];
      cells.forEach((c) => {
        // A cell opening with ※ is an instruction to the operator, never a choice.
        if (/^[※*＊]/.test(c) || !isSelect) {
          if (!readNote(c, it)) notes.push('行' + it.line + ': 「' + it.label + '」の備考は反映しません: ' + c);
          return;
        }
        opts.push(c);
      });
      // One cell holding "a,b,c" is the older single-column form; several cells
      // means the choices are already one per column and must not be re-split.
      it.options = (opts.length === 1 && /[,、]/.test(opts[0]))
        ? opts[0].split(/[,、]/).map((x) => x.trim()).filter(Boolean)
        : opts;
      if (isSelect && !it.options.length) errors.push('行' + it.line + ': 「' + it.label + '」は選択肢が必要です');
      if (TYPES[it.type].relation && !it.target) errors.push('行' + it.line + ': 「' + it.label + '」は紐づけ先レコードの指定が必要です');
    });

    return { items: items.filter((it) => !(TYPES[it.type].itemType === 'SELECT' && !it.options.length) && !(TYPES[it.type].relation && !it.target)), errors, notes, col, delim: delim };
  }

  /* ------------------------------------------------------------------ *
   * 3. Plan
   * ------------------------------------------------------------------ */
  const norm = (t) => String(t || '').normalize('NFKC').replace(/[\s\u3000]/g, '').toLowerCase();

  // A 紐づけ項目 cannot be written from a name alone: it carries the target
  // sheet's own id definition. We never author that — we copy it from a link to
  // the same sheet that already exists here, exactly as the rest of this tool
  // copies the save request instead of synthesising one. A target this sheet has
  // never linked to therefore needs its first field made by hand.
  function relationDonors() {
    const out = {};
    Object.keys(existingDefs()).forEach((k) => {
      const d = existingDefs()[k];
      if (!d || d.itemType !== 'SB_RELATION') return;
      const td = d.itemTypeDef || {};
      if (!td.sheetName || out[td.sheetName]) return;
      const nested = td.itemDefs || {};
      const idKey = Object.keys(nested).filter((n) => /\.id$/.test(n))[0];
      if (!idKey) return;
      out[td.sheetName] = {
        sheetName: td.sheetName, donorKey: k, idDef: nested[idKey],
        reverseLabel: String((td.reverseRelationItemDef || {}).labelName || '')
      };
    });
    return out;
  }

  // Spec sheets name the target the way a user sees it ("業者"), not as
  // "sheet_134". The target's own id field is labelled "業者ID", so the existing
  // links on this sheet already carry the mapping.
  function relationIndex() {
    const donors = relationDonors(), idx = {};
    Object.keys(donors).forEach((sn) => {
      const d = donors[sn];
      idx[norm(sn)] = d;
      const disp = String((d.idDef || {}).labelName || '').replace(/(ID|コード|CODE)$/i, '').trim();
      if (!disp) return;
      const n = norm(disp);
      // Two targets whose id fields carry the same label cannot be told apart by
      // name. Drop both rather than picking one, so the spec must say sheet_N.
      if (idx[n] && idx[n].sheetName !== sn) idx[n] = { ambiguous: [idx[n].sheetName, sn] };
      else if (!idx[n]) idx[n] = d;
    });
    return idx;
  }

  // Every reverse link on this sheet is labelled "<名前>（<このシート>）", so the
  // sheet's own display name comes back out of them.
  function currentSheetLabel() {
    const donors = relationDonors();
    const keys = Object.keys(donors);
    for (let i = 0; i < keys.length; i++) {
      const m = donors[keys[i]].reverseLabel.match(/[（(]([^（）()]+)[）)]\s*$/);
      if (m) return m[1];
    }
    return S.sheetName;
  }

  const maxSuffix = (keys, prefix) => keys.reduce((n, k) => {
    const m = String(k).match(new RegExp('\\.' + prefix + '(\\d+)$'));
    return m ? Math.max(n, parseInt(m[1], 10)) : n;
  }, 0);

  // Where the reverse field lands on the OTHER sheet. Both numbers are read from
  // that sheet's own definition, never carried over from this one.
  function targetAllocator(sn) {
    const design = S.targetDesign[sn];
    const layout = ((S.targetLayout[sn] || {})[sn] || {});
    if (!design) return null;
    // Take the sheetDef that IS this sheet, not merely the last one present.
    const all = design.sheetDefs || [];
    const own = all.filter((sd) => sd && sd.itemDefs && sd.sheetName === sn);
    const defs = ((own[0] || all.filter((sd) => sd && sd.itemDefs)[0]) || {}).itemDefs || {};
    const layoutDefs = (((layout.pc || {}).sheetDefs || {}).itemDefs) || {};
    // The layout map is rolled forward after every batch, so keys added earlier
    // in this run are counted here and cannot be handed out twice.
    const keys = Object.keys(defs).concat(Object.keys(layoutDefs));
    let order = S.targetMaxOrder[sn] || 0;
    Object.keys(defs).forEach((k) => { const d = defs[k]; if (d && typeof d.itemOrder === 'number') order = Math.max(order, d.itemOrder); });
    return { sheetName: sn, used: new Set(keys), next: maxSuffix(keys, 'type_suggest') + 1, itemOrder: order + 1, count: Object.keys(defs).length };
  }

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

    // `order` is a cell index in a 4-wide grid: an item at order o sits in the
    // row that starts at the nearest lower row boundary, and a full-width item
    // (見出し) must begin one. The phase comes from the sheet's own layout rather
    // than being assumed. We only ever append past the end — inserting mid-layout
    // renumbers everything after it and is not something this tool does.
    const orders = Object.values(place).map((p) => (p && typeof p.order === 'number') ? p.order : null).filter((o) => o !== null);
    const GRID = 4;
    const phase = orders.length ? (Math.min.apply(null, orders) % GRID) : (3 % GRID);
    let cursor = orders.length ? Object.values(place).reduce((n, p) => Math.max(n, p.order + (p.displaySpan || 1)), 0) : phase;
    const rowStart = (o) => o + (((phase - o) % GRID) + GRID) % GRID;

    const nextIndex = (prefix) => maxSuffix(Array.from(usedKeys), prefix) + 1;
    const counters = {};
    const idx = relationIndex();
    const selfLabel = currentSheetLabel();
    const alloc = {};

    const add = [], skip = [];
    // Two rows of the same spec sharing a name is a mistake in the spec, not a
    // field that is already there — the operator has to pick which one they meant.
    const planned = new Set();
    S.spec.forEach((it) => {
      if (planned.has(it.label)) {
        skip.push(Object.assign({ reason: 'この項目リスト内で名前が重複しています（先に出てきた行だけを追加します）' }, it));
        return;
      }
      if (existingLabels.has(it.label)) { skip.push(Object.assign({ reason: '同名の項目が既に存在' }, it)); return; }
      const T = TYPES[it.type];

      let rel = null;
      if (T.relation) {
        const donor = idx[norm(it.target)];
        if (donor && donor.ambiguous) {
          skip.push(Object.assign({ reason: '紐づけ先「' + it.target + '」が ' + donor.ambiguous.join(' と ') + ' のどちらか判別できません（シート名で指定してください）' }, it));
          return;
        }
        if (!donor) {
          skip.push(Object.assign({ reason: '紐づけ先「' + it.target + '」がこのシートの既存の紐づけ項目に見つかりません' }, it));
          return;
        }
        if (!alloc[donor.sheetName]) {
          const a = targetAllocator(donor.sheetName);
          if (!a) { skip.push(Object.assign({ reason: '紐づけ先シート ' + donor.sheetName + ' の定義を取得できていません' }, it)); return; }
          alloc[donor.sheetName] = a;
        }
        const a = alloc[donor.sheetName];
        const revKey = 'appextender.' + donor.sheetName + '.type_suggest' + (a.next++);
        // A predicted key that is already taken would overwrite a real field on
        // the other sheet. Refuse rather than write.
        if (a.used.has(revKey)) { skip.push(Object.assign({ reason: '紐づけ先 ' + donor.sheetName + ' のキー ' + revKey.split('.').pop() + ' が既に使われています' }, it)); return; }
        a.used.add(revKey);
        rel = { donor: donor, target: donor.sheetName, revKey: revKey, revItemOrder: a.itemOrder++, selfLabel: selfLabel };
      }

      if (!(it.type in counters)) counters[it.type] = nextIndex(T.prefix);
      const key = 'appextender.' + S.sheetName + '.' + T.prefix + (counters[it.type]++);
      usedKeys.add(key);
      existingLabels.add(it.label);
      planned.add(it.label);

      const span = T.fullWidth ? GRID : (it.span || 1);
      const order = span > 1 ? rowStart(cursor) : cursor;
      cursor = order + span;
      add.push(Object.assign({ key, itemOrder: ++maxItemOrder, order, rel }, it, { span }));
    });
    return { add, skip, targets: alloc };
  }

  // The link itself. `idDef` is the target sheet's own id definition, copied
  // from a link that already exists here; the reverse half is the field that
  // appears ON THE TARGET SHEET pointing back at this one.
  function relationTypeDef(a) {
    const r = a.rel;
    const idDef = JSON.parse(JSON.stringify(r.donor.idDef));
    idDef.relationalItemDefPass = [];
    const nested = {};
    nested[a.key + '@' + idDef.itemId] = idDef;
    return {
      sheetName: r.target,
      isMultiple: false,
      isEditable: false,
      isAllcol: false,
      itemDefs: nested,
      reverseRelationItemKey: null,
      isPreRelation: false,
      reverseRelationItemDef: {
        itemId: r.revKey,
        isSheetReferenceItemDef: true,
        isKey: false,
        isKeywordSearchItem: false,
        isRequired: false,
        labelName: a.label + '（' + r.selfLabel + '）',
        defaultValue: { value: [], ref: '', applyValue: 'none', options: {} },
        isDisabled: true,
        isEditable: true,
        itemOrder: r.revItemOrder,
        isMaster: false,
        isDefault: false,
        explanation: '',
        difference: null,
        authority: null,
        preSheetItemDefInfo: null,
        itemType: 'SB_RELATION',
        itemTypeDef: {
          '@type': 'SBRelationItemTypeDef',
          sheetName: S.sheetName,
          isMultiple: true,
          isEditable: false,
          isAllcol: false,
          itemDefs: {},
          reverseRelationItemDef: null,
          isPreRelation: false
        }
      }
    };
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
      Object.assign(td, {
        decimalDigit: a.decimalDigit || 0,
        unitPrefix: a.unitPrefix || null,
        unitPostfix: a.unitPostfix || null,
        sum: 0, validScale: true
      });
    } else if (T.relation) {
      Object.assign(td, relationTypeDef(a));
    } else if (T.def === 'URLItemTypeDef') {
      Object.assign(td, { displayText: '', isFixedDefault: false });
    } else if (T.def === 'FileItemTypeDef') {
      td.isMultiSelectable = false;
    } else {
      td.messages = null;
    }
    const blank = (T.emptyValue !== undefined) ? JSON.parse(JSON.stringify(T.emptyValue)) : null;
    // "初期値: 本日" on a date field.
    const dv = (a.defaultToday && T.itemType === 'DATE')
      ? { ref: '', value: null, applyValue: 'today', options: { day: '0', mode: 'dayBefore' }, reference: null }
      : { ref: '', value: blank, applyValue: 'none', options: {}, reference: null };
    return {
      itemId: null,
      isSheetReferenceItemDef: true,
      isKey: false,
      isRequired: !!a.required,
      labelName: a.label,
      defaultValue: dv,
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
    if (T.relation) {
      // A cloned donor carries ITS target column in relationItems; a new link
      // starts blank, so this block is written rather than inherited.
      e.itemTypeDef = { relation: { readOnly: false, hideProperty: false, relationDisplayType: 'text', relationItems: [{ itemId: '', order: 1 }], searchTargetItemId: '' } };
      e.componentType = 'suggest#sheet';
      e.representativeNameItem = false;
      e.representativeImageItem = false;
      e.isKey = false;
    }
    if (T.itemType === 'SECTION') {
      e.componentType = 'title';
      // Cloning a 見出し that is already on the sheet keeps its colour, which is
      // what an operator adding more sections wants. Only invent one if there is none.
      if (!e.itemTypeDef || !e.itemTypeDef.section) {
        e.itemTypeDef = { section: { backgroundColor: '#CFD8DC', readOnly: false, hideProperty: false } };
      }
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

    // A 紐づけ項目 also registers its reverse field on the target sheet, so that
    // sheet's tenantLayout has to travel with the request. We take the copy the
    // server just gave us and add entries to it — nothing existing is rewritten.
    const targets = {};
    adds.forEach((a) => { if (a.rel) (targets[a.rel.target] = targets[a.rel.target] || []).push(a); });
    // The captured save may itself have been a link save and still carry someone
    // else's sheet. Send only this sheet plus the targets this batch needs.
    Object.keys(body.tenantLayout || {}).forEach((sn) => {
      if (sn !== S.sheetName && !targets[sn]) delete body.tenantLayout[sn];
    });
    Object.keys(targets).forEach((sn) => {
      const fetched = (S.targetLayout[sn] || {})[sn];
      if (!fetched) throw new Error('内部エラー: 紐づけ先 ' + sn + ' のレイアウトが未取得です');
      const tl = JSON.parse(JSON.stringify(fetched));
      const defsMap = ((tl.pc || {}).sheetDefs || {}).itemDefs;
      if (!defsMap) throw new Error('内部エラー: 紐づけ先 ' + sn + ' のレイアウト形式が想定と異なります');
      targets[sn].forEach((a) => {
        if (defsMap[a.rel.revKey]) throw new Error('内部エラー: 紐づけ先 ' + sn + ' の ' + a.rel.revKey + ' は既に存在します');
        defsMap[a.rel.revKey] = {
          isKey: false, label: P(), copied: { copied: true, readOnly: false, hideProperty: false },
          disabled: P(), editable: P(), required: P(), authority: P(),
          difference: { enable: false }, explanation: P(),
          itemTypeDef: { relation: { readOnly: false, hideProperty: false, relationItems: [], searchTargetItemId: '', relationDisplayType: 'text' } },
          defaultValue: P(), componentType: 'suggest#sheet', matrixSetting: P(),
          representativeNameItem: false, representativeImageItem: false
        };
      });
      // Additive only, on the other sheet as much as on this one.
      const before = ((fetched.pc || {}).sheetDefs || {}).itemDefs || {};
      const touched = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(defsMap[k]));
      if (touched.length) throw new Error('内部エラー: 紐づけ先 ' + sn + ' の既存項目を変更しようとしました (' + touched.slice(0, 3).join(', ') + ')');
      body.tenantLayout[sn] = tl;
    });

    // Safety: the only existing entries we may have touched are the ones we added.
    const beforePlace = layoutPlacement(S.tpl.body);
    const afterPlace = layoutPlacement(body);
    const changed = Object.keys(beforePlace).filter((k) => JSON.stringify(beforePlace[k]) !== JSON.stringify(afterPlace[k]));
    if (changed.length) throw new Error('内部エラー: 既存項目の配置を変更しようとしました (' + changed.join(', ') + ')');
    const beforeDefs = layoutItemDefs(S.tpl.body);
    const afterDefs = layoutItemDefs(body);
    const dChanged = Object.keys(beforeDefs).filter((k) => JSON.stringify(beforeDefs[k]) !== JSON.stringify(afterDefs[k]));
    if (dChanged.length) throw new Error('内部エラー: 既存項目の設定を変更しようとしました (' + dChanged.slice(0, 3).join(', ') + ')');
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

  // Spelled into the confirm dialog, not only the log: the reverse fields land
  // on a sheet the operator is not looking at.
  function relationWarning(adds) {
    const per = {};
    (adds || []).forEach((a) => { if (a.rel) per[a.rel.target] = (per[a.rel.target] || 0) + 1; });
    const names = Object.keys(per);
    if (!names.length) return '';
    return '\n\n【紐づけ項目】このシート以外も変更されます:\n' +
      names.map((sn) => '  ・' + sn + ' に逆側の項目 ' + per[sn] + ' 件').join('\n') +
      '\n(eSM で紐づけ項目を手で作ったときと同じ動作です)';
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
    // Same for each link target: the next batch must build on the map that now
    // includes this batch's reverse fields, or it would send them back deleted.
    Object.keys(payload.tenantLayout || {}).forEach((sn) => {
      if (sn === S.sheetName) return;
      const rolled = {}; rolled[sn] = payload.tenantLayout[sn];
      S.targetLayout[sn] = rolled;
    });
    // /design for the target is not re-fetched between batches, so its itemOrder
    // high-water mark has to be carried forward by hand or the next batch reuses it.
    adds.forEach((a) => {
      if (!a.rel) return;
      S.targetMaxOrder[a.rel.target] = Math.max(S.targetMaxOrder[a.rel.target] || 0, a.rel.revItemOrder);
    });
    for (const sn of Object.keys(payload.tenantLayout || {})) {
      if (sn === S.sheetName) continue;
      try { const st = await req('/sheetdef/state/' + encodeURIComponent(sn)); S.targetBaseline[sn] = st && st.updatedAt; }
      catch (e) { S.targetBaseline[sn] = null; }
    }
    await loadState().catch(() => { S.baselineUpdatedAt = null; });
  }

  // Applies each item in its own transaction and reports which types the server
  // accepts. Slower, but a rejected item no longer takes the whole batch with it.
  async function applyOneByOne() {
    if (!S.plan || !S.plan.add.length) { log('追加対象がありません。', 'err'); return; }
    if (!preflight()) return;
    const adds = S.plan.add.slice();
    if (!confirm(adds.length + ' 件を1件ずつ追加します。\n失敗した項目はスキップして続行します。' +
                 relationWarning(adds) + '\n\nよろしいですか？')) return;

    try {
      const names = await checkConcurrentEdits(planTargets());
      log('排他チェック OK (' + names.join(', ') + ')', 'ok');
    } catch (e) {
      log('中止: ' + e.message, 'err');
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
    if (!confirm(n + ' 件の項目を追加します。' + relationWarning(S.plan.add) +
                 '\n\nよろしいですか？\n(事前に現在の状態を .json で保存します)')) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    download('esm-layout-before-' + S.sheetName + '-' + stamp + '.json', { capturedSave: S.tpl.body, design: S.design });
    log('現在の状態を保存しました (ダウンロードフォルダ)。', 'ok');

    try {
      const names = await checkConcurrentEdits(planTargets());
      log('排他チェック OK (' + names.join(', ') + ' / 基準時刻 ' + S.baselineUpdatedAt + ')', 'ok');
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
        Excel の見出し行ごとコピーして貼り付けてください。<br>
        <b>項目名 / 項目タイプ / 紐づけ先レコード / 選択肢</b>（列の順番は自由・選択肢は何列でも可）<br>
        ※システム項目の行と、No. 列は自動で読み飛ばします。
      </div>
      <textarea id="elt-tsv" placeholder="項目名&#9;項目タイプ&#9;紐づけ先レコード&#9;選択肢&#10;物件名&#9;テキスト&#10;工事担当&#9;紐付け&#9;業者&#10;ステータス&#9;プルダウン&#9;&#9;未対応&#9;対応中&#9;完了"></textarea>
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
    const cn = { label: '項目名', type: '項目タイプ', target: '紐づけ先', options: '選択肢', required: '必須', span: '幅', explanation: '説明' };
    log('形式の判定: ' + dn + ' / ' + Object.keys(cn).filter((k) => r.col[k] !== undefined)
        .map((k) => (r.col[k] + 1) + '列目=' + cn[k]).join(' '));
    r.errors.forEach((e) => log(e, 'err'));
    // Anything the spec said that was not turned into a setting is listed rather
    // than dropped, so nothing disappears without the operator seeing it.
    (r.notes || []).forEach((n) => log(n));
    log(r.items.length + ' 行を解析しました。' +
        (r.notes && r.notes.length ? ' (' + r.notes.length + ' 行は対象外/備考)' : '') +
        (r.errors.length ? ' (' + r.errors.length + ' 行はエラー)' : ''), r.errors.length ? 'err' : 'ok');
    try { localStorage.setItem('elt-spec', $('elt-tsv').value); } catch (e) {}
    refresh();
    return r.items.length > 0 && r.errors.length === 0;
  }
  $('elt-parse').onclick = doParse;

  async function doDry() {
    // Link targets have to be read before the plan can allocate reverse keys.
    const need = specTargets();
    if (need.length) await loadTargets(need);
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
    // Adding a link writes a reverse field onto the OTHER sheet. Say so plainly:
    // it is the only thing this tool does outside the sheet on screen.
    const tgt = S.plan.targets || {};
    const tnames = Object.keys(tgt);
    if (tnames.length) {
      log('── 紐づけ項目 ──', 'ok');
      tnames.forEach((sn) => {
        const n = S.plan.add.filter((a) => a.rel && a.rel.target === sn).length;
        log('⚠ 紐づけ先シート ' + sn + ' にも逆側の項目が ' + n + ' 件追加されます（既存 ' + tgt[sn].count + ' 件）。', 'err');
      });
      log('  逆側の項目は ' + currentSheetLabel() + ' 側の名前に（' + currentSheetLabel() + '）を付けた名前で、非表示で作られます。', 'err');
      log('  これは eSM で紐づけ項目を手で作ったときと同じ動作です。', 'err');
    }
    // Near-duplicate names: a stray space or full/half-width difference would
    // create a second, almost identical field rather than skipping.
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
  $('elt-dry').onclick = () => { doDry().catch((e) => log('ドライラン中止: ' + e.message, 'err')); };
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
      await doDry();
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
    parseSpec, buildPlan, buildPayload, request, checkConcurrentEdits, relationWarning,
    captureForTest: capture, targetAllocatorForTest: targetAllocator
  };
  try {
    const saved = localStorage.getItem('elt-spec');
    if (saved) { $('elt-tsv').value = saved; log('前回の項目リストを復元しました。'); }
  } catch (e) {}

  log(VERSION + ' を読み込みました。');
  log('Excel から項目リストを貼り付けて「一括で実行」または「1件ずつ実行」を押してください。');
  refresh();
})();
