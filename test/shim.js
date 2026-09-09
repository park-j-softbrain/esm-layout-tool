// Minimal DOM shim: enough for esm-layout-tool.js to load in node for logic tests.
function el(tag){
  const e={tagName:tag,children:[],style:{},dataset:{},_text:'',
    appendChild(c){this.children.push(c);return c;},remove(){},click(){},
    // The shim never parses innerHTML, so these find nothing. They exist so the
    // tool's own lookups run instead of throwing into a catch and hiding a bug.
    querySelector(){return null;},querySelectorAll(){return [];},
    set innerHTML(v){this._html=v;},get innerHTML(){return this._html||'';},
    set textContent(v){this._text=v;},get textContent(){return this._text;}};
  return e;
}
const nodes={};
global.document={
  head:el('head'), body:el('body'),
  createElement:el,
  getElementById(id){ return nodes[id] || (nodes[id]=el('div')); }
};
global.window=global;
global.location={href:'https://esm.example/esm/sheet_10000000000001/item-edit',
  pathname:'/esm/sheet_10000000000001/item-edit',origin:'https://esm.example'};
global.navigator={clipboard:{writeText(){}}};
// Recording XHR: tests count attempts and choose the outcome.
global.__xhr={sends:[],mode:'error'};   // 'error' | 'ok' | 'http500'
global.XMLHttpRequest=function(){ this.withCredentials=false; };
global.XMLHttpRequest.prototype={
  open(m,u){ this.__m=m; this.__u=u; this.__h={}; },
  setRequestHeader(k,v){ this.__h[k]=v; },
  send(b){
    global.__xhr.sends.push({method:this.__m,url:this.__u,headers:this.__h,body:b});
    // Decide the outcome NOW. Reading the mode inside the timer instead would
    // give every in-flight request whatever the last test happened to set.
    const mode=global.__xhr.mode, resp=global.__xhr.response;
    setTimeout(()=>{
      if(mode==='ok'){ this.status=200; this.responseText=resp||'{}'; this.onload&&this.onload(); }
      else if(mode==='http500'){ this.status=500; this.responseText='{\"e\":1}'; this.onload&&this.onload(); }
      else { this.onerror&&this.onerror(); }
    },0);
  }
};
global.fetch=()=>Promise.reject(new Error('no network in test'));
global.Blob=function(){}; global.URL.createObjectURL=()=>'blob:x'; global.URL.revokeObjectURL=()=>{};
global.confirm=()=>false;
global.__nodes=nodes;
