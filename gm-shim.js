/* ============================================================================
   gm-shim.js —— 油猴那 5 个 @grant 在扩展里的等价物(移植版**第一个**注入的文件)
   ----------------------------------------------------------------------------
   本文件一个字都不碰原脚本:它只负责"把原脚本运行所需的环境补齐"。

   原脚本用到的 @grant(实测审计):
     GM_getValue(89) / GM_setValue(81) / GM_deleteValue(19) / GM_xmlhttpRequest(4) / unsafeWindow
     —— 没有用到 GM_addStyle / GM_openInTab / GM_notification / GM_info 等,所以不用替。

   ⚠ 为什么必须"预载 + 延后启动":
     GM_getValue 是**同步**函数,原脚本在 init() 期间就同步读了大量设置。
     扩展的 chrome.storage 只有异步接口 ⇒ 先把整个 storage 读进内存镜像(同步读镜像),
     读完再启动原脚本主体(__LN_START)。这就是本文件存在的全部理由。
   ========================================================================== */
(() => {
  'use strict';
  const PFX = 'ln:gm:';                 // 扩展存储里的命名空间(和我们自己其他键隔开)
  const raw = Object.create(null);      // 内存镜像
  let started = false;

  /* 扩展被重新加载/更新后,老页面里的内容脚本已经"失联":之后任何 chrome.* 调用都会抛
     「Extension context invalidated」。脚本会把错误消息原样显示给用户(如「读取本站缓存失败: …」),
     所以这里换成一句照着做就能解决的话。 */
  const REFRESH_HINT = '扩展刚被重新加载过:请刷新本页(F5)后再试';
  /* v4.9.168-扩展移植:这条提示是我们**故意**用来告诉用户"刷新一下就好"的,不是故障。
     但它常从"背景任务"里冒出来(每 20 秒的面板重绘、预热、首访迁移…)—— 那些调用点没接 catch,
     于是在控制台变成 `Uncaught (in promise) Error: 扩展刚被重新加载过…`,看着像崩了。
     处理:①同一条提示只 warn 一次(别刷屏);②下面统一把"未处理的 REFRESH_HINT"收掉(preventDefault)。 */
  let deadWarned = false;
  function noteDead() {
    if (deadWarned) return;
    deadWarned = true;
    try { console.warn('[ln-port] ' + REFRESH_HINT + '(本页的后台调用都会失败,刷新即恢复;刷新前不再重复提示)'); } catch (e) {}
  }
  function friendlyErr(e) {
    let dead = false;
    try { dead = !(chrome.runtime && chrome.runtime.id); } catch (x) { dead = true; }
    const m = String((e && e.message) || e || '');
    if (dead || m.indexOf('Extension context invalidated') >= 0) { noteDead(); return new Error(REFRESH_HINT); }
    return (e instanceof Error) ? e : new Error(m);
  }
  try {
    window.addEventListener('unhandledrejection', (ev) => {
      const m = String((ev && ev.reason && ev.reason.message) || '');
      if (m.indexOf(REFRESH_HINT) >= 0) { try { ev.preventDefault(); } catch (e) {} }
    });
  } catch (e) {}

  /* ★ v4.9.187:原脚本正文末尾带着这样一行(照搬时保留在 ln-main.js 最末):
       if (globalThis.__LN_START) globalThis.__LN_START();
     它在 ln-main.js **被求值的那一刻**就喊了启动 —— 那时 chrome.storage.local.get(null) 的回调
     (API 必然是异步)还没回来,内存镜像 raw 还是空的 ⇒ init() 阶段所有 GM_getValue 都拿到默认值。
     后果:只在"启动时读一次"的设置会像没保存一样(实测:已获取的模型列表 esj_ai_model_lists_v1
     明明落在存储里、缓存管理面板也看得到,刷新后 AI 设置却显示"暂无模型");
     而"用的时候才读"的设置(API Key 等)不受影响 —— 看起来就像随机丢设置。
     修法:start() 在镜像读完之前只记个记号,读完再真正启动;启动仍然只发生一次。 */
  let storageReady = false;      /* 镜像是否已读完(上面已有 let started,别重复声明) */
  let wantStart = false;
  function start() {
    if (!storageReady) { wantStart = true; return; }    // 镜像没读完 ⇒ 先记下,读完再启动
    if (started) return;
    if (typeof globalThis.__LN_MAIN === 'function') {
      started = true;
      try { globalThis.__LN_MAIN(); }
      catch (e) { console.error('[ln-port] 主脚本启动抛错:', e); }
      /* v4.9.202-扩展移植(1.1.51):扩展菜单(popup)在任意网站按需注入后要喊"打开书库/设置",
         得知道主体跑完了没有(没跑完就开,面板里读到的会是默认设置)⇒ 这里记一个公开记号。 */
      globalThis.__LN_BOOTED = true;
    } else {
      wantStart = true;                                // 主体尚未定义完:由主体收尾那行再喊一次
      globalThis.__LN_PENDING_START = true;
    }
  }
  function markReady() { storageReady = true; start(); }

  /* ============================ 存储 ============================ */
  /* 尽量贴近 TM 的宽容度:类型不符时尽力转换,而不是把 undefined 丢给调用方 */
  function coerce(v, def) {
    if (v === undefined || v === null) return def;
    if (def === undefined || def === null) return v;
    const td = typeof def;
    if (typeof v === td) return v;
    if (td === 'string') {
      if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
      return String(v);
    }
    if (td === 'number') { const n = Number(v); return Number.isFinite(n) ? n : def; }
    if (td === 'boolean') {
      if (v === 'true' || v === '1' || v === 1) return true;
      if (v === 'false' || v === '0' || v === 0) return false;
      return !!v;
    }
    if (td === 'object') {                    // 旧版可能存成了 JSON 字符串
      if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { return JSON.parse(v); } catch (e) {} }
    }
    return v;
  }
  function GM_getValue(key, def) {
    const k = String(key);
    return Object.prototype.hasOwnProperty.call(raw, k) ? coerce(raw[k], def) : def;
  }
  /* v4.9.186-扩展移植:「写入静默失败」正是"界面说已持久化、刷新一次就没了"的根因 ——
     扩展刚被 ↻ 过(老页面失联)时 chrome.storage.local.set 会抛,原来那句空 catch 把它吞了。
     这里只加"喊一声":同一条只 warn 一次(不刷屏),行为与原来完全一致(仍然不向调用方抛)。 */
  let writeWarned = false;
  function noteWriteFail(e) {
    if (writeWarned) return;
    writeWarned = true;
    try { console.warn('[ln-port] 设置写入失败(' + REFRESH_HINT + '):这次改动不会保存;以后不再重复提示。原因:' + String((e && e.message) || e)); } catch (x) {}
  }
  function GM_setValue(key, val) {
    const k = String(key);
    raw[k] = val;
    try { chrome.storage.local.set({ [PFX + k]: val }); } catch (e) { noteWriteFail(e); }
  }
  function GM_deleteValue(key) {
    const k = String(key);
    delete raw[k];
    try { chrome.storage.local.remove(PFX + k); } catch (e) { noteWriteFail(e); }
  }
  function GM_listValues() { return Object.keys(raw); }

  /* ============================ 跨域请求 ============================
     原脚本的取数路径(实测):
       · 站点页面的同源抓取 → fetch / XMLHttpRequest(页面自己就能干)
       · 跨域(模型 CDN / 图床 / 各 AI 平台的余额·模型列表)→ GM_xmlhttpRequest
       · AI 对话的**流式**回答 → fetch + ReadableStream(不是 GM_xhr)⇒ 内容脚本里行为完全一致
     所以这里:同源走页面 XHR(与原来一模一样),跨域才交给 SW。 */
  /* 浏览器**保留头**:脚本设不了 —— XHR 硬设会在控制台报 "Refused to set unsafe header",
     而扩展把内容脚本的 console 错误算作本扩展的错误(会挂到 chrome://extensions 上,用户看到一堆红字)。
     同源请求浏览器本来就会自动带上正确的 Referer;CORS 请求也不许脚本伪造它 ⇒ 一律丢掉最干净。 */
  const FORBIDDEN_HDR = {
    referer: 1, referrer: 1, origin: 1, cookie: 1, 'set-cookie': 1, 'user-agent': 1, host: 1,
    'content-length': 1, connection: 1, te: 1, trailer: 1, 'transfer-encoding': 1, upgrade: 1,
    'accept-encoding': 1, 'accept-charset': 1, via: 1, 'proxy-authorization': 1, 'proxy-connection': 1,
    'x-http-method': 1, 'x-http-method-override': 1, 'x-method-override': 1,
  };

  const progHandlers = new Map();
  let ridSeq = 0;
  const newRid = () => 'r' + (++ridSeq) + '-' + Date.now().toString(36);

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'gmXhrProgress') return;
      const h = progHandlers.get(msg.reqId);
      if (h && h.onprogress) { try { h.onprogress({ loaded: msg.loaded, total: msg.total, lengthComputable: !!msg.total }); } catch (e) {} }
    });
  } catch (e) {}

  const b64ToBytes = (b64) => {
    const bin = atob(b64 || '');
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };

  function GM_xmlhttpRequest(opt) {
    opt = opt || {};
    const type = opt.responseType || 'text';
    const req = {
      aborted: false,
      abort() {
        this.aborted = true;
        if (this._xhr) { try { this._xhr.abort(); } catch (e) {} }
        if (this._rid) { try { chrome.runtime.sendMessage({ type: 'gmXhrAbort', reqId: this._rid }); } catch (e) {} }
      },
    };
    let sameOrigin = false;
    try { sameOrigin = new URL(opt.url, location.href).origin === location.origin; } catch (e) {}

    /* ---- 同源:页面 XHR(cookie / 重定向 / 编码 与"原脚本"一致) ---- */
    if (sameOrigin) {
      let x;
      try {
        x = new XMLHttpRequest();
        req._xhr = x;
        x.open(opt.method || 'GET', opt.url, true);
        if (opt.timeout) x.timeout = opt.timeout;
        if (type === 'arraybuffer' || type === 'blob') x.responseType = type;
        const hs = opt.headers || {};
        for (const k in hs) {
          if (hs[k] == null) continue;
          if (FORBIDDEN_HDR[String(k).toLowerCase()]) continue;   // Referer/Origin/Cookie… 设不了,见上方 FORBIDDEN_HDR
          try { x.setRequestHeader(k, hs[k]); } catch (e) {}
        }
        x.onload = () => {
          if (req.aborted) return;
          const resp = {
            readyState: 4, status: x.status, statusText: x.statusText,
            responseHeaders: (x.getAllResponseHeaders && x.getAllResponseHeaders()) || '',
            finalUrl: x.responseURL || opt.url, responseText: '',
          };
          if (type === 'blob') resp.response = x.response;
          else if (type === 'arraybuffer') resp.response = x.response;
          else {
            resp.responseText = x.responseText || '';
            if (type === 'json') { try { resp.response = JSON.parse(resp.responseText); } catch (e) { resp.response = null; } }
            else resp.response = resp.responseText;
          }
          try { opt.onload && opt.onload(resp); } catch (e) {}
        };
        x.onerror = () => { if (!req.aborted && opt.onerror) opt.onerror(new Error('网络错误')); };
        x.ontimeout = () => { if (!req.aborted && opt.ontimeout) opt.ontimeout(); };
        if (opt.onprogress) x.onprogress = (ev) => { try { opt.onprogress({ loaded: ev.loaded, total: ev.total, lengthComputable: !!ev.lengthComputable }); } catch (e) {} };
        x.send(opt.data === undefined ? null : opt.data);
      } catch (e) { if (opt.onerror) opt.onerror(e); }
      return req;
    }

    /* ---- 跨域:交 SW(它有 host_permissions,不受 CORS 限制) ---- */
    const rid = newRid();
    req._rid = rid;
    if (opt.onprogress) progHandlers.set(rid, opt);
    const binary = (type === 'arraybuffer' || type === 'blob');
    try {
      chrome.runtime.sendMessage({
        type: 'gmXhr', reqId: rid,
        opt: {
          url: opt.url, method: opt.method || 'GET', headers: opt.headers || {},
          data: (typeof opt.data === 'string' || opt.data == null) ? opt.data : JSON.stringify(opt.data),
          timeout: opt.timeout || 0, binary,
        },
      }, (r) => {
        progHandlers.delete(rid);
        if (req.aborted) return;
        if (chrome.runtime.lastError || !r) {
          if (opt.onerror) opt.onerror(friendlyErr(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'SW 无响应')));
          return;
        }
        if (r.timeout) { if (opt.ontimeout) opt.ontimeout(); return; }
        if (!r.ok) { if (opt.onerror) opt.onerror(new Error(r.error || '请求失败')); return; }
        const resp = {
          readyState: 4, status: r.status, statusText: r.statusText,
          responseHeaders: r.headers || '', finalUrl: r.finalUrl || opt.url, responseText: '',
        };
        if (type === 'arraybuffer') resp.response = b64ToBytes(r.b64).buffer;
        else if (type === 'blob') resp.response = new Blob([b64ToBytes(r.b64)], { type: r.ctype || 'application/octet-stream' });
        else {
          resp.responseText = r.text || '';
          if (type === 'json') { try { resp.response = JSON.parse(resp.responseText); } catch (e) { resp.response = null; } }
          else resp.response = resp.responseText;
        }
        try { opt.onload && opt.onload(resp); } catch (e) {}
      });
    } catch (e) {
      /* v4.9.169-扩展移植:失联(扩展刚被 ↻ 过)时 sendMessage 会**同步**抛「Extension context invalidated」,
         原来是原样抛出去的 —— 上面那条跨域失败路径会把它换成"请刷新(F5)"的人话,这一条也得跟上,
         否则用户看到的就是浏览器天书。 */
      if (opt.onerror) opt.onerror(friendlyErr(e));
    }
    return req;
  }

  /* ============================ 暴露 + 预载后启动 ============================ */
  globalThis.GM_getValue = GM_getValue;
  globalThis.GM_setValue = GM_setValue;
  globalThis.GM_deleteValue = GM_deleteValue;
  globalThis.GM_listValues = GM_listValues;
  globalThis.GM_xmlhttpRequest = GM_xmlhttpRequest;
  /* 内容脚本是隔离世界:unsafeWindow 只能给到隔离世界的 window。
     实测原脚本只有 6 处用它,全是调试钩子(__esjDebug.__pzDK 之类),不影响功能。 */
  globalThis.unsafeWindow = window;
  globalThis.__LN_START = start;

  try {
    chrome.storage.local.get(null, (all) => {
      if (chrome.runtime.lastError) {
        /* 走到这里基本都是"刚更新过扩展、老页面没刷新":镜像会是空的(设置看起来像被重置)。
           提醒一句,并让脚本照常启动 —— 它自己随后会报「读取…失败」,那条消息也已换成刷新提示。 */
        console.warn('[ln-port] 扩展存储读取失败(' + chrome.runtime.lastError.message + '):若刚更新过扩展,请刷新本页(F5)');
      } else if (all) {
        for (const k in all) if (k.indexOf(PFX) === 0) raw[k.slice(PFX.length)] = all[k];
      }
      markReady();          // v4.9.187:镜像读完 ⇒ 这时才真正启动主体(见上面 start 的说明)
    });
  } catch (e) { markReady(); }
})();
