/* ============================================================================
   offscreen-db.js —— 统一库 lnlib 的真正持有者(扩展 origin 下的 IndexedDB)
   ----------------------------------------------------------------------------
   表结构**沿用原脚本**:meta(keyPath novelId) / chapters(keyPath key) /
   images(keyPath url) / settings(keyPath key) —— 一个字都不用改语义,只是
   "不再按域名分库存"。所以内容脚本那边只是把 8 个数据层函数转过来而已。

   收到 SW 转来的 { __to:'offscreen', type:'uniOp', op, ... },做完回 JSON(二进制走 ln-codec)。
   ========================================================================== */
const UNI_DB = 'lnlib';
const UNI_VERSION = 1;
const UNI_STORES = ['meta', 'chapters', 'images', 'settings'];
const LNC = globalThis.LN_CODEC;

let uniPromise = null;
function openUni() {
  if (uniPromise) return uniPromise;
  uniPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(UNI_DB, UNI_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'novelId' });
      if (!db.objectStoreNames.contains('chapters')) db.createObjectStore('chapters', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return uniPromise;
}

/* 单次操作:开事务 → 拿请求 → 等事务完成 → 用请求的 result */
function withStore(db, store, mode, fn) {
  const t = db.transaction(store, mode);
  const req = fn(t.objectStore(store));
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  });
  return { req, done };
}

/* 插图记录里那个 blob 字段(以及模型字节那种 ArrayBuffer 字段)不要随列表回传 ——
   它们可能有几十上百 MB,而调用方拿列表时只用 url。 */
function stripBinary(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    /* Blob 换成同尺寸占位:列表的调用方只用到 url,但有的地方会读 im.blob.size 统计字节数 —— 占位后照样对 */
    if (typeof Blob !== 'undefined' && v instanceof Blob) { out[k] = { size: v.size, type: v.type || '', stub: true }; continue; }
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) { out[k + '_bytes'] = v.byteLength || v.length || 0; continue; }
    out[k] = v;
  }
  return out;
}

/* ---- 只回"元信息 + 字节数"的读:面板只想显示「占用了多大」,而字模 24 MB、模型几十 MB、
        wasm 十几 MB —— 原来这些二进制都经 ln-codec base64 过一遍消息通道(JSON),几十 MB 的字符串
        搬进搬出,面板当然不可能秒开。这里把它们换成**能回答 .size / .byteLength 的占位对象**
        (递归剥到第 4 层,兼容模型记录里 {files:{名字: Uint8Array}} 那种嵌套),调用方代码不用改。 ---- */
function stripDeep(v, depth) {
  depth = depth || 0;
  if (v == null || typeof v !== 'object' || depth > 4) return v;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return { size: v.size, byteLength: v.size, type: v.type || '', stub: true };
  if (v instanceof ArrayBuffer) return { size: v.byteLength, byteLength: v.byteLength, stub: true };
  if (ArrayBuffer.isView(v)) return { size: v.byteLength, byteLength: v.byteLength, stub: true };
  if (Array.isArray(v)) { const a = []; for (const x of v) a.push(stripDeep(x, depth + 1)); return a; }
  const out = {};
  for (const k of Object.keys(v)) out[k] = stripDeep(v[k], depth + 1);
  return out;
}
/* 章节正文(含译文/原文备份)的 UTF-8 字节数 —— 与脚本里 buildBookRows 的 textSizeOf 同口径,
   那边拿不到 blocks 时就用这个 __textBytes。 */
function textBytesOf(c) {
  const enc = new TextEncoder();
  const one = (b) => { try { return b ? enc.encode(JSON.stringify(b)).length : 0; } catch (e) { return 0; } };
  return one(c.blocks) + one(c.origBlocks) + one(c.aiBlocks) + one(c.preAiBlocks);
}
/* ---- 跨站"单条读"的兜底 ------------------------------------------------------------
   统一库里:meta 的键 = 记录自带的 novelId、chapters 的键 = `<novelId>/<cid>`,
   两者都带"站点模块"前缀(esjzone|1788802361)。而内容脚本侧加前缀用的是**当前站点**
   ⇒ 在 linovelib 上点开一本 ESJ 的书,单条读查的是 linovelib|1788802361 ⇒ 查不到。
   (章节**列表**那条路是整表按裸 id 筛,所以只有单条读会中招 —— 书名退回「小说 <id>」就是这个。)
   这里按"去掉前缀后的裸键"建一份索引,精确键没命中时拿它兜底:两边谁带前缀都能对上。
   索引只在内存里、按需建一次;任何写入/删除都作废重建。 */
const keyIdx = { meta: null, chapters: null };
const bareKey = (k) => String(k == null ? '' : k).split('|').pop();
async function idxOf(db, store) {
  if (keyIdx[store]) return keyIdx[store];
  const m = new Map();
  try {
    const ks = await new Promise((res) => {
      const rq = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });
    for (const k of ks) { const b = bareKey(k); if (!m.has(b)) m.set(b, k); }
  } catch (e) {}
  keyIdx[store] = m;
  return m;
}
async function resolveKey(db, store, key) {
  if (store !== 'meta' && store !== 'chapters') return key;
  try { const hit = (await idxOf(db, store)).get(bareKey(key)); return hit == null ? key : hit; } catch (e) { return key; }
}
/* 只回"元信息"的读(二进制经 stripDeep 换成占位):字模/模型/ORT 缓存那些大件靠它只看大小 */
async function opGetMeta(store, key) {
  const db = await openUni();
  let { req, done } = withStore(db, store, 'readonly', (os) => os.get(key));
  await done;
  let rec = req.result;
  if (rec == null) {
    const k2 = await resolveKey(db, store, key);
    if (k2 !== key) { const r2 = withStore(db, store, 'readonly', (os) => os.get(k2)); await r2.done; rec = r2.req.result; }
  }
  return { ok: true, val: rec == null ? null : LNC.pack(stripDeep(rec)) };
}
/* 取一本书的章节记录 —— 走"裸键索引"只读**这本书的键**,不再 `getAll()` 整表之后逐条筛。
   (上一版是整表取:一千本书的库,每开一次阅读器 / 导出 / 采集都要把所有章节**记录**过一遍。) */
async function getsOf(db, store, keys) {
  return await new Promise((res) => {
    if (!keys || !keys.length) return res([]);
    const out = [];
    const t = db.transaction(store, 'readonly');
    const os = t.objectStore(store);
    t.oncomplete = () => res(out);
    t.onerror = () => res(out);
    t.onabort = () => res(out);
    for (const k of keys) {
      try { const rq = os.get(k); rq.onsuccess = () => { if (rq.result != null) out.push(rq.result); }; } catch (e) {}
    }
  });
}
/* 批量按 key 取(封面缩略图这类"一次要好几张"的读)。
   原来是每张各发一次单条读 —— 70 本书 = 70 个消息来回,刷新页面后第一次打开缓存管理就那么慢。
   二进制经 LNC.enc 再 pack 一次回;取不到的返回 null(调用方自己兜底)。 */
async function opGetMany(store, keys) {
  const db = await openUni();
  const list = Array.isArray(keys) ? keys : [];
  const vals = [];
  if (!list.length) return { ok: true, vals: LNC.pack(vals), total: 0 };
  const keyOf = (rec) => (store === 'meta' ? rec.novelId : (store === 'images' ? rec.url : rec.key));
  const got = await getsOf(db, store, list);
  const byKey = new Map();
  for (const rec of got) { try { byKey.set(String(keyOf(rec)), rec); } catch (e) {} }
  for (const k of list) {
    let rec = byKey.get(String(k)) || null;
    if (rec == null) {                                  // 跨站:换个前缀的同一个 id 也要能读到
      const k2 = await resolveKey(db, store, k);
      if (k2 !== k) { const r2 = withStore(db, store, 'readonly', (os) => os.get(k2)); await r2.done; rec = r2.req.result; }
    }
    vals.push(rec == null ? null : await LNC.enc(rec));
  }
  return { ok: true, vals: LNC.pack(vals), total: vals.length };
}
/* ============================================================================
   v4.9.169-扩展移植:超大记录的**分片搬运**(几十 MB 的 OCR 模型 / onnxruntime 运行时)
   ----------------------------------------------------------------------------
   为什么要它:内容脚本 ⇄ offscreen 走 chrome.runtime.sendMessage,载荷是 **JSON 序列化**。
   一条消息塞几十 MB(base64 之后还要 ×1.33),轻则慢得像卡死、重则整条失败 —— 而失败常被上层的
   try{}catch(e){} 吞掉,表现成"明明下过模型却当成没缓存 ⇒ 清掉缓存重下 ⇒ 网络不通报错"。
   做法:读方向把**编码后的整条 JSON 字符串**缓存住,内容脚本按 3 MB 一片取(十来个来回)再拼回;
   写方向内容脚本一片片发来,这里拼齐后一次性落库。统一库因此仍是**唯一真源(跨站点共用)**,
   页面本地库那份只是"读缓存"(页面内直读、秒开)。会话 120 秒没人续即作废,不常驻大内存。
   ========================================================================== */
/* v4.9.170:6 MB 一片(原来 3 MB)——片数减半,首次搬运快一倍;必须与 ln-store.js 里的 BIG_CHUNK 一致 */
const BIG_CHUNK = 6 * 1024 * 1024;
const BIG_TTL = 120000;
const bigOut = new Map();      // `store|key` -> { at, s }   读方向:编码后的整条 JSON
const bigIn = new Map();       // `store|key` -> { at, parts } 写方向:已收到的各片
function bigSweep() {
  const now = Date.now();
  for (const m of [bigOut, bigIn]) { for (const kv of m) { if (now - kv[1].at > BIG_TTL) m.delete(kv[0]); } }
}
async function opBigBegin(store, key) {
  bigSweep();
  const db = await openUni();
  let { req, done } = withStore(db, store, 'readonly', (os) => os.get(key));
  await done;
  let rec = req.result;
  if (rec == null) {
    const k2 = await resolveKey(db, store, key);
    if (k2 !== key) { const r2 = withStore(db, store, 'readonly', (os) => os.get(k2)); await r2.done; rec = r2.req.result; }
  }
  if (rec == null) return { ok: true, found: false };
  const s = JSON.stringify(await LNC.enc(rec));        // 只编码一次,后面各片直接切片
  bigOut.set(store + '|' + key, { at: Date.now(), s });
  return { ok: true, found: true, len: s.length, n: Math.max(1, Math.ceil(s.length / BIG_CHUNK)) };
}
function opBigChunk(store, key, i) {
  const e = bigOut.get(store + '|' + key);
  if (!e) return { ok: false, error: '分片读会话已过期' };
  e.at = Date.now();
  const off = Math.max(0, i | 0) * BIG_CHUNK;
  return { ok: true, s: e.s.slice(off, off + BIG_CHUNK) };
}
function opBigEnd(store, key) { bigOut.delete(store + '|' + key); return { ok: true }; }
function opBigPutBegin(store, key) {
  bigSweep();
  bigIn.set(store + '|' + key, { at: Date.now(), parts: [] });
  return { ok: true };
}
function opBigPutChunk(store, key, s, i) {
  const e = bigIn.get(store + '|' + key);
  if (!e) return { ok: false, error: '分片写会话已过期' };
  e.at = Date.now();
  e.parts[Math.max(0, i | 0)] = String(s == null ? '' : s);      // 按下标存 ⇒ 乱序到达也不怕
  return { ok: true };
}
function opBigPutAbort(store, key) { bigIn.delete(store + '|' + key); return { ok: true }; }
async function opBigPutEnd(store, key) {
  const e = bigIn.get(store + '|' + key);
  bigIn.delete(store + '|' + key);
  if (!e) return { ok: false, error: '分片写会话已过期' };
  const s = e.parts.join('');
  const rec = LNC.dec(JSON.parse(s));
  const db = await openUni();
  keyIdx[store] = null;                                 // 键可能变了 ⇒ 索引作废
  await withStore(db, store, 'readwrite', (os) => os.put(rec)).done;
  return { ok: true, chars: s.length };
}
async function chaptersOfNovel(novelId) {
  const db = await openUni();
  const nk = (v) => String(v == null ? '' : v).split('|').pop();
  const nid = nk(novelId);
  try {
    const idx = await idxOf(db, 'chapters');       // 裸键 → 真键(章键形如 `<novelId>/<cid>`)
    const keys = [];
    for (const pair of idx) { if (pair[0].indexOf(nid + '/') === 0) keys.push(pair[1]); }
    if (keys.length) return await getsOf(db, 'chapters', keys);
  } catch (e) {}
  /* 兜底:索引还没建起来、或没匹配上 ⇒ 老办法整表筛一遍(行为与之前完全一致) */
  const { req, done } = withStore(db, 'chapters', 'readonly', (os) => os.getAll());
  await done;
  const vals = [];
  for (const c of (req.result || [])) {
    if (novelId != null && nk(c.novelId) !== nid) continue;
    vals.push(c);
  }
  return vals;
}
/* 章节列表**不带正文**:目录/面板只要标题、顺序、图片数、占用大小 */
async function opChaptersBrief(novelId) {
  const vals = [];
  for (const c of await chaptersOfNovel(novelId)) {
    const o = {};
    for (const k of Object.keys(c)) { if (k === 'blocks' || k === 'origBlocks' || k === 'aiBlocks' || k === 'preAiBlocks') continue; o[k] = c[k]; }
    o.__textBytes = textBytesOf(c);
    vals.push(o);
  }
  /* 整本书的目录也是几十~几百 KB 的 JSON ⇒ 出通道前压一下(小了就原样返回) */
  return { ok: true, vals: LNC.pack(vals), total: vals.length };
}
/* 章节**全量**但只取一本书(导出/阅读要用正文):只是别把别的书的正文也搬过来 */
async function opChaptersOf(novelId) {
  const vals = await chaptersOfNovel(novelId);
  return { ok: true, vals: LNC.pack(vals), total: vals.length };
}

/* P0-3:章节预取辅助 —— SW 在章节 get 命中后问 offscreen 拿同书相邻章节(带正文,pack 态)。
   offscreen 有原生数组访问(chaptersOfNovel),SW 只收 pack 字符串写会话缓存,不参与编解码;
   阅读器翻页时下一章直接命中 SW 缓存,省一次 offscreen 往返。 */
async function opChapterNeighbors(msg) {
  const nid = msg.novelId;
  const cid = String(msg.chapterId == null ? '' : msg.chapterId);
  if (!nid || !cid) return { ok: false, error: '缺 novelId/chapterId' };
  const range = Math.max(1, Math.min(3, parseInt(msg.range, 10) || 1));
  try {
    const vals = await chaptersOfNovel(nid);
    let idx = -1;
    for (let i = 0; i < vals.length; i++) { if (String(vals[i].chapterId) === cid) { idx = i; break; } }
    if (idx < 0) return { ok: true, neighbors: [] };
    // 按序返回(前 range 章 + 后 range 章,与阅读器翻页方向一致)
    const picked = [];
    for (let d = 1; d <= range; d++) {
      if (idx - d >= 0) picked.push(vals[idx - d]);
      if (idx + d < vals.length) picked.push(vals[idx + d]);
    }
    const neighbors = [];
    for (const rec of picked) {
      const key = nid + '/' + rec.chapterId;
      neighbors.push({ key: key, resp: { ok: true, val: LNC.pack(await LNC.enc(rec)) } });
    }
    return { ok: true, neighbors: neighbors };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
async function opPut(store, val) {
  const db = await openUni();
  keyIdx[store] = null;                    // 键可能变了(meta/chapters 的键藏在记录里)⇒ 索引作废
  await withStore(db, store, 'readwrite', (os) => os.put(val)).done;
  return { ok: true };
}
async function opGet(store, key) {
  const db = await openUni();
  let { req, done } = withStore(db, store, 'readonly', (os) => os.get(key));
  await done;
  let rec = req.result;
  if (rec == null) {
    const k2 = await resolveKey(db, store, key);          // 跨站:换个前缀的同一个 id 也要能读到
    if (k2 !== key) { const r2 = withStore(db, store, 'readonly', (os) => os.get(k2)); await r2.done; rec = r2.req.result; }
  }
  return { ok: true, val: rec == null ? null : LNC.pack(await LNC.enc(rec)) };
}
async function opHas(store, key) {
  const db = await openUni();
  let { req, done } = withStore(db, store, 'readonly', (os) => os.count(key));
  await done;
  if (req.result) return { ok: true, yes: true };
  const k2 = await resolveKey(db, store, key);
  if (k2 === key) return { ok: true, yes: false };
  const r2 = withStore(db, store, 'readonly', (os) => os.count(k2));
  await r2.done;
  return { ok: true, yes: !!r2.req.result };
}
async function opDel(store, key) {
  const db = await openUni();
  /* 跨站:按当前站点加前缀查不到的,落到裸键索引上 —— 否则在 linovelib 上删一本 ESJ 的书,
     章节那条会静默删不掉(然后又以"孤儿书"的样子冒回面板里)。 */
  const k = await resolveKey(db, store, key);
  keyIdx[store] = null;
  await withStore(db, store, 'readwrite', (os) => os.delete(k)).done;
  return { ok: true };
}
/* 只按**原样键**删(迁移里"把无前缀的旧记录改名前缀化"用)。
   ⚠ 这里绝不能带跨站兜底:rename 流程是"先写新前缀键、再删旧键",
   兜底会把刚写好的那条一起删掉。 */
async function opDelExact(store, key) {
  const db = await openUni();
  keyIdx[store] = null;
  await withStore(db, store, 'readwrite', (os) => os.delete(key)).done;
  return { ok: true };
}
/* v4.9.168-扩展移植:一个事务里删多个键(删书用)。
   keys 是库内**已带前缀**的键(与 opDel 收到的键同源);通道只压缩 msg.val,keys 原样到达。
   v4.9.205-扩展移植(修「本地导入的书 / 跨站书**删不掉**」):**逐个套上 opDel 那套跨站兜底**。
   删书时章节键是按"当前站点"前缀拼出来的(bare 键 + 当前站),可记录可能躺在**别的前缀**下
   —— 本地导入的书是 local-epub|…,跨站的书是它自己站点的前缀 ⇒ 原来这里直接 os.delete(k) 全打空:
   meta 走单条 opDel(有兜底)被删掉了、章节与图片一条没删 ⇒ 那本书退化成「未知小说 <id>」的
   孤儿行,用户看到的就是"删不掉"(实测:用户点了两次,日志都打「已删除」,行却一直在)。
   resolveKey 命中不了就走裸键索引,与 opDel 行为完全一致;每个键都重新解析(+ 清一次索引缓存),
   批量删也不会比单条慢。 */
async function opDelMany(store, keys) {
  const list = Array.isArray(keys) ? keys.filter((k) => k != null) : [];
  if (!list.length) return { ok: true, n: 0 };
  const db = await openUni();
  const targets = [];
  for (const k of list) {
    let kk = k;
    try { kk = await resolveKey(db, store, k); } catch (e) { kk = k; }
    targets.push(kk);
  }
  keyIdx[store] = null;
  await withStore(db, store, 'readwrite', (os) => { for (const k of targets) os.delete(k); }).done;
  return { ok: true, n: targets.length };
}
async function opClear(store) {
  const db = await openUni();
  await withStore(db, store, 'readwrite', (os) => os.clear()).done;
  return { ok: true };
}
async function opAll(store, stripBlobs) {
  const db = await openUni();
  const { req, done } = withStore(db, store, 'readonly', (os) => os.getAll());
  await done;
  const all = req.result || [];
  const vals = [];
  for (const rec of all) vals.push(await LNC.enc(stripBlobs ? stripBinary(rec) : rec));
  return { ok: true, vals: LNC.pack(vals), total: vals.length };
}
async function opKeys(store) {
  const db = await openUni();
  const { req, done } = withStore(db, store, 'readonly', (os) => os.getAllKeys());
  await done;
  return { ok: true, keys: LNC.pack(req.result || []) };
}
async function opCount(store) {
  const db = await openUni();
  const { req, done } = withStore(db, store, 'readonly', (os) => os.count());
  await done;
  return { ok: true, n: req.result };
}
async function opEstimate() {
  try {
    const e = await navigator.storage.estimate();
    return { ok: true, usage: e.usage, quota: e.quota };
  } catch (e) { return { ok: true, usage: null, quota: null }; }
}
/* 按站点戳删除(「清空本站缓存」用):只删本站的记录。
   统一库里所有站点的数据混在一起,清空前必须按戳筛,否则会连别站一起清掉。
   匹配 __siteKey(站点模块)—— .one/.cc 算同一站;兼容只有 __site 的旧记录。 */
async function opDelBySite(store, site) {
  const db = await openUni();
  const t = db.transaction(store, 'readwrite');
  const os = t.objectStore(store);
  let n = 0;
  const iter = new Promise((resolve, reject) => {
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { resolve(); return; }
      try { if (c.value && (c.value.__siteKey === site || c.value.__site === site)) { c.delete(); n++; } } catch (e) {}
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  });
  await iter; await done;
  return { ok: true, n };
}

/* v4.9.174-扩展移植:OCR 识别交给**扩展侧常驻引擎**(ocr-host.js,跑在本 offscreen 文档里)。
   引擎不随网页刷新而消失、所有站点共用;模型/ORT 字节就在本库 ⇒ 建引擎本地直读,不再搬。
   页面侧 catcher 起不来就静默退回"本页引擎"老路 ⇒ 不会更差。 */
async function opOcrHostRun(msg) {
  const H = globalThis.LN_OCR_HOST;
  if (!H) return { ok: false, error: 'offscreen 未加载 ocr-host.js(检查 offscreen.html)', degrade: 'no-host' };
  /* P1-2:引擎偶发初始化失败(模型字节刚写入 / 缓存刚清空)时自动重试 2 次,再失败才如实报错;
     错误带 degrade 分类,调用方(不碰原脚本正文)可以据此区分"扩展引擎挂了"和"图片本身问题"。 */
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await H.run(msg.mid, msg.img, msg.meta && msg.meta.detRatio);
      return { ok: true, val: r, retries: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((res) => setTimeout(res, 150 * (attempt + 1)));
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr), degrade: 'engine-fail' };
}
async function opOcrHostWarm(msg) {
  const H = globalThis.LN_OCR_HOST;
  if (!H) return { ok: false, error: 'offscreen 未加载 ocr-host.js(检查 offscreen.html)', degrade: 'no-host' };
  /* P1-2:预热同样重试 2 次(预热失败会连带让首次识别也失败) */
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await H.warm(msg.mid, msg.meta && msg.meta.detRatio);
      return { ok: true, val: r, retries: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((res) => setTimeout(res, 150 * (attempt + 1)));
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr), degrade: 'engine-fail' };
}
async function opOcrHostStatus() {
  const H = globalThis.LN_OCR_HOST;
  if (!H) return { ok: true, val: { engines: [], cached: [], host: false } };
  const s = await H.status();
  s.host = true;
  return { ok: true, val: s };
}

/* ---------- 统一入口:处理一条 uniOp(sendMessage 兜底与长连接 Port 共用) ---------- */
async function handleUniOp(msg) {
  const store = msg.store;
  /* v4.9.174:ocrHost* 这几个 op 不带 store(它们在 offscreen 里自己读库),一并放行 */
  const opNoStore = msg.op === 'open' || msg.op === 'estimate' || String(msg.op).indexOf('ocrHost') === 0;
  if (!opNoStore && UNI_STORES.indexOf(store) < 0) {
    return { ok: false, error: '未知 store:' + store };
  }
  /* ⚠ 必须先 unpack:内容脚本侧 call() 会把 ≥64 KB 的**对象**载荷压成「\u0001 + base64(deflate(JSON))」
     字符串再发(见 ln-codec.js 的 pack)。这里不还原,落库的就是一个字符串 ⇒ IDB 事务直接报错,
     而调用方几乎都包着 `try{}catch(e){}` ⇒ 静默失败:
     封面、阅读字体/嵌入字模、OCR 模型字节、大章节正文 全都写不进去(界面还报"已保存")。
     小载荷没被压,unpack 原样返回,所以这一行对新旧载荷都成立。 */
  const val = msg.val === undefined ? undefined : LNC.dec(LNC.unpack(msg.val));
  switch (msg.op) {
    case 'open': return { ok: true, db: UNI_DB, stores: UNI_STORES };
    case 'ocrHostRun': return await opOcrHostRun(msg);         // v4.9.174:OCR 走扩展侧常驻引擎
    case 'ocrHostWarm': return await opOcrHostWarm(msg);       // v4.9.174:提前把引擎建好
    case 'ocrHostStatus': return await opOcrHostStatus();      // v4.9.174:引擎/缓存状态
    case 'put': return await opPut(store, val);
    case 'get': return await opGet(store, msg.key);
    case 'has': return await opHas(store, msg.key);
    case 'del': return await opDel(store, msg.key);
    case 'delExact': return await opDelExact(store, msg.key);   // 只按原样键删(迁移改名用,不做跨站兜底)
    case 'delMany': return await opDelMany(store, msg.keys);   // v4.9.168-扩展移植:批量删(删书)
    case 'clear': return await opClear(store);
    case 'delBySite': return await opDelBySite(store, msg.site);
    case 'all': return await opAll(store, !!msg.stripBlobs);
    case 'getMeta': return await opGetMeta(store, msg.key);
    case 'getMany': return await opGetMany(store, msg.keys);   // 批量取:一个来回拿多件(封面缩略图)
    case 'bigBegin': return await opBigBegin(store, msg.key);            // v4.9.169:超大件分片读
    case 'bigChunk': return opBigChunk(store, msg.key, msg.i);
    case 'bigEnd': return opBigEnd(store, msg.key);
    case 'bigPutBegin': return opBigPutBegin(store, msg.key);            // v4.9.169:超大件分片写
    case 'bigPutChunk': return opBigPutChunk(store, msg.key, msg.s, msg.i);
    case 'bigPutAbort': return opBigPutAbort(store, msg.key);
    case 'bigPutEnd': return await opBigPutEnd(store, msg.key);
    case 'chaptersBrief': return await opChaptersBrief(msg.novelId);
    case 'chaptersOf': return await opChaptersOf(msg.novelId);
    case 'chapterNeighbors': return await opChapterNeighbors(msg);   // P0-3:预取辅助
    case 'keys': return await opKeys(store);
    case 'count': return await opCount(store);
    case 'estimate': return await opEstimate();
    default: return { ok: false, error: '未知 op:' + msg.op };
  }
}

/* sendMessage 兜底路径(内容脚本直发 / SW 转发;Port 不可用时自动走到这条) */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__to !== 'offscreen' || msg.type !== 'uniOp') return;
  handleUniOp(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;   // 异步响应
});

/* 1.1.66(P0-1):长连接 Port —— offscreen 连上 SW,SW 把各页面内容脚本的 uniOp 经这条
   port 转来,响应也经这条 port 回(SW 按 __src 路由回原页面)。
   断线(SW 休眠/重载)后**只在有流量时**重连:SW 那边 off port 不可用时,内容脚本的请求
   会走 sendMessage 兜底打到这儿 —— 兜底请求本身就是"有人在用库"的信号,借机把桥接上;
   没有流量就不重连,不给 SW 制造无谓唤醒。 */
(function connectOffPort() {
  let needReconnect = true;
  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (needReconnect) tryConnect();
    }, 300);
  };
  const tryConnect = () => {
    try {
      const port = chrome.runtime.connect({ name: 'lnstore-off' });
      needReconnect = false;
      port.onMessage.addListener((msg) => {
        if (!msg || msg.__to !== 'offscreen' || msg.type !== 'uniOp') return;
        handleUniOp(msg).then((r) => {
          try { port.postMessage(Object.assign({ __offResp: true, __op: msg.op, __store: msg.store, __key: msg.key, __novelId: msg.novelId, __keys: msg.keys, __stripBlobs: msg.stripBlobs }, r, { __src: msg.__src, rid: msg.rid })); } catch (e) {}
          /* SW 休眠/重载会把 off port 静默关掉:postMessage 失败标志在 runtime.lastError,读取即消费,防 Unchecked 报错 */
          if (chrome.runtime && chrome.runtime.lastError) { void chrome.runtime.lastError; }
        }, (e) => {
          try { port.postMessage({ __offResp: true, __op: msg.op, __store: msg.store, __key: msg.key, __novelId: msg.novelId, __keys: msg.keys, __stripBlobs: msg.stripBlobs, __src: msg.__src, rid: msg.rid, ok: false, error: String((e && e.message) || e) }); } catch (e2) {}
          if (chrome.runtime && chrome.runtime.lastError) { void chrome.runtime.lastError; }
        });
      });
      port.onDisconnect.addListener(() => { needReconnect = true; });
    } catch (e) {
      needReconnect = true;
      schedule();
    }
  };
  /* 兜底 sendMessage 请求到达 ⇒ 有人在用库:借机把桥连上 */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.__to === 'offscreen' && msg.type === 'uniOp' && needReconnect) schedule();
  });
})();