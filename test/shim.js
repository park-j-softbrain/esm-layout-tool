// Minimal DOM shim: enough for esm-layout-tool.js to load in node for logic tests.
const nodes={};
function el(tag){
  const e={tagName:tag,children:[],style:{},dataset:{},_text:'',_ev:{},_cls:new Set(),
    offsetWidth:440,offsetHeight:300,
    appendChild(c){this.children.push(c);return c;},remove(){},click(){},
    addEventListener(t,f){(this._ev[t]=this._ev[t]||[]).push(f);},
    fire(t,ev){(this._ev[t]||[]).forEach(f=>f(Object.assign({preventDefault(){},button:0},ev)));},
    classList:{add(c){e._cls.add(c);},remove(c){e._cls.delete(c);},contains(c){return e._cls.has(c);}},
    getBoundingClientRect(){
      const L=parseFloat(this.style.left), T=parseFloat(this.style.top);
      const left=isFinite(L)?L:0, top=isFinite(T)?T:0;
      return {left,top,right:left+this.offsetWidth,bottom:top+this.offsetHeight,
              width:this.offsetWidth,height:this.offsetHeight};
    },
    // Enough tag scanning to hand back the elements the tool looks up by name.
    querySelector(sel){
      const tag=String(sel).replace(/[^a-z]/g,'');
      if(this._parts&&this._parts[tag]) return this._parts[tag];
      return null;
    },
    querySelectorAll(){return [];},
    // Registering on assignment is what makes getElementById find the real
    // panel instead of handing back a fresh stub with none of its wiring.
    set id(v){this._id=v; nodes[v]=this;},
    get id(){return this._id||'';},
    set innerHTML(v){
      this._html=v; this._parts={};
      (String(v).match(/<([a-z]+)[\s>]/g)||[]).forEach(m=>{
        const t=m.replace(/[^a-z]/g,'');
        if(!this._parts[t]) this._parts[t]=el(t);
      });
    },
    get innerHTML(){return this._html||'';},
    set textContent(v){this._text=v;},get textContent(){return this._text;}};
  return e;
}
global.document={
  head:el('head'), body:el('body'),
  createElement:el,
  getElementById(id){ return nodes[id] || (nodes[id]=el('div')); }
};
global.document.addEventListener=(t,f)=>{(global.document._ev=global.document._ev||{})[t]=(global.document._ev[t]||[]).concat(f);};
global.document.fire=(t,ev)=>((global.document._ev||{})[t]||[]).forEach(f=>f(Object.assign({preventDefault(){},button:0},ev)));
global.window=global;
global.window.addEventListener=global.document.addEventListener;
global.innerWidth=1280; global.innerHeight=800;
// A real store, so the tool's save/restore paths run instead of being swallowed
// by the try/catch that guards a browser with site data turned off.
(function(){ const m={};
  Object.defineProperty(global,'localStorage',{configurable:true,value:{
    getItem:k=>(k in m?m[k]:null), setItem:(k,v)=>{m[k]=String(v);},
    removeItem:k=>{delete m[k];}, clear:()=>{Object.keys(m).forEach(k=>delete m[k]);}}});
})();
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
