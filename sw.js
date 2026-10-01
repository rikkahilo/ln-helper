/* ============================================================================
   sw.js —— Service Worker:只干"页面干不了的事"
   ----------------------------------------------------------------------------
   目前只有一件事:替 GM_xmlhttpRequest 做**跨域**取数(内容脚本受 CORS 限制,
   扩展 SW 有 host_permissions ⇒ 不受限)。
   字节通过 base64 过消息通道(Chrome 的消息是 JSON 序列化,ArrayBuffer 传不过去),
   文本响应按响应头里的 charset 解码(站点里有 GBK 页面)。
   还有第二件事:把内容脚本的**统一库 lnlib** 操作转交给 offscreen 文档
   —— 内容脚本碰不到扩展 origin 的 IndexedDB,那一层由 offscreen 持有。
   ========================================================================== */
const aborts = new Map();
const CH = 0x8000;

/* ---------- 统一库:offscreen 文档的创建与转交 ---------- */
const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen = null;
async function hasOffscreen() {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  } catch (e) {
    try { return await chrome.offscreen.hasDocument(); } catch (e2) { return false; }
  }
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: '持有并读写统一库 lnlib(插图 Blob、模型字节都在这儿)',
    }).catch((e) => {
      if (!/single offscreen|already/i.test(String((e && e.message) || e))) throw e;
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
  return await hasOffscreen();
}

function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64 || '');
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/* ---------- v4.9.190-扩展移植(抓取搬后台①):隐藏工作标签页(串行,一次一页) ----------
   为什么:哔哩/linovelib 对 fetch/XHR 返回乱序正文,只能让浏览器真渲染。原来是在用户正看的
   阅读页里塞隐藏 iframe ⇒ 抢本页主线程(抓取时页面发卡)、本页切后台就被节流、关掉本页就断。
   现在由 SW 开一个**后台标签页**去加载目标页,那页里的同一份内容脚本自己解析完再把结果回传。
   纪律:并发写死 1(串行)、单页加载 30s 超时、45s 没活就关掉标签页、只允许 linovelib/bilinovel。
   代价:标签栏会短暂多出一个后台标签页(浏览器没有"完全不可见"的标签页 API),抓完自动关。 */
const BG_HOSTS = ['linovelib.com', 'bilinovel.com'];
const bgTab = { id: null, host: '' };
let bgNonce = 0;
let bgIdleTimer = null;
let bgChain = Promise.resolve();
function bgClose() {
  if (bgIdleTimer) { clearTimeout(bgIdleTimer); bgIdleTimer = null; }
  if (bgTab.id != null) { try { chrome.tabs.remove(bgTab.id); } catch (e) {} }
  bgTab.id = null; bgTab.host = '';
}
function bgTouch() {
  if (bgIdleTimer) clearTimeout(bgIdleTimer);
  bgIdleTimer = setTimeout(bgClose, 45000);
}
function bgEnqueue(fn) {
  const p = bgChain.then(fn, fn);
  bgChain = p.then(() => {}, () => {});
  return p;
}
function bgTag(url) {
  return url + (url.indexOf('#') < 0 ? '#lnbg=1&n=' : '&lnbg=1&n=') + (++bgNonce);
}
function bgWaitLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
      resolve(ok);
    };
    const onUpd = (id, info) => { if (id === tabId && info && info.status === 'complete') finish(true); };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(() => finish(false), timeoutMs || 30000);
  });
}
async function bgSendJob(tabId, msg, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, msg);
      if (r) return r;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}
async function bgRunPage(url, novelId, chapterId) {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; } })();
  if (!host || !BG_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return { ok: false, error: '不在允许的站点里:' + host };
  let tabId = bgTab.id;
  if (tabId != null && bgTab.host !== host) { bgClose(); tabId = null; }
  if (tabId != null) { try { await chrome.tabs.get(tabId); } catch (e) { tabId = null; bgTab.id = null; bgTab.host = ''; } }
  if (tabId == null) {
    const t = await chrome.tabs.create({ url: bgTag(url), active: false });
    tabId = t.id;
    bgTab.id = tabId; bgTab.host = host;
  } else {
    await chrome.tabs.update(tabId, { url: bgTag(url) });
  }
  bgTouch();
  const loaded = await bgWaitLoad(tabId, 30000);
  if (!loaded) { bgClose(); return { ok: false, error: '工作标签页加载超时' }; }
  const r = await bgSendJob(tabId, { type: 'lnBgPage', url: url, novelId: novelId, chapterId: chapterId }, 5);
  bgTouch();
  /* v4.9.191:失败就把这个标签页扔掉 —— 尤其被 Cloudflare 拦住时,别让一个"已经惹毛站点"的
     页面继续留着被反复导航;下次重开就是干净的一份。 */
  if (!r) { bgClose(); return { ok: false, error: '工作标签页没有回应(内容脚本没注入?)' }; }
  if (r.ok === false) { bgClose(); return r; }
  /* v4.9.194:页面之间留 1000ms —— 工作标签页的加载本身不受后台节流,但请求速率必须和"静默抓取"那条路
     完全对齐(LN_PAGE_GAP_MS = 1000),不然"开了开关就明显变快"更容易招站点限流(这是 1015 那次学到的)。 */
  await new Promise((res) => setTimeout(res, 1000));
  return r;
}

/* v4.9.191:清残留 —— SW 被回收时那个 45s 定时器可能没来得及跑,于是启动/安装时扫一遍
   带 #lnbg=1 的后台标签页(那是自家工作页的唯一标记)全部关掉,不留垃圾标签页。 */
function bgSweep() {
  try {
    chrome.tabs.query({}, (tabs) => {
      if (!tabs) return;
      for (const t of tabs) {
        if (t && t.url && t.url.indexOf('#lnbg=1') >= 0) { try { chrome.tabs.remove(t.id); } catch (e) {} }
      }
    });
  } catch (e) {}
}
try { chrome.runtime.onStartup.addListener(bgSweep); } catch (e) {}
try { chrome.runtime.onInstalled.addListener(bgSweep); } catch (e) {}
/* 1.1.66(P1-1):预热 —— SW 一启动就把 offscreen 拉起,首次用户操作不再等冷启动 */
function warmOffscreen() { ensureOffscreen().catch(() => {}); }
try { chrome.runtime.onStartup.addListener(warmOffscreen); } catch (e) {}
try { chrome.runtime.onInstalled.addListener(warmOffscreen); } catch (e) {}

/* ---------- v4.9.202-扩展移植(1.1.51):扩展菜单(工具栏 popup) ----------
   用户要的是「缓存管理 / 设置 / 版本信息 —— 任意网站随时打开书库」。
   面板与设置对话框都活在**页面侧的内容脚本**里(要用页面 DOM、要和站点页同一份环境),
   所以 popup 不自己画一份,而是"在本页把脚本请出来":
     ① 本页已有内容脚本(10 个站点之一)⇒ 直接 sendMessage 让它开对话框(零成本);
     ② 没有(任意网站)⇒ 用 scripting.executeScript **按需注入与站点页同一个注入集**,再喊一次。
   注入走隔离世界、不受页面 CSP 影响;浏览器内置页 / 扩展页 / 应用商店页注入不了,如实报错。 */
const LN_UI_FILES = [
  'lib/fflate.js', 'lib/ln-pre.js', 'lib/ort.wasm.min.js', 'lib/eSearchOCR.umd.js',
  'gm-shim.js', 'ln-codec.js', 'ln-store.js', 'ln-main.js',
];
function lnUiErr(e) {
  const m = String((e && e.message) || e || '');
  if (/cannot access|chrome:\/\/|edge:\/\/|about:|extension:\/\//i.test(m)) {
    return '这个页面不允许扩展注入(浏览器内置页 / 应用商店 / 其它扩展的页面),换个普通网页再试';
  }
  return m || '打开失败';
}
async function lnUiAsk(tabId, target, tries, gap) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'lnUiOpen', target: target });
      if (r && r.ok) return { ok: true };
      if (r && r.error) return { ok: false, error: String(r.error) };
    } catch (e) { /* 本页还没有内容脚本:等下注入 */ }
    if (gap) await new Promise((res) => setTimeout(res, gap));
  }
  return null;
}
async function lnUiOpen(tabId, target) {
  if (!tabId) return { ok: false, error: '拿不到当前标签页' };
  const first = await lnUiAsk(tabId, target, 1, 0);
  if (first) return first;
  if (!chrome.scripting || !chrome.scripting.executeScript) return { ok: false, error: '没有 scripting 权限' };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: false }, files: LN_UI_FILES });
  } catch (e) {
    return { ok: false, error: lnUiErr(e) };
  }
  const second = await lnUiAsk(tabId, target, 10, 400);
  if (second) return second;
  return { ok: false, error: '脚本注入了但没有回应(可到扩展的「错误」列表看看有没有报错)' };
}
/* 版本信息里的"统一库规模":数量与占用都问 offscreen(它持有 lnlib);问不到就如实留空 */
async function lnUiCounts() {
  const out = { books: null, chapters: null, images: null, usage: null, quota: null };
  try {
    if (!(await ensureOffscreen())) return out;
    const ask = (op, store) => chrome.runtime.sendMessage(Object.assign(
      { __to: 'offscreen', type: 'uniOp', op: op }, store ? { store: store } : {}));
    for (const p of [['books', 'meta'], ['chapters', 'chapters'], ['images', 'images']]) {
      try { const r = await ask('count', p[1]); if (r && r.ok) out[p[0]] = r.n; } catch (e) {}
    }
    try { const r = await ask('estimate'); if (r && r.ok) { out.usage = r.usage; out.quota = r.quota; } } catch (e) {}
  } catch (e) {}
  return out;
}

/* ============================================================================
   1.1.66(P0-1 / P0-2):长连接 Port 桥 + SW 会话级缓存
   ----------------------------------------------------------------------------
   内容脚本每次库读原本是 sendMessage 一请求一往返;现在内容脚本 / offscreen 各连一条
   持久 Port 到 SW,SW 在中间双向转发(页面请求经 page port 进来 → off port 转给 offscreen;
   offscreen 响应经 off port 回来 → 按 __src 路由回原页面)。一条连接承载多个请求(多路复用)。
   同一份转发逻辑顺带做「会话级共享缓存」:读类 op 的结果按 store/key 缓存在 SW 内存
   (多标签页共享,重开面板 / 回读章节不再重复打到 offscreen),写类 op 一律失效缓存。
   缓存存 offscreen 的**原始响应**(载荷保持 pack 态),SW 不参与编解码。
   兜底:port 不可用(扩展刚重载 / SW 冷启动)时,内容脚本回退 sendMessage,onMessage 老路
   照常可用(也吃同一份缓存)。缓存随 SW 休眠自然清空,没有一致性问题。 */
const pagePorts = new Map();
let offPort = null;
let portSeq = 0;

/* ---------- SW 会话级缓存(P0-2) ---------- */
const LN_CACHE = new Map();
const LN_CACHE_MAX = 400;
const LN_CACHE_TTL = { get: 600000, getMeta: 600000, has: 10000, getMany: 600000, all: 20000, chaptersBrief: 20000, chaptersOf: 20000, count: 20000, keys: 20000 };
const LN_WRITE_OPS = { put: 1, del: 1, delMany: 1, clear: 1, delBySite: 1, bigPutEnd: 1 };
/* P1-3:DNR referer 规则"最近使用"登记 —— 页面申请规则时记录时间戳,供接近上限时巡检淘汰 */
const refererSeen = new Map();
function lnCacheKey(op, msg) {
  if (op === 'get' || op === 'getMeta' || op === 'has') return op + ':' + msg.store + ':' + String(msg.key);
  if (op === 'getMany') return op + ':' + msg.store + ':' + String((msg.keys || []).join(','));
  if (op === 'chaptersBrief' || op === 'chaptersOf') return op + ':' + String(msg.novelId);
  if (op === 'all' || op === 'count' || op === 'keys') return op + ':' + msg.store + (op === 'all' ? ':' + (msg.stripBlobs ? 1 : 0) : '');
  return null;
}
function lnCacheGet(op, msg) {
  const k = lnCacheKey(op, msg);
  if (!k) return null;
  const hit = LN_CACHE.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > (LN_CACHE_TTL[op] || 20000)) { LN_CACHE.delete(k); return null; }
  return hit.r;
}
function lnCacheSet(op, msg, r) {
  const k = lnCacheKey(op, msg);
  if (!k || !r || !r.ok) return;
  LN_CACHE.set(k, { at: Date.now(), r });
  if (LN_CACHE.size > LN_CACHE_MAX) {
    let n = LN_CACHE.size - LN_CACHE_MAX;
    for (const kk of LN_CACHE.keys()) { if (n-- <= 0) break; LN_CACHE.delete(kk); }
  }
}
function lnCacheInvalidate(store) {
  for (const k of LN_CACHE.keys()) {
    if (k.indexOf('chaptersBrief:') === 0 || k.indexOf('chaptersOf:') === 0 ||
        (store && k.indexOf(':' + store + ':') >= 0)) LN_CACHE.delete(k);
  }
}
/* 兜底转发:page port 请求或内容脚本 sendMessage 请求 → 经 sendMessage 打到 offscreen(带缓存) */
async function routeUniOpViaMessage(msg, sendResponse) {
  try {
    if (LN_WRITE_OPS[msg.op]) lnCacheInvalidate(msg.store);
    const hit = lnCacheGet(msg.op, msg);
    if (hit) { sendResponse(hit); return; }
    if (!(await ensureOffscreen())) { sendResponse({ ok: false, error: 'offscreen 文档创建失败' }); return; }
    const r = await chrome.runtime.sendMessage(Object.assign({ __to: 'offscreen' }, msg));
    lnCacheSet(msg.op, msg, r);
    maybePrefetchChapters(msg, r);
    sendResponse(r);
  } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
}
function stripMeta(resp) {
  const rest = {};
  for (const k of Object.keys(resp)) {
    if (k !== '__offResp' && k !== '__src' && k !== '__op' && k !== '__store' && k !== '__key' && k !== '__novelId' && k !== '__keys' && k !== '__stripBlobs') rest[k] = resp[k];
  }
  return rest;
}
function pagePortSend(port, resp, rid) {
  /* 注意顺序:缓存的响应里可能带着它入库时的旧 rid,必须把新 rid 放在**后面**覆盖,
     否则缓存命中时调用方永远等不到自己的 rid */
  try { port.postMessage(rid == null ? resp : Object.assign({}, resp, { rid: rid })); } catch (e) {}
  /* bfcache / 页面关闭会让端口静默失效:postMessage 的失败标志在 runtime.lastError 上,
     不读取它 Chrome 就打 "Unchecked runtime.lastError"。读取即消费;返回 false 供调用方清理死端口。 */
  if (chrome.runtime && chrome.runtime.lastError) { void chrome.runtime.lastError; return false; }
  return true;
}

/* P0-3:章节预取流水线(纯桥接层,不改 ln-main 调用点)
   —— 阅读器翻页 get 章节正文后,顺带问 offscreen 拿同书相邻章节(pack 态)写进会话缓存,
      翻到下一章时直接命中 SW 缓存,省一次 offscreen 往返。
   约束:单章 val ≤ 256KB、同书 60s 节流、fire-and-forget 不阻塞当前响应、并发去重。 */
const LN_PREFETCH_RANGE = 1;
const LN_PREFETCH_THROTTLE = 60000;
const LN_PREFETCH_MAXVAL = 262144;
const prefetchLast = new Map();
const prefetchInflight = new Set();
function chapterKeyParts(k) {
  const s = String(k || '');
  const sp = s.lastIndexOf('/');
  if (sp <= 0 || sp === s.length - 1) return null;
  return { novelId: s.slice(0, sp), chapterId: s.slice(sp + 1) };
}
async function lnOffCall(op, msg) {
  try {
    return await chrome.runtime.sendMessage(Object.assign({ __to: 'offscreen', type: 'uniOp', op: op }, msg));
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
function maybePrefetchChapters(msg, resp) {
  if (!resp || !resp.ok || !msg) return;
  const op = msg.op;
  if (op !== 'get' && op !== 'getMany') return;
  if (msg.store !== 'chapters') return;
  let k = '';
  if (op === 'get') k = msg.key;
  else {
    const keys = (msg.keys || []).filter(x => typeof x === 'string' && x.indexOf('/') > 0);
    if (!keys.length) return;
    k = keys[0];
  }
  const parts = chapterKeyParts(k);
  if (!parts) return;
  const now = Date.now();
  if ((prefetchLast.get(parts.novelId) || 0) && now - (prefetchLast.get(parts.novelId) || 0) < LN_PREFETCH_THROTTLE) return;
  prefetchLast.set(parts.novelId, now);
  const inflightId = parts.novelId + '/' + parts.chapterId;
  if (prefetchInflight.has(inflightId)) return;
  prefetchInflight.add(inflightId);
  (async () => {
    try {
      const r = await lnOffCall('chapterNeighbors', { novelId: parts.novelId, chapterId: parts.chapterId, range: LN_PREFETCH_RANGE });
      const neighbors = (r && r.ok && Array.isArray(r.neighbors)) ? r.neighbors : [];
      for (const nb of neighbors) {
        if (!nb || !nb.key || !nb.resp || !nb.resp.ok) continue;
        if (String(nb.resp.val || '').length > LN_PREFETCH_MAXVAL) continue;
        if (LN_CACHE.has('get:chapters:' + nb.key)) continue;
        lnCacheSet('get', { store: 'chapters', key: nb.key }, nb.resp);
      }
    } catch (e) {} finally { prefetchInflight.delete(inflightId); }
  })();
}
/* ---------- 长连接桥(P0-1):内容脚本 page port ⇄ offscreen off port ---------- */
chrome.runtime.onConnect.addListener((port) => {
  const name = String(port.name || '');
  const s = port.sender || {};
  if (name === 'lnstore-off') {
    offPort = port;
    port.onMessage.addListener((resp) => {
      if (!resp || !resp.__offResp) return;
      /* 响应经 off port 回来:读类顺带写回会话缓存(写类已在请求侧失效,这里自然跳过) */
      if (resp.__op) {
        lnCacheSet(resp.__op, { store: resp.__store, key: resp.__key, novelId: resp.__novelId, keys: resp.__keys, stripBlobs: resp.__stripBlobs }, resp);
        maybePrefetchChapters({ op: resp.__op, store: resp.__store, key: resp.__key, keys: resp.__keys }, resp);
      }
      const src = resp.__src;
      const p = src && pagePorts.get(src);
      if (p) {
        if (!pagePortSend(p, stripMeta(resp))) pagePorts.delete(src);   // 端口已死(bfcache 等):顺手清表,别再试
      }
    });
    port.onDisconnect.addListener(() => { if (offPort === port) offPort = null; });
    return;
  }
  if (name === 'lnstore-page') {
    const key = 'p' + (++portSeq) + ':' + ((s.tab && s.tab.id) || 0) + ':' + ((s.frameId != null ? s.frameId : 0));
    pagePorts.set(key, port);
    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'uniOp') return;
      (async () => {
        try {
          if (LN_WRITE_OPS[msg.op]) lnCacheInvalidate(msg.store);
          const hit = lnCacheGet(msg.op, msg);
          if (hit) { pagePortSend(port, stripMeta(hit), msg.rid); return; }
          if (!offPort && !(await ensureOffscreen())) {
            pagePortSend(port, { ok: false, error: 'offscreen 文档创建失败' }, msg.rid);
            return;
          }
          if (offPort) {
            try {
              offPort.postMessage(Object.assign({ __to: 'offscreen', __src: key }, msg));
            } catch (e) { await routeUniOpViaMessage(msg, (r) => pagePortSend(port, r, msg.rid)); }
            return;
          }
          await routeUniOpViaMessage(msg, (r) => pagePortSend(port, r, msg.rid));
        } catch (e) { pagePortSend(port, { ok: false, error: String((e && e.message) || e) }, msg.rid); }
      })();
    });
    port.onDisconnect.addListener(() => { pagePorts.delete(key); });
  }
});
/* 诊断快照(只读):SW 控制台直接 globalThis.__lnDebug()(顶层挂载,SW 加载即生效,不经消息通道);
   页面侧经 chrome.runtime.sendMessage({type:'lnDebug'}) 走 onMessage 分支。
   注意:SW 收不到自己发的 runtime 消息,所以从 SW 控制台发 sendMessage 没用,必须直读。 */
function lnDebugSnapshot() {
  const _getKeys = [];
  for (const _k of LN_CACHE.keys()) { if (_k.indexOf('get:chapters:') === 0) _getKeys.push(_k); }
  return { cacheSize: LN_CACHE.size, prefetchedChapters: _getKeys, prefetchInflight: prefetchInflight.size };
}
try { globalThis.__lnDebug = lnDebugSnapshot; } catch (e) {}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.__to === 'offscreen') return;          // 转发给 offscreen 的消息不由 SW 处理
  /* 验收/诊断钩子(只读):**在小说站点页面控制台**执行
     chrome.runtime.sendMessage({type:'lnDebug'}, r=>console.log(JSON.stringify(r))) */
  if (msg.type === 'lnDebug') {
    sendResponse(Object.assign({ ok: true }, lnDebugSnapshot()));
    return true;   // 必须 return true:SW 收到响应前消息端口不可关闭(否则报 Unchecked port closed)
  }
  /* 统一库操作:转交 offscreen(它持有 lnlib),结果原样带回内容脚本 */
  if (msg.type === 'uniOp') {
    /* 1.1.66:统一走带缓存的转发(page port 桥之外的兜底路径) */
    routeUniOpViaMessage(msg, sendResponse);
    return true;
  }
  /* v4.9.184(六项路线 ④):按需把本地 OpenCC 注进内容脚本所在的**隔离世界**(和内容脚本共享 globalThis)。
     内容脚本自己 import() 会被页面 CSP 拦、eval/new Function 被扩展 CSP 拦,只有 scripting 注入是稳的;
     注一次就一直在(不需要每页重新解析 1.1 MB)。注入目标必须和内容脚本同 world、同 frame。 */
  if (msg.type === 'openccInject') {
    const _t = sender && sender.tab && sender.tab.id;
    if (!_t) { sendResponse({ ok: false, error: '拿不到 tabId' }); return; }
    if (!chrome.scripting || !chrome.scripting.executeScript) { sendResponse({ ok: false, error: '没有 scripting 权限' }); return; }
    chrome.scripting.executeScript({ target: { tabId: _t }, files: ['lib/opencc.js'] })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  /* v4.9.185-扩展移植(六项路线 ③):面板「🗄 其他存储 · 🧩 扩展侧」的「卸载常驻 OCR 引擎」。
     引擎活在 offscreen 文档的内存里 ⇒ 关掉这个文档就等于卸载(模型在库里,字节一个不动);
     下次要用时按老路 ensureOffscreen 重新拉起,建引擎几秒~十几秒。 */
  if (msg.type === 'engineUnload') {
    chrome.offscreen.closeDocument()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  /* v4.9.189-扩展移植(六项路线 ⑥):Referer 覆写 —— 有些图床/图站查 Referer 防盗链,而浏览器
     不允许脚本设这个头(XHR / fetch 设了会被拒)⇒ 只能在**网络层**改:用 declarativeNetRequest 的
     动态规则,给「某个图片主机」补上「某个站点来源」的 Referer。
     规则由页面按需申请(它知道自己的 origin 和用到的图床主机),SW 只负责登记/撤销:
     一个主机一条(id 由主机名定点,重复申请就覆盖同一条),最多 50 条,绝不碰别的请求。 */
  if (msg.type === 'refererFix' || msg.type === 'refererClear' || msg.type === 'refererList') {
    if (!chrome.declarativeNetRequest) { sendResponse({ ok: false, error: '没有 declarativeNetRequest 权限' }); return; }
    (async () => {
      const cur = await chrome.declarativeNetRequest.getDynamicRules();
      if (msg.type === 'refererList') {
        return { ok: true, list: cur.map((r) => ({ id: r.id, host: String((r.condition && r.condition.urlFilter) || '').replace(/\|\||\^/g, ''), referer: (((r.action || {}).requestHeaders || [{}])[0] || {}).value || '' })) };
      }
      if (msg.type === 'refererClear') {
        const ids = cur.map((r) => r.id);
        if (ids.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
        return { ok: true, n: 0 };
      }
      const host = String(msg.host || '').trim().toLowerCase();
      const ref = String(msg.referer || '').trim();
      if (!host || !ref) return { ok: false, error: '缺 host / referer' };
      const hit = cur.find((r) => String((r.condition && r.condition.urlFilter) || '').toLowerCase().indexOf(host) >= 0);
      refererSeen.set(host, Date.now());   /* 登记最近使用,供巡检淘汰 */
      if (hit) {
        const old = (((hit.action || {}).requestHeaders || [{}])[0] || {}).value || '';
        if (old === ref) return { ok: true, id: hit.id, cached: true };
      }
      /* P1-3:DNR 巡检 —— 接近上限(50)时,按"最近使用"淘汰最老的登记规则腾位。
         只动本 SW 生命周期内申请过的规则,绝不误删未知规则;页面仍在用的会在下一张图
         加载时重新申请回来。SW 重启后 refererSeen 为空 ⇒ 不做激进清理。 */
      if (!hit && cur.length >= 45) {
        const stale = [...refererSeen.entries()].sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, cur.length - 40));
        const staleIds = [];
        for (const [h] of stale) {
          const r0 = cur.find((r) => String((r.condition && r.condition.urlFilter) || '').toLowerCase().indexOf(h) >= 0);
          if (r0) staleIds.push(r0.id);
          refererSeen.delete(h);
        }
        if (staleIds.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: staleIds });
      }
      if (!hit && cur.length >= 50) return { ok: false, error: '动态规则已达上限(50)' };
      const id = hit ? hit.id : (10000 + (host.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 8000, 7)));
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [id],
        addRules: [{
          id: id,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: ref }] },
          condition: { urlFilter: '||' + host + '^', resourceTypes: ['image', 'media', 'xmlhttprequest', 'other'] },
        }],
      });
      return { ok: true, id: id, host: host };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  /* v4.9.190-扩展移植(抓取搬后台①):页面要一页正文 ⇒ 用隐藏工作标签页加载并解析(串行排队)。
     失败如实回报(内容脚本自然会回退到它自己的隐藏 iframe 老路),绝不假装成功。 */
  if (msg.type === 'bgTabPage') {
    bgEnqueue(() => bgRunPage(String(msg.url || ''), String(msg.novelId || ''), String(msg.chapterId || '')))
      .then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'bgTabClose') {
    bgClose();
    sendResponse({ ok: true });
    return;
  }
  /* 1.1.51:扩展菜单的两个入口(说明见上面 LN_UI_FILES / lnUiOpen 那段) */
  if (msg.type === 'lnUiOpen') {
    lnUiOpen(msg.tabId, String(msg.target || 'cache'))
      .then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'lnVersionInfo') {
    (async () => {
      const m = chrome.runtime.getManifest();
      const counts = await lnUiCounts();
      return { ok: true, name: m.name, version: m.version, counts: counts, usage: counts.usage, quota: counts.quota };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'gmXhrAbort') {
    const c = aborts.get(msg.reqId);
    if (c) c.abort();
    return;
  }
  if (msg.type !== 'gmXhr') return;
  const opt = msg.opt || {};
  const tabId = sender && sender.tab && sender.tab.id;
  const reqId = msg.reqId;
  const ctl = new AbortController();
  aborts.set(reqId, ctl);
  let timedOut = false;
  const to = opt.timeout ? setTimeout(() => { timedOut = true; ctl.abort(); }, opt.timeout) : null;

  (async () => {
    try {
      const init = {
        method: opt.method || 'GET',
        headers: opt.headers || {},
        redirect: 'follow',
        credentials: 'include',       // 对上 TM 默认带 cookie 的行为
        signal: ctl.signal,
      };
      const m = init.method.toUpperCase();
      if (opt.data != null && m !== 'GET' && m !== 'HEAD') {
        init.body = opt.data;
      }
      const resp = await fetch(opt.url, init);
      const headers = [...resp.headers.entries()].map(([k, v]) => k + ': ' + v).join('\r\n');
      const ctype = resp.headers.get('content-type') || '';
      const base = {
        ok: true, status: resp.status, statusText: resp.statusText,
        headers, finalUrl: resp.url || opt.url, ctype,
      };
      if (opt.binary) {
        /* 二进制响应**也要报进度**:OCR 模型是 155 MB 的 zip,经 SW 跨域下载时原来是 arrayBuffer()
           一口气读完 ⇒ 页面侧的 onprogress 一次都不响 ⇒「首次加载」那条进度条整段消失
           (油猴里由 XHR 自己上报,所以以前有)。这里改成流式读 + 节流上报,与下面的文本分支同款;
           字节仍原样回传(先攒成数组,进度事件不改变回传内容)。 */
        const breader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
        if (!breader) {
          const buf = new Uint8Array(await resp.arrayBuffer());
          sendResponse(Object.assign(base, { b64: bytesToB64(buf) }));
          return;
        }
        const btotal = +(resp.headers.get('content-length') || 0) || 0;
        const bchunks = [];
        let bloaded = 0, blastAt = 0;
        for (;;) {
          const { done, value } = await breader.read();
          if (done) break;
          bchunks.push(value);
          bloaded += value.byteLength;
          const now = Date.now();
          if (tabId && now - blastAt > 200) {     // 节流:155 MB 也别刷出消息风暴
            blastAt = now;
            try { chrome.tabs.sendMessage(tabId, { type: 'gmXhrProgress', reqId, loaded: bloaded, total: btotal }); } catch (e) {}
          }
        }
        if (tabId) { try { chrome.tabs.sendMessage(tabId, { type: 'gmXhrProgress', reqId, loaded: bloaded, total: btotal || bloaded }); } catch (e) {} }
        const ball = new Uint8Array(bloaded);
        let boff = 0;
        for (const c of bchunks) { ball.set(c, boff); boff += c.byteLength; }
        sendResponse(Object.assign(base, { b64: bytesToB64(ball) }));
        return;
      }
      /* 文本:流式读 + 顺带把下载进度报给页面(模型下载的进度条要用 onprogress) */
      const cs = (ctype.match(/charset=([\w-]+)/i) || [])[1];
      const dec = (() => { try { return new TextDecoder(cs || 'utf-8'); } catch (e) { return new TextDecoder('utf-8'); } })();
      let text = '';
      const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
      if (reader) {
        const total = +(resp.headers.get('content-length') || 0) || 0;
        let loaded = 0, lastAt = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          loaded += value.byteLength;
          text += dec.decode(value, { stream: true });
          const now = Date.now();
          if (tabId && now - lastAt > 120) {      // 节流,避免消息风暴
            lastAt = now;
            try { chrome.tabs.sendMessage(tabId, { type: 'gmXhrProgress', reqId, loaded, total }); } catch (e) {}
          }
        }
        text += dec.decode();
      } else {
        text = dec.decode(new Uint8Array(await resp.arrayBuffer()));
      }
      sendResponse(Object.assign(base, { text }));
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e), timeout: timedOut });
    } finally {
      if (to) clearTimeout(to);
      aborts.delete(reqId);
    }
  })();

  return true;   // 异步 sendResponse
});
