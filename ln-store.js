/* ============================================================================
   ln-store.js —— 「统一库 lnlib」桥 + 老库读时回填
   ----------------------------------------------------------------------------
   干什么:把原脚本数据层那 8 个函数(openDB/idbPut/idbGet/idbDel/idbClear/
   idbAll/idbCount/idbHas)转到**扩展 origin 的统一库 lnlib** 上。
   按 origin 隔离的问题就没了:esjzone.one / .cc / 以后其他站点,读写都到同一个库。

   ⚠ 内容脚本碰不到扩展 origin 的 IndexedDB(跨 origin),所以真正的读写在
     offscreen 文档里跑(offscreen-db.js),这边只发消息 —— Blob/ArrayBuffer 走 ln-codec。

   另外:油猴时期那份写在**站点 origin** 的 `esjzone_epub_cache` 不浪费 ——
   · 统一库里没有的记录,读的时候从老库取出来(**顺手回填进统一库**);
   · 列表 / 计数 / 存在性判断也把老库算进去。
   于是你原来缓存的章节、插图、设置**装上就能用**,不用重抓,也不用写迁移工具。
   ========================================================================== */
(() => {
  'use strict';
  const LEGACY_DB = 'esjzone_epub_cache';
  /* 每个 store 的主键字段(与脚本里的 keyPath 一致) */
  const KEYF = { meta: 'novelId', chapters: 'key', images: 'url', settings: 'key' };
  const LN = globalThis.LN_CODEC;

  /* ---- 页面内记忆化:省掉"每次都要重新过一遍消息通道"的大件 ----
     为什么需要:油猴时代这些读是**页面内直接读 IDB**(零边界);搬到扩展后,同样一次读要
     offscreen 读 → base64 → JSON 过通道 → 内容脚本再解回来。字节量决定延迟,于是:
       · 开阅读器时每次都要的那份「嵌入字体 / 阅读字体」(几十 MB)⇒ 读进来后就留一份;
       · 阅读器开场会连着 listChapters 两次(先归一化 order、再取有序列表)⇒ 同一本书的正文
         别搬两遍(4 MB 的书就是两遍 8 MB 的 JSON)。
     两条都是"内容没变就复用":写/删同一键时立刻失效,再加短期 TTL 兜底。 */
  const MEMO_TTL = 5 * 60 * 1000;      // 字体类:5 分钟(期间若有写入会被立刻失效)
  const CHAP_TTL = 10 * 1000;          // 章节全文:10 秒(只为吃掉"连着两次"那种重复读)
  const fontMemo = new Map();          // 'settings/font' | 'settings/readerfont' -> { at, val }
  const chapMemo = new Map();          // novelId -> { at, vals }
  /* v4.9.168-扩展移植:字体改成了"缓存字体库" —— 元数据键 fontmeta 很小,但字模在
     fontblob|<id> 里(一份 24 MB)。两者都要记忆化,否则每开一次阅读器、每 20 秒重绘一次
     面板,都要把那几十 MB 再过一遍消息通道。用对象带 has() 是为了让下面 4 处调用点原样不动。 */
  const MEMO_SETTINGS_KEYS = {
    has: (k) => k === 'font' || k === 'readerfont' || k === 'fontmeta' || String(k).indexOf('fontblob|') === 0
  };

  /* ------------------------- 与 offscreen 通信 ------------------------- */
  /* 扩展被重新加载/更新后,老页面里的内容脚本已经"失联":之后任何 chrome.* 调用都会抛
     「Extension context invalidated」。脚本会把错误消息原样显示给用户(如「读取本站缓存失败: …」),
     所以这里换成一句照着做就能解决的话。 */
  const REFRESH_HINT = '扩展刚被重新加载过:请刷新本页(F5)后再试';
  function friendly(e) {
    let dead = false;
    try { dead = !(chrome.runtime && chrome.runtime.id); } catch (x) { dead = true; }
    const m = String((e && e.message) || e || '');
    if (dead || m.indexOf('Extension context invalidated') >= 0) return new Error(REFRESH_HINT);
    return (e instanceof Error) ? e : new Error(m);
  }

  let seq = 0;
  /* v4.9.175-扩展移植:offscreen 文档已经起来了的话,就直接发给**它**,不再经 SW 转一手。
     sw.js 里本来就写着「发给 offscreen 的消息不由 SW 处理」(见 `if (msg.__to === 'offscreen') return;`)
     ⇒ 直发不会重复处理,却省掉 SW 那一跳 —— 大件分片搬运、每片 OCR 的来回都快一截。
     文档还没起来(没人应答)时自动退回经 SW 转发那条路:SW 负责把 offscreen 拉起来。 */
  let _directFail = false;
  /* sendMessage 老路(兜底):含"直发 offscreen 省一跳"尝试 + 瞬时失败重试 */
  function callViaMessage(op, msg, retry) {
    return new Promise((resolve, reject) => {
      const once = (direct) => {
        chrome.runtime.sendMessage(direct ? Object.assign({ __to: 'offscreen' }, msg) : msg, (r) => {
          if (chrome.runtime.lastError || !r) {
            if (direct && !_directFail) { _directFail = true; once(false); return; }
            const _em = String((chrome.runtime.lastError && chrome.runtime.lastError.message) || '统一库无响应(扩展在运行吗?)');
            /* v4.9.204-扩展移植(修"删不掉"):偶尔会撞上"没有接收方" —— 典型是扩展刚被重载、或
               SW / offscreen 正在冷启动(实测用户在别的站点删本地导入的书时撞到过一次,面板上表现为
               日志说"已删除"、行却还在)。这类失败是瞬时的:过 300ms 重来一遍(连"直发 offscreen"
               也重新试),重试两次仍失败才如实抛错。只对"连不上"这一族重试,逻辑错误照旧立刻报。 */
            if (retry < 2 && /receiving end does not exist|could not establish connection|message port closed|统一库无响应/i.test(_em)) {
              setTimeout(() => { _directFail = false; once(true); }, 300);
              return;
            }
            reject(friendly(new Error(_em)));
            return;
          }
          resolve(r);
        });
      };
      once(!_directFail);
    });
  }

  /* 1.1.66(P0-1):长连接 Port —— 优先走它(一条连接多路复用,省掉每次 sendMessage 的握手;
     顺带让 SW 的会话级缓存生效)。port 不可用(扩展刚重载 / SW 冷启动)自动回退 sendMessage 老路。 */
  let _port = null;
  let _portPending = new Map();
  const _portTimeout = 60000;
  function portPost(msg) {
    return new Promise((resolve, reject) => {
      if (!(chrome.runtime && chrome.runtime.id)) { reject(friendly(new Error('dead-ctx'))); return; }
      let p = _port;
      if (!p) {
        try { p = chrome.runtime.connect({ name: 'lnstore-page' }); } catch (e) { p = null; }
        if (p) {
          _port = p;
          p.onMessage.addListener((m) => {
            if (!m || m.rid == null) return;
            const q = _portPending.get(m.rid);
            if (q) { _portPending.delete(m.rid); clearTimeout(q.t); q.resolve(m); }
          });
          p.onDisconnect.addListener(() => { _port = null; });
        }
      }
      if (!p) { reject(friendly(new Error('no-port'))); return; }
      const rid = msg.rid;
      const t = setTimeout(() => { _portPending.delete(rid); reject(friendly(new Error('port-timeout'))); }, _portTimeout);
      _portPending.set(rid, { resolve: resolve, reject: reject, t: t });
      try { p.postMessage(msg); }
      catch (e) { _portPending.delete(rid); clearTimeout(t); reject(friendly(e)); }
      /* 页面进 bfcache(前进/后退缓存)时 Chrome 会静默关闭 port:postMessage 失败标志在
         runtime.lastError,不读取就报 "Unchecked runtime.lastError"。读取即消费;
         端口死后下一次请求会走 onDisconnect 置空 _port 并自动重连。 */
      if (chrome.runtime && chrome.runtime.lastError) { void chrome.runtime.lastError; }
    });
  }

  function call(op, payload) {
    return new Promise((resolve, reject) => {
      if (!(chrome.runtime && chrome.runtime.id)) { reject(friendly(new Error('dead-ctx'))); return; }
      let msg;
      try {
        msg = Object.assign({ type: 'uniOp', op, rid: ++seq }, payload || {});
        /* 大块载荷(整本书正文、字模)出通道前压一下:JSON 通道里字节量 = 延迟。
           pack 对小于 64 KB 的载荷原样返回 ⇒ 小请求零开销。 */
        if (msg.val !== undefined) msg.val = LN.pack(msg.val);
      } catch (e) { reject(friendly(e)); return; }
      /* 公共收尾:错误判定 + 回程载荷解压 + 章节预取失效 */
      const settle = (r) => {
        if (!r) { reject(friendly(new Error('统一库无响应'))); return; }
        if (!r.ok) { reject(new Error(r.error || '统一库操作失败')); return; }
        try {
          if (r.val !== undefined) r.val = LN.unpack(r.val);
          if (r.vals !== undefined) r.vals = LN.unpack(r.vals);
          if (r.keys !== undefined) r.keys = LN.unpack(r.keys);
        } catch (e) { reject(friendly(e)); return; }
        try {
          const _o = String(op || '');
          if (payload && payload.store === 'chapters' && (_o === 'put' || _o === 'clear' || _o.indexOf('del') === 0)) pfMemo.clear();
        } catch (e) {}
        resolve(r);
      };
      let fellBack = false;
      portPost(msg).then(settle, () => {
        if (fellBack) { reject(friendly(new Error('统一库通道失败'))); return; }
        fellBack = true;
        callViaMessage(op, msg, 0).then(settle, reject);
      });
    });
  }

  /* ------------------------- 老库(站点 origin,油猴那份) ------------------------- */
  let legacyP = null;
  let legacyNone = false;
  function openLegacy() {
    if (legacyNone) return Promise.resolve(null);
    if (legacyP) return legacyP;
    legacyP = (async () => {
      try {
        const list = await indexedDB.databases();
        if (!list.some((d) => d.name === LEGACY_DB)) { legacyNone = true; return null; }
      } catch (e) { /* 列不出来就直接试着开 */ }
      return await new Promise((res) => {
        let r;
        try { r = indexedDB.open(LEGACY_DB); } catch (e) { res(null); return; }
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
    })().catch(() => { legacyNone = true; return null; });
    return legacyP;
  }
  function lReq(db, store, mode, fn) {
    return new Promise((res) => {
      try {
        const rq = fn(db.transaction(store, mode).objectStore(store));
        rq.onsuccess = () => res(rq.result === undefined ? null : rq.result);
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  }
  const lGet = (db, store, key) => lReq(db, store, 'readonly', (os) => os.get(key));
  /* 单键删(老库侧):settings / images 不随迁移走 ⇒ 这两张表上的删除必须把老库那份也删掉,
     否则"删了还在"(下次读又从老库取回来)。 */
  function lDel(db, store, key) {
    return new Promise((res) => {
      try {
        const t = db.transaction(store, 'readwrite');
        t.objectStore(store).delete(key);
        t.oncomplete = () => res(true);
        t.onerror = () => res(false);
        t.onabort = () => res(false);
      } catch (e) { res(false); }
    });
  }
  const lKeys = (db, store) => lReq(db, store, 'readonly', (os) => os.getAllKeys());
  const lAll = (db, store) => lReq(db, store, 'readonly', (os) => os.getAll());
  async function lClear(db, store) {
    try { await new Promise((res) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = res; t.onerror = res; t.onabort = res; }); } catch (e) {}
  }
  /* ---------------- v4.9.203-扩展移植:老库(当前站点 origin 那份)的删除 ----------------
     老库里的键是**本站的裸键**;统一库的键可能带站点前缀 ⇒ 只有"属于本站"的键才动得了老库
     (带别站前缀的键:那份记录在别的 origin,内容脚本碰不到 —— 交给删除账本兜底)。 */
  function legacyBareKey(key) {
    const s = String(key);
    const i = s.indexOf('|');
    if (i < 0) return s;
    return (s.slice(0, i) === siteKey()) ? s.slice(i + 1) : null;
  }
  async function legacyDelKeys(store, keys) {
    try {
      const list = (Array.isArray(keys) ? keys : [keys]).map(legacyBareKey).filter((k) => k != null);
      if (!list.length) return;
      const db = await openLegacy();
      if (!db) return;
      for (const k of list) { try { await lDel(db, store, k); } catch (e) {} }
    } catch (e) {}
  }
  async function legacyGet(store, key) {
    const db = await openLegacy();
    if (!db) return null;
    const rec = await lGet(db, store, key);
    if (rec == null) return null;
    /* 读时回填:后台把这条写进统一库(不阻塞本次读取) */
    LN.enc(rec).then((v) => call('put', { store, val: v })).catch(() => {});
    return rec;
  }
  async function legacyKeys(store) {
    const db = await openLegacy();
    return db ? ((await lKeys(db, store)) || []) : [];
  }

  /* ---------------- 老库 → 统一库:每个站点跑一次(搬完就不再回头读老库) ----------------
     为什么需要它:老数据躺在**各站点自己 origin** 的老库里,内容脚本只看得见"当前站点"
     那一份 —— 所以在 A 站抓的书,在 B 站的面板里根本看不到(只能靠跨站索引看个壳)。
     把本站老库整库搬进统一库、并给每条打上站点戳(__site)之后,任何站点都能看到全部藏书。
     搬完打标记;此后读写都只走统一库(顺带治好"删了又从老库冒出来"的回潮问题)。 */
  const MIGRATED_KEY = 'ln:uni-migrated';
  let migDone = false;
  let migP = null;   // 同一次搬迁只跑一遍(面板后台搬迁 + 手动触发可能撞上)
  const stGet = () => new Promise((res) => { try { chrome.storage.local.get(MIGRATED_KEY, (r) => res((r && r[MIGRATED_KEY]) || {})); } catch (e) { res({}); } });
  const stSet = (o) => new Promise((res) => { try { chrome.storage.local.set(o, () => res(true)); } catch (e) { res(false); } });
  async function migratedHere() {
    if (migDone) return true;
    const m = await stGet();
    migDone = !!m[location.hostname];
    return migDone;
  }
  async function markMigrated() {
    migDone = true;
    const m = await stGet();
    m[location.hostname] = Date.now();
    await stSet({ [MIGRATED_KEY]: m });
  }
  /* v4.9.204-扩展移植:老库"清空过"的标记(与搬迁标记同一套 chrome.storage,按站点记)。
     为什么要单独一个标记:搬迁标记说的是"内容搬进统一库了",这个说的是"老库那几条已经删掉了" ——
     升级上来的站点早就有前者、没有后者 ⇒ 靠它把"清空老库"补做一次(每站点只一次,不按扩展版本)。 */
  const PURGED_KEY = 'ln:uni-legacy-purged';
  let purgedDone = false;
  async function purgedHere() {
    if (purgedDone) return true;
    try {
      const m = await new Promise((res) => { try { chrome.storage.local.get(PURGED_KEY, (r) => res((r && r[PURGED_KEY]) || {})); } catch (e) { res({}); } });
      purgedDone = !!m[location.hostname];
    } catch (e) {}
    return purgedDone;
  }
  async function markPurged() {
    purgedDone = true;
    try {
      const m = await new Promise((res) => { try { chrome.storage.local.get(PURGED_KEY, (r) => res((r && r[PURGED_KEY]) || {})); } catch (e) { res({}); } });
      m[location.hostname] = Date.now();
      await new Promise((res) => { try { chrome.storage.local.set({ [PURGED_KEY]: m }, () => res(true)); } catch (e) { res(false); } });
    } catch (e) {}
  }
  /* v4.9.178:"本版本已补扫过差集"的戳(按站点记,与搬迁标记同一套 chrome.storage)。
     为什么要版本号:补扫要"每个版本只做一次" —— 既能自动治"标了但没搬全",
     又不会把用户在面板里删掉的书一遍遍搬回来。 */
  const RESCAN_KEY = 'ln:uni-rescan';
  function extVer() { try { return String((chrome.runtime.getManifest() || {}).version || ''); } catch (e) { return ''; } }
  const rescanStamps = () => new Promise((res) => { try { chrome.storage.local.get(RESCAN_KEY, (r) => res((r && r[RESCAN_KEY]) || {})); } catch (e) { res({}); } });
  async function setRescanStamp(v) {
    try {
      const m = await rescanStamps();
      m[location.hostname] = String(v || '');
      await new Promise((res) => { try { chrome.storage.local.set({ [RESCAN_KEY]: m }, () => res(true)); } catch (e) { res(false); } });
    } catch (e) {}
  }

  /* ---------------- v4.9.203-扩展移植:删除账本(在面板里删过的键,别再被搬迁从老库搬回来) ----------------
     为什么需要:老库(站点 origin 那份 esjzone_epub_cache)是"备份",而删除只清得掉**当前站点**这份
     —— 在 A 站的面板里删掉 B 站的书时,内容脚本够不到 B 站的 origin ⇒ B 站那份老库记录还在。
     账本按"站点模块|键"记(带前缀 ⇒ 跨站同号 id 不会互相误伤),只影响"从老库往统一库补"这一件事,
     不影响统一库本身的读写。上限 3000 条(超了丢最老的):它只是兜底,不做强一致。
     两个"只打一次"的日志开关也放这儿(面板每 20 秒重绘一次,不开关就会刷屏)。 */
  const DELETED_KEY = 'ln:uni-deleted';
  const DELETED_MAX = 3000;
  let delSet = null, delSaveT = 0;
  let _noLegacyLogged = false, _migDoneLogged = false, _startLogged = false;
  async function delLedger() {
    if (delSet) return delSet;
    delSet = new Set();
    try {
      const m = await new Promise((res) => { try { chrome.storage.local.get(DELETED_KEY, (r) => res((r && r[DELETED_KEY]) || {})); } catch (e) { res({}); } });
      for (const k of Object.keys(m || {})) delSet.add(String(k));
    } catch (e) {}
    return delSet;
  }
  function delLedgerSave() {
    if (delSaveT) return;
    delSaveT = setTimeout(async () => {
      delSaveT = 0;
      try {
        let arr = Array.from(delSet || new Set());
        if (arr.length > DELETED_MAX) arr = arr.slice(arr.length - DELETED_MAX);
        const o = {};
        for (const k of arr) o[k] = 1;
        await new Promise((res) => { try { chrome.storage.local.set({ [DELETED_KEY]: o }, () => res(true)); } catch (e) { res(false); } });
      } catch (e) {}
    }, 700);
  }
  /* 记一笔:键 = store + '/' + 库内键(meta / chapters 一律带站点前缀) */
  async function delLedgerAdd(store, keys) {
    if (!keyNeedsPrefix(store)) return;      // settings / images 当场连老库那份一起删,不用记账
    try {
      const s = await delLedger();
      for (const k of (Array.isArray(keys) ? keys : [keys])) {
        if (k == null) continue;
        const t = String(k), i = t.indexOf('|');
        s.add(store + '/' + (i >= 0 ? t : (siteKey() + '|' + t)));
      }
      delLedgerSave();
    } catch (e) {}
  }
  /* 问一句:这个"老库裸键"是不是你删过的(裸键 + 当前站点模块 = 库内键) */
  async function delLedgerHas(store, bareKey) {
    if (!keyNeedsPrefix(store)) return false;
    try { return (await delLedger()).has(store + '/' + addP(bareKey)); } catch (e) { return false; }
  }
  /* v4.9.203 / v4.9.204-扩展移植(修 bug):对外回答两件事 —— "搬过没有" + "老库清过没有"。
     v4.9.179 那套"按扩展版本回答、每版再补扫一次差集"已经去掉:补扫会把老库里留着的那份又搬进
     统一库 ⇒ 你在面板里删掉的书随版本回潮(实测)。现在:
       · 没搬过 ⇒ 喊一次"搬迁"(首访:缺的照搬 + 搬完清空老库);
       · 搬过但老库还没清 ⇒ 也喊一次(清空模式:只清"统一库已有"的,不动缺的);
       · 都做过了 ⇒ 不再喊。两个标记都是**每站点一次**,与扩展版本无关。 */
  async function migratedForCallers() {
    if (!(await migratedHere())) return false;
    return await purgedHere();
  }
  /* ---- 键前缀:统一库里混着所有站点的数据,而"小说 id"很可能在多个站点撞车(数字 id 尤其)
     ⇒ 落库的键统一带上"站点模块"前缀(esjzone|1788802361、novel18.syosetu.com|n0211ls …),
     脚本侧看到的仍是裸键(加/去前缀全在这里做)。
     esjzone.cc 与 esjzone.one 归同一个模块 ⇒ 跨镜像仍然去重(这正是当初"统一"的目的)。
     images 的键是 URL(天然唯一)、settings 是各站点共用的资源(字体/引擎/模型)⇒ 两者都不带前缀。 */
  const MIRROR = { 'esjzone.cc': 'esjzone', 'esjzone.one': 'esjzone' };
  function siteKey() {
    let h = String(location.hostname || '').toLowerCase();
    if (h.indexOf('www.') === 0) h = h.slice(4);
    return MIRROR[h] || h;
  }
  function keyNeedsPrefix(store) { return store === 'meta' || store === 'chapters'; }
  /* 加前缀:已经带前缀的原样返回(无论哪个站点模块 —— 带前缀的键里必有一个 '|');
     否则用给定模块(默认当前站点)前缀化。 */
  function addP(s, mod) { const t = String(s); if (t.indexOf('|') >= 0) return t; return (mod || siteKey()) + '|' + t; }
  function delP(s) { const t = String(s); const i = t.indexOf('|'); return i >= 0 ? t.slice(i + 1) : t; }
  const pfxKey = (store, key) => keyNeedsPrefix(store) ? addP(key) : key;
  const stripPfx = (store, key) => keyNeedsPrefix(store) ? delP(key) : key;
  /* 键藏在记录里(meta 的键是 novelId 字段;chapters 的键是 key 字段,且另带 novelId)⇒ 字段一起前缀化 */
  function pfxRec(store, rec) {
    if (!rec || typeof rec !== 'object') return rec;
    /* ⚠ 前缀用记录自带的站点戳(__siteKey),不是"当前站点":否则在 linovelib 上读一本 ESJ 的书、
       又保存一次(面板回填、术语表之类),就会新写出一条 linovelib| 的副本 —— 同一本书变两行。 */
    const mod = rec.__siteKey || '';
    if (store === 'meta') { const r = Object.assign({}, rec); if (r.novelId != null) r.novelId = addP(r.novelId, mod); return r; }
    if (store === 'chapters') { const r = Object.assign({}, rec); if (r.key != null) r.key = addP(r.key, mod); if (r.novelId != null) r.novelId = addP(r.novelId, mod); return r; }
    return rec;
  }
  /* 模块名 → 可用的真实域名:「详情页」要拼完整地址,而模块名不一定是域名
     (esjzone 是 .one/.cc 归一出来的模块名;linovelib.com / novel18.syosetu.com 这种本身就带点,直接用)。
     当前站点就是这个模块时直接用 location.hostname —— 最准(也保持站点内显示不变)。 */
  const MOD2DOM = { esjzone: 'www.esjzone.one' };
  function domOfMod(mod) {
    const m = String(mod || '');
    if (!m) return '';
    if (m === siteKey()) return location.hostname;
    return MOD2DOM[m] || (m.indexOf('.') >= 0 ? m : '');
  }
  /* 去前缀时顺手把站点戳补回去:早期写进统一库的记录(MIRROR 时代/旧 spike 迁移)只有"带前缀的键"、
     没有 __site 字段 ⇒ 在别的站点打开缓存管理时,行内站点名与「详情页」都退回当前域名
     (ESJ 抓的书显示成"www.linovelib.com"、详情页跳到 /novel/<id>.html 打不开)。
     键前缀本身带着模块,这里直接还原 —— 不用改库、老数据也立刻正确。 */
  function unPfxRec(store, rec) {
    if (!rec || typeof rec !== 'object') return rec;
    if (store === 'meta' || store === 'chapters') {
      const r = Object.assign({}, rec);
      const src = r.novelId != null ? r.novelId : (r.key != null ? r.key : '');
      const pfx = String(src).split('|');
      const mod = pfx.length > 1 ? pfx[0] : '';
      if (r.novelId != null) r.novelId = delP(r.novelId);
      if (store === 'chapters' && r.key != null) r.key = delP(r.key);
      /* v4.9.204-扩展移植(修"本地导入的书变未知小说 / 删不掉"):**键前缀才是权威**。
         原来的写法是「__site 已经有了就不动」,可 __site 是**写库那一刻**由 stamp() 打上的"当前页面域名"
         ⇒ 在哔哩哔哩这种非站点页面上导入一本本地书(或将来在别站重存一本跨站书)时,记录会带着
         __site=www.bilibili.com 而键前缀是 local-epub ⇒ 面板按 __site 读 meta / 拼删除键全部落空
         (书名退回「未知小说 <id>」、删除日志说删了实际一条没删)。这里一律以键前缀为准纠正,
         老数据不用改库,读一遍就自愈。 */
      if (mod) {
        const real = domOfMod(mod) || mod;
        if (r.__site !== real) r.__site = real;
        if (!r.__siteKey) r.__siteKey = mod;   // 也补上:之后在别站保存这本书才不会新写一份本站前缀的副本
      }
      return r;
    }
    return rec;
  }
  /* 章节记录是走另一条通道(chaptersBrief/chaptersOf,整表按书取)回来的,没经过 unPfxRec ⇒
     这里只补站点戳,键/novelId 的形状一律不动(改了会影响面板那些按原样 id 的调用)。
     v4.9.205-扩展移植(修「本地导入的书删不掉 / 章节与 meta 对不上」):**键前缀才是权威,不能被
     记录自带的 __site 挡住** —— __site 是写库那一刻由 stamp() 打上的"当时所在页面的域名"
     (在哔哩哔哩导入的本地书会带着 www.bilibili.com,而键前缀是 local-epub)⇒ 面板的
     buildBookRows 拿 __site 当分组键的一半、_lnSameBook 也拿它当"是不是同一本书"的判据
     ⇒ 章节那一组和 meta 那一行对不上、删书时章节也筛不中(用户实测:删了两次,只剩孤儿行)。
     现在一律按键前缀纠正(与 unPfxRec 同一口径),老数据读一遍即自愈。 */
  function withSite(c) {
    if (!c || typeof c !== 'object') return c;
    const src = c.novelId != null ? c.novelId : (c.key != null ? c.key : '');
    const pfx = String(src).split('|');
    if (pfx.length > 1) {
      const real = domOfMod(pfx[0]) || pfx[0];
      if (c.__site !== real) c.__site = real;
    }
    return c;
  }

  /* 站点戳:__site = 具体域名(面板显示用)、__siteKey = 站点模块(清空按它筛,跨镜像算一站)。
     settings(字体/引擎/模型)与 images(按 url 存)是各站点共用的资源,不打戳。 */
  function stamp(store, rec) {
    if (!rec || typeof rec !== 'object') return rec;
    if (store === 'meta' || store === 'chapters') {
      if (!rec.__site) rec.__site = location.hostname;
      if (!rec.__siteKey) rec.__siteKey = siteKey();
    }
    return rec;
  }
  /* 只问统一库。注意不能走 LN_STORE.has —— 它会把老库也算进来,迁移时就会全部误判成"已有"。 */
  const uniHas = (store, key) => call('has', { store, key: pfxKey(store, key) }).then((r) => !!r.yes);
  /* 统一库里若有"旧格式(无前缀)"的同一条记录 ⇒ 原地改成前缀格式(内容不动),免得它与别站的同名 id 撞 */
  async function ensurePrefixed(store, bareKey) {
    try {
      if (!(await call('has', { store, key: bareKey })).yes) return;
      const got = await call('get', { store, key: bareKey });
      if (got.val == null) return;
      const rec = await LN.dec(got.val);
      await call('put', { store, val: await LN.enc(pfxRec(store, rec)) });
      /* ⚠ 必须"按原样键删":del 现在带跨站兜底,会连刚写成前缀键的那条一起删掉 */
      await call('delExact', { store, key: bareKey });
    } catch (e) {}
  }

  async function migrateLegacy(onProgress) {
    const done = await migratedHere();
    const db = await openLegacy();
    if (!db) {
      /* v4.9.203-扩展移植(修 bug):没有老库 ⇒ **不打"已搬完"标记**。
         原来是"没老库也标记已搬完" ⇒ 属于空跑写标记:用户后来才跑油猴版(老库这时才被建出来)、
         或那次只建了一半 ⇒ 搬迁从此再不会被调用,那些书永远搬不进统一库(面板里就是"少了一本书");
         v4.9.178 于是加了"每个扩展版本再补扫一次差集"来救 —— 代价是把你在面板里删掉的书也搬回来。
         现在改成:没得搬就只回一句,标记留给**真搬过一次**的时候打(openLegacy 已记忆化 ⇒
         之后每次问都只是内存里判一下,不碰磁盘;万一以后老库真出现了,下次打开面板就会搬)。 */
      if (!_noLegacyLogged) {
        _noLegacyLogged = true;
        try { console.info('[ln-port] 本站没有油猴时代的老库(' + LEGACY_DB + '):先不打"已搬完"标记(以后真出现了再搬)'); } catch (e) {}
      }
      return { skipped: true, empty: true, moved: 0, failed: 0 };
    }
    /* v4.9.203 → v4.9.204:搬迁的定义改成"**搬家 + 清空老库**"(用户口径:「初次搬迁时就把老库删干净,
       不需要老库了」),两段:
       · 本站第一次搬(首访):统一库里缺的都补进去(一条不丢),搬完把老库那几条清掉 ⇒ 一次到位;
       · 本站早搬过、只是老库还没清(升级上来的):只清"统一库里**已经**有的"那些,缺的**不搬**
         (免得把你在面板里删掉的书又搬回来);唯一的例外是 settings(字体 / 模型 / 引擎)——
         那是各站点共用的资源、不是"书",统一库缺的就补进去,不然"清老库"等于把你那份模型删了。
       清完打 PURGED 标记,**每站点只做一次、不按扩展版本**(按版本就会重演"删掉的又回来")。 */
    if (await purgedHere()) {
      if (!_migDoneLogged) {
        _migDoneLogged = true;
        try { console.info('[ln-port] 本站老库已搬完并清空过:跳过'); } catch (e) {}
      }
      return { skipped: true, moved: 0, failed: 0 };
    }
    const purgeOnly = done;            // true = 只清"统一库已有"的(升级上来的老站点);false = 首访,缺的照搬
    let quick = true;                  // 只影响"用一次键列表比差集"这条快路(省掉逐条问)
    if (!_startLogged) {
      _startLogged = true;
      try { console.info('[ln-port] 本站老库搬迁开始:' + (purgeOnly ? '这次只清"统一库已有"的那些(缺的不搬,settings 除外)' : '统一库里缺的补进去,已有的跳过') + ';搬完清空老库'); } catch (e) {}
    }
    let moved = 0, failed = 0, sawKeys = false;
    const report = [], imported = [];
    /* v4.9.204:settings 也一并处理 —— 但"缺的"只补 settings:
       · 首访:settings 照搬(字体 / 模型 / 引擎;大件走分片搬运);
       · 清空模式:settings 缺的也补(它是各站点共用的资源,不补就等于"清老库"时把它删了),
         meta / chapters / images 缺的**不补**(那才可能是你在面板里删掉的书 / 章节 / 图)。
       ⚠ 搬运成功才进清理清单,失败的原样留在老库(下次继续;不会"标了却没搬走")。 */
    for (const store of ['meta', 'chapters', 'images', 'settings']) {
      const keys = (await lKeys(db, store)) || [];
      if (!keys.length) { report.push(store + ' 0 条'); continue; }
      sawKeys = true;                                     // 老库里确实有东西 ⇒ 搬完可以打标记
      /* 先把统一库这一张表的键一次全拿回来(一条消息),本地比差集 ⇒ 不用逐条问 */
      let uni = null;
      if (quick) {
        try {
          const r = await call('keys', { store });
          /* v4.9.203:差集只认"本站的键"+"旧格式(无前缀)的键"。别的站点的同号 id
             (数字 id 很容易撞)不能算成本站已有,否则那本书会被跳过、永远搬不进来。 */
          uni = new Set((r.keys || []).map((k) => String(k))
            .filter((k) => k.indexOf('|') < 0 || k.slice(0, k.indexOf('|')) === siteKey())
            .map((k) => String(stripPfx(store, k))));
        } catch (e) { uni = null; }
      }
      let miss = 0, leftOver = 0;
      const clearable = [];                               // 老库里这些键可以清了(已在统一库 / 刚搬进去 / 你删过)
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        try {
          if (await delLedgerHas(store, k)) { clearable.push(k); continue; }   // 你在面板里删过 ⇒ 老库那份是废件
          if ((uni && uni.has(String(k))) || await uniHas(store, k)) { clearable.push(k); continue; }   // 统一库已有
          if ((await call('has', { store, key: k })).yes) {
            await ensurePrefixed(store, k);                    // 库里是旧格式(无前缀)⇒ 原地改成前缀格式
            clearable.push(k); continue;
          }
          /* 统一库里没有这条 */
          if (purgeOnly && store !== 'settings') { leftOver++; continue; }    // 清空模式:不搬(免得删掉的书回来)
          const rec = await lGet(db, store, k);
          if (rec == null) { clearable.push(k); continue; }  // 老库里这条读不出来(空记录)⇒ 当废件清掉
          await LN_STORE.put(store, stamp(store, rec));
          moved++; miss++;
          if (store === 'meta') { try { const t = String((rec && rec.title) || ''); if (t && imported.length < 5) imported.push(t); } catch (e) {} }
          clearable.push(k);
        } catch (e) { failed++; }
        if (onProgress) { try { onProgress(store, i + 1, keys.length, moved); } catch (e) {} }
      }
      /* v4.9.204:"把老库删干净"的落点 —— 已在统一库 / 刚搬进去 / 你删过的那批,老库那份删掉。
         删不动的(事务失败)留在原地,下次打开面板再试(所以标记只在"零失败"时才打)。 */
      let cleared = 0;
      for (const k of clearable) { try { if (await lDel(db, store, k)) cleared++; } catch (e) {} }
      report.push(store + ' ' + keys.length + ' 条/搬运 ' + miss + '/清 ' + cleared + (leftOver ? '/留 ' + leftOver : ''));
    }
    /* 有失败就不打标记:下次打开面板会继续处理(避免"标了但没搬全"⇒ 之后读不到那些书)。
       v4.9.203:老库里一条记录都没有时也不打标记 —— 那种"空库"(扩展自己为存大件而建的
       esjzone_epub_cache 就是空的)一旦打了标记,以后油猴版真往里写了书就再也不会被搬进来。
       v4.9.204:只有**一个失败都没有**才打"清空过"标记 —— 有失败就下次再来(老库还留着没搬完的)。 */
    if (!failed && sawKeys) { await markMigrated(); await markPurged(); }
    /* v4.9.203:老库是空的时候这条不打了 —— 面板每 20 秒重绘一次都会问一句"搬过没",
       空库站点会变成刷屏(那种站点本来也没什么可说的:四条 0 条)。 */
    if (moved || failed || sawKeys) {
      try { console.info('[ln-port] 本站老库搬迁' + (purgeOnly ? '(清空模式)' : '') + '结果:搬了 ' + moved + ' 条 · 失败 ' + failed + ' 条 · ' + report.join(' / ') + (failed ? '(未标记,下次打开面板继续)' : ' · 搬走的那些已从老库清掉')); } catch (e) {}
    }
    if (imported.length) {
      try { console.info('[ln-port] 这次从老库搬回来的书:' + imported.join(' / ') + '(里面若有你早就删掉的,再删一次就好 —— 老库清完不会再有)'); } catch (e) {}
    }
    return { skipped: false, moved, failed };
  }

  /* ------------------------- 对外的 8 个函数(签名/返回与原来一致) ------------------------- */
  /* ---- v4.9.168-扩展移植:超大件(OCR 模型 / onnxruntime 运行时)回"站点本地库" ----
     这两类记录是几十 MB 级的二进制,而扩展消息通道是 JSON 序列化(还要 base64 + 压缩搬运):
     写可能超限失败、读一旦出岔子就会被上层的空 catch 吞掉 —— 表现出来就是
     "明明下过模型却当成没缓存 ⇒ 清掉缓存重下 ⇒ 网络不通就报「模型下载失败」",
     而清掉的正是用户唯一那份。处理:这些键的读写都回**页面本地库**
     (= 油猴时代的样子,站点各自一份,全程在页面内、不过通道);
     get 本地没有时才问统一库(兼容早前写进统一库的那一份),取到顺手回填本地,下次页面内直读。
     面板看大小走 metaOnly(那条本来就剥二进制 + 本地兜底),不受影响;del 本来就两边都删。 */
  const LOCAL_BIG = /^(paddle_model_|ortwasm)/;
  const isLocalBig = (store, key) => store === 'settings' && key != null && LOCAL_BIG.test(String(key));
  function lPut(db, store, key, val) {
    return new Promise((res) => {
      try {
        const t = db.transaction(store, 'readwrite');
        t.objectStore(store).put(val, key);
        t.oncomplete = () => res(true);
        t.onerror = () => res(false);
        t.onabort = () => res(false);
      } catch (e) { res(false); }
    });
  }
  /* ---- v4.9.180-扩展移植:这个本地副本**不再使用**了(大件只留统一库那一份,见 put / get)----
     留着这段代码只为一件事:把老版本在用户机器上留下的 `lnlocal` **清掉**(它现在纯占地方)。
     清完不再建;于是"删缓存 = 真删" ⇒ 下次要重下,和用户预期一致(实测那句
     "删了缓存还能一瞬间加载上,那和卸载有什么区别")。 */
  const LOCAL_DB = 'lnlocal';
  try {
    const _dropLnLocal = () => {
      try {
        if (!indexedDB.databases) return;
        indexedDB.databases().then((l) => {
          if (!l || !l.some((d) => d.name === LOCAL_DB)) return;
          const rq = indexedDB.deleteDatabase(LOCAL_DB);
          rq.onsuccess = () => { try { console.info('[ln-port] 已清理旧版留下的页面本地大件副本(lnlocal):大件现在只存统一库那一份'); } catch (e) {} };
        }).catch(() => {});
      } catch (e) {}
    };
    setTimeout(() => { try { if (typeof requestIdleCallback === 'function') requestIdleCallback(_dropLnLocal, { timeout: 5000 }); else _dropLnLocal(); } catch (e) {} }, 3000);
  } catch (e) {}
  let localP = null, localBad = false;
  function openLocal() {
    if (localBad) return Promise.resolve(null);
    if (localP) return localP;
    localP = new Promise((resolve) => {
      try {
        const rq = indexedDB.open(LOCAL_DB, 1);
        rq.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('big')) db.createObjectStore('big', { keyPath: 'key' });
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => { localBad = true; resolve(null); };
      } catch (e) { localBad = true; resolve(null); }
    });
    return localP;
  }
  async function lGetBigLocal(key) {
    try {
      const db = await openLocal(); if (!db) return null;
      return await new Promise((res) => {
        try {
          const rq = db.transaction('big', 'readonly').objectStore('big').get(String(key));
          rq.onsuccess = () => res(rq.result ? rq.result.val : null);
          rq.onerror = () => res(null);
        } catch (e) { res(null); }
      });
    } catch (e) { return null; }
  }
  async function lPutBigLocal(key, val) {
    try {
      const db = await openLocal(); if (!db) return false;
      return await new Promise((res) => {
        try {
          const t = db.transaction('big', 'readwrite');
          t.objectStore('big').put({ key: String(key), val: val, at: Date.now() });
          t.oncomplete = () => res(true);
          t.onerror = () => res(false);
          t.onabort = () => res(false);
        } catch (e) { res(false); }
      });
    } catch (e) { return false; }
  }
  /* 删「页面本地库」里的大件副本:lnlocal 是后来新增的,而 del 只管统一库 + 老库两份 ⇒
     删了本地那份还在。后果两条:①"删了还在"(下次读本地命中 ⇒ 秒加载、也不重新下载,
     看着像"模型没删掉却又能用");②统一库被删空之后,扩展侧常驻引擎就再也找不到模型
     (它只能读统一库)。这里补上第三个地方。 */
  async function lDelBigLocal(key) {
    try {
      const db = await openLocal(); if (!db) return false;
      return await new Promise((res) => {
        try {
          const t = db.transaction('big', 'readwrite');
          t.objectStore('big').delete(String(key));
          t.oncomplete = () => res(true);
          t.onerror = () => res(false);
          t.onabort = () => res(false);
        } catch (e) { res(false); }
      });
    } catch (e) { return false; }
  }
  async function lGetBig(key) {
    const lv = await lGetBigLocal(key);
    if (lv != null) return lv;
    try { const db = await openLegacy(); if (!db) return null; return await lGet(db, 'settings', key); } catch (e) { return null; }
  }
  async function lPutBig(key, val) {
    const ok = await lPutBigLocal(key, val);
    if (ok) return true;
    try { const db = await openLegacy(); if (!db) return false; return await lPut(db, 'settings', key, val); } catch (e) { return false; }
  }
  /* ---- v4.9.169-扩展移植:超大件走"**分片搬运**" ------------------------------------------
     统一库那一份是**跨站点共用**的真源,但它几十 MB,塞不进一条 JSON 消息(见 offscreen-db.js 的说明)。
     于是按 3 MB 一片搬:读方向十来次来回拼回整条;写方向一片片发过去,由 offscreen 拼齐后落库。
     再配合 get/put 的"本地优先 + 本地回填":同一站点第二次起就是页面内直读(秒开),
     只有"换站第一次用它"才需要搬一次。统一库依旧是唯一真源 ⇒ 跨站点共用照旧。 */
  /* 6 MB 一片(原来 3 MB):一片 = 一个"来回",而每次来回要过 内容脚本→SW→offscreen 两跳,
     片数减半 ⇒ 首次搬运快一倍;6 MB 也远小于"一条消息塞不下"的那个量级。 */
  const BIG_CHUNK = 6 * 1024 * 1024;
  /* v4.9.177:大件"补进统一库"每个键只试一次(免得每次读都重试、白跑一趟消息) */
  const _uniHealTried = new Set();
  /* v4.9.179:同一个大件"正在往统一库搬"只准有一份 —— 三处都会发它(写的时候顺手发、
     读到本地那份时补发、建引擎前补齐),不去重就会把 155 MB 的模型同时搬两三遍。 */
  const _uniPush = new Map();
  function uniPush(store, key, val) {
    const k = store + '|' + key;
    const cur = _uniPush.get(k);
    if (cur) return cur;
    const p = (async () => {
      try { return await bigPutUni(store, key, val); }
      finally { _uniPush.delete(k); }
    })();
    _uniPush.set(k, p);
    return p;
  }
  const BIG_OP_TIMEOUT = 90000;   // 单个分片来回的上限(正常一片几百毫秒);卡住要**报出来**,不能无限转圈
  const _nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  function withTimeout(p, ms, what) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(what + '超时(' + Math.round(ms / 1000) + ' 秒内没有回应)')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }
  async function bigGetUni(key) {
    const t0 = _nowMs();
    const b = await withTimeout(call('bigBegin', { store: 'settings', key }), BIG_OP_TIMEOUT, '大件分片读·打开会话');
    if (!b || !b.found) return null;
    const n = Math.max(1, b.n | 0);
    try { console.info('[ln-port] 大件分片读 ' + key + ':' + (b.len / 1048576).toFixed(1) + ' MB / ' + n + ' 片,开始搬(本站第一次用它才走这里,之后是页面内直读)'); } catch (e) {}
    let s = '';
    try {
      for (let i = 0; i < n; i++) {
        const r = await withTimeout(call('bigChunk', { store: 'settings', key, i }), BIG_OP_TIMEOUT, '大件分片读·第 ' + (i + 1) + '/' + n + ' 片');
        if (!r || !r.ok) throw new Error((r && r.error) || '分片读失败');
        s += (r.s || '');
        /* 进度不用每片都刷屏:25% / 50% / 75% 各一行(片数少时也就 0~2 行) */
        if (n >= 4 && ((i + 1) === Math.round(n * 0.25) || (i + 1) === Math.round(n * 0.5) || (i + 1) === Math.round(n * 0.75))) {
          try { console.info('[ln-port] 大件分片读 ' + key + ':第 ' + (i + 1) + '/' + n + ' 片 · 累计 ' + Math.round(_nowMs() - t0) + 'ms'); } catch (e) {}
        }
      }
    } finally { try { await withTimeout(call('bigEnd', { store: 'settings', key }), 10000, '大件分片读·收尾'); } catch (e) {} }
    const out = unPfxRec('settings', LN.dec(JSON.parse(s)));
    try { console.info('[ln-port] 大件分片读 ' + key + ' 完成:' + Math.round(_nowMs() - t0) + 'ms'); } catch (e) {}
    return out;
  }
  async function bigPutUni(store, key, val) {
    const t0 = _nowMs();
    const v = pfxRec(store, stamp(store, val));
    const s = JSON.stringify(await LN.enc(v));
    const n = Math.max(1, Math.ceil(s.length / BIG_CHUNK));
    /* v4.9.179:这条写现在多半是**后台**跑的(不挡页面),所以必须打得出来 —— 否则 155 MB 的模型
       要搬三十几个来回,屏幕上就是"进度 100% 之后一直没反应"(实测就是这么被当成卡死的)。 */
    try { console.info('[ln-port] 大件分片写 ' + key + ':' + (s.length / 1048576).toFixed(1) + ' MB / ' + n + ' 片,开始搬进统一库(后台)'); } catch (e) {}
    await withTimeout(call('bigPutBegin', { store, key }), BIG_OP_TIMEOUT, '大件分片写·打开会话');
    try {
      for (let i = 0; i < n; i++) {
        const r = await withTimeout(call('bigPutChunk', { store, key, i, s: s.slice(i * BIG_CHUNK, (i + 1) * BIG_CHUNK) }), BIG_OP_TIMEOUT, '大件分片写·第 ' + (i + 1) + '/' + n + ' 片');
        if (!r || !r.ok) throw new Error((r && r.error) || '分片写失败');
        if (n >= 4 && ((i + 1) === Math.round(n * 0.25) || (i + 1) === Math.round(n * 0.5) || (i + 1) === Math.round(n * 0.75))) {
          try { console.info('[ln-port] 大件分片写 ' + key + ':第 ' + (i + 1) + '/' + n + ' 片 · 累计 ' + Math.round(_nowMs() - t0) + 'ms'); } catch (e) {}
        }
      }
    } catch (e) {
      try { await call('bigPutAbort', { store, key }); } catch (e2) {}
      throw e;
    }
    await withTimeout(call('bigPutEnd', { store, key }), BIG_OP_TIMEOUT, '大件分片写·落库');
    try { console.info('[ln-port] 大件分片写 ' + key + ' 完成:' + (s.length / 1048576).toFixed(1) + ' MB / ' + n + ' 片 · ' + Math.round(_nowMs() - t0) + 'ms'); } catch (e) {}
    return unPfxRec(store, v);
  }

  const LN_STORE = {
    open: () => call('open').then(() => true),
    put: async (store, val) => {
      /* 超大件:① 先落**页面本地库**(本站秒读)② 再**分片**写进统一库(跨站点共用) */
      if (isLocalBig(store, val && val.key)) {
        /* v4.9.180:大件(OCR 模型 / ORT 运行时)**只存统一库那一份** —— 页面本地副本取消。
           为什么能取消:引擎现在常驻在 offscreen(见 lib/ocr-host.js),它读的是**自己库里的**字节,
           一个字节都不过通道;页面侧只有"扩展侧引擎建不起来"时才兜底建一次,那时才会需要字节。
           为什么该取消:留两份就会出现"删了缓存还秒开"(删的是一处、读的是另一处 —— 正是实测那句
           "那和卸载有什么区别"),而且每个站点都多存几十上百 MB。
           这条路要**等它落库**(几十 MB 要分片搬十几~几十个来回,进度一路打在控制台):
           落库才算"下好了";失败就如实抛出(本地没有备份,不能假装成功)。 */
        try { if (MEMO_SETTINGS_KEYS.has(val.key)) fontMemo.delete('settings/' + val.key); } catch (e) {}
        await uniPush(store, val.key, val);
        return val;                                      // 调用方看到的仍是原值
      }
      const v = pfxRec(store, stamp(store, val));        // 站点戳 + 键前缀(meta/chapters)
      await call('put', { store, val: await LN.enc(v) });
      /* 记忆失效:这条刚被改过,别再拿旧的 */
      try {
        if (store === 'settings' && v && MEMO_SETTINGS_KEYS.has(v.key)) fontMemo.delete('settings/' + v.key);
        if (store === 'chapters') chapMemo.clear();
      } catch (e) {}
      return unPfxRec(store, v);                         // 调用方看到的仍是裸值
    },
    get: async (store, key) => {
      /* v4.9.176-扩展移植:阅读器后几章预取的记忆命中就直接给 —— 别再走一次消息通道 */
      if (store === 'chapters') {
        const _pkh = pfMemo.get(String(key));
        if (_pkh && Date.now() - _pkh.at < PF_TTL) return _pkh.val;
      }
      /* 超大件:① 先看页面本地库(页面内直读、秒开)② 本地没有(换站了 / 清过)再从统一库**分片**搬回来,
         搬完顺手落下本地那份 ⇒ 之后本站每次都是页面内直读。跨站点共用就是这么实现的。 */
      if (isLocalBig(store, key)) {
        /* v4.9.180:大件只有统一库这一份(页面本地副本取消,理由见 put)⇒ 直接分片搬回来。
           搬之前先问一句本站老库(油猴时代那份站点 origin 的库):有就直接用 —— 省一次几十 MB 的
           搬运,并且顺手把它补进统一库(下一台设备/下一个站点就不用再下)。 */
        let uv = null;
        try { uv = await bigGetUni(key); }
        catch (e) { try { console.warn('[ln-port] 大件分片读失败: ' + ((e && e.message) || e)); } catch (e2) {} }
        if (uv != null) return uv;
        try {
          const db = await openLegacy();
          if (!db) return null;
          const lv = await lGet(db, store, key);
          if (lv == null) return null;
          uniPush(store, key, lv).catch(() => {});       // 顺手回填统一库(失败无所谓,下次再说)
          return lv;
        } catch (e) { return null; }
      }
      /* 字体类大件(嵌入字模/阅读字体):命中记忆就直接给 —— 否则每开一次阅读器都要把这几十 MB 搬过通道 */
      if (store === 'settings' && MEMO_SETTINGS_KEYS.has(key)) {
        const mk = 'settings/' + key, hit = fontMemo.get(mk);
        if (hit && Date.now() - hit.at < MEMO_TTL) return hit.val;
      }
      const r = await call('get', { store, key: pfxKey(store, key) });
      if (r.val != null) {
        const val = unPfxRec(store, await LN.dec(r.val));
        if (store === 'settings' && MEMO_SETTINGS_KEYS.has(key)) fontMemo.set('settings/' + key, { at: Date.now(), val });
        if (isLocalBig(store, key)) { try { await lPutBig(key, val); } catch (e) {} }   // 回填本地,下次页面内直读
        return val;
      }
      /* settings 是各站点共用的资源(字体/引擎/模型),可能几十 MB —— 迁移时**不搬它们**,
         改成"用到了才取、取到就回填"(为了几个共用文件把 24 MB 字体搬一遍太亏)。
         其余三个表搬完就不再回头读老库。
         v4.9.168-扩展移植:images 是例外 —— 图片可能是"迁移之后新增 / 该站迁移时还没有"的那批,
         统一库列表里看不见它,可字节明明躺在站点 origin 的老库里(封面正是这种:
         面板说"未缓存",其实老库里就有一份,导出时白下一遍)。 */
      if (store !== 'settings' && store !== 'images' && await migratedHere()) return null;
      return await legacyGet(store, key);                // 老库里的键是裸的
    },
    /* 批量取(**一个来回**拿多件)。给面板取封面缩略图用:列表里的图片是"便宜读"回来的占位(没有
       真二进制),而缩略图必须要真 Blob ⇒ 原来每本各发一次单条读,70 本书就是 70 个消息来回 ——
       这正是"刷新页面后第一次打开缓存管理要等一会儿,第二次打开就很快"的主因
       (第二次命中了页面内的 _coverBlobCache)。这里一次读回来。 */
    getMany: async (store, keys) => {
      const list = Array.isArray(keys) ? keys : [];
      if (!list.length) return [];
      const r = await call('getMany', { store, keys: list });
      const out = [];
      for (const v of (r.vals || [])) out.push(v == null ? null : await LN.dec(v));
      /* v4.9.168-扩展移植:统一库里没有的那些,再问一次**本站老库**(图片可能是"迁移之后新增 /
         该站迁移时还没有"的那批 —— 统一库列表里看不见,字节却在老库里躺着)。
         老库读是页面内直读、不过消息通道,一次问完也不贵;命中时 legacyGet 会顺手回填进统一库。
         没有这一步,面板里每本书的封面都要各发一次单条 IPC 读(第二次打开仍要等)。
         口径与 get() 完全一致:settings / images 一直允许读老库,其余表迁移完就不回头。 */
      if (store === 'settings' || store === 'images' || !(await migratedHere())) {
        for (let i = 0; i < list.length; i++) {
          if (out[i] != null) continue;
          try { const lv = await legacyGet(store, list[i]); if (lv != null) out[i] = lv; } catch (e) {}
        }
      }
      return out;
    },
    del: async (store, key) => {
      await call('del', { store, key: pfxKey(store, key) });
      /* 旧格式(无前缀)的同一条也删掉,免得它又冒出来 */
      if (keyNeedsPrefix(store)) { try { await call('del', { store, key: String(key) }); } catch (e) {} }
      /* v4.9.168-扩展移植:settings / images 不随迁移走(一个"用到再取"、一个各 origin 各一份)
         ⇒ 这两张表上删东西时,老库那份也得删,否则它会从老库"复活"。 */
      if (store === 'settings' || store === 'images') {
        try { const db = await openLegacy(); if (db) await lDel(db, store, key); } catch (e) {}
      }
      /* v4.9.203-扩展移植(修 bug):**meta / chapters 的老库那份也要删**。
         原来只删 settings / images,理由是"这几张表搬完就不再回头读老库";可"每次打开面板的搬迁"
         偏偏会回头读 ⇒ 在面板里删掉的书 / 章节,下次打开又回来了(实测:两本已删的书复活)。
         老库那份对 meta / chapters 已经没有读取价值(搬迁完成后 get / all / has 都不再回读),
         清掉既治复活,也顺手把那份占用还给你。顺便记一笔"删过的键"(见删除账本):
         万一清不掉(在 A 站删 B 站的书,内容脚本够不到 B 站的 origin)也不会被搬回来。 */
      if (keyNeedsPrefix(store)) {
        try { await legacyDelKeys(store, [key]); } catch (e) {}
        try { await delLedgerAdd(store, [key]); } catch (e) {}
      }
      /* v4.9.177:大件还有第三份 —— 页面本地库(lnlocal)。不删它就会"删了还在" */
      if (store === 'settings' && isLocalBig(store, key)) { try { await lDelBigLocal(key); } catch (e) {} }
      try {
        if (store === 'settings' && MEMO_SETTINGS_KEYS.has(key)) fontMemo.delete('settings/' + key);
        if (store === 'chapters') chapMemo.clear();
      } catch (e) {}
    },
    /* v4.9.168-扩展移植:批量删(**一个来回**删多个键)。语义与单条 del 完全一致 ——
       带前缀的库内键 + 旧格式(无前缀)也删 + settings/images 顺带清老库那份 + 记忆化失效。
       漏掉任何一条,删掉的记录都会从老库/记忆化里"复活"。 */
    delMany: async (store, keys) => {
      const list = (Array.isArray(keys) ? keys : []).filter((k) => k != null).map(String);
      if (!list.length) return 0;
      await call('delMany', { store, keys: list.map((k) => pfxKey(store, k)) });
      if (keyNeedsPrefix(store)) { try { await call('delMany', { store, keys: list }); } catch (e) {} }
      if (store === 'settings' || store === 'images') {
        try {
          const db = await openLegacy();
          if (db) for (const k of list) { try { await lDel(db, store, k); } catch (e) {} }
        } catch (e) {}
      }
      /* v4.9.203-扩展移植(修 bug):meta / chapters 的老库那份也删(理由见单条 del) */
      if (keyNeedsPrefix(store)) {
        try { await legacyDelKeys(store, list); } catch (e) {}
        try { await delLedgerAdd(store, list); } catch (e) {}
      }
      /* v4.9.177:大件在页面本地库(lnlocal)还有第三份,一并删 */
      if (store === 'settings') for (const k of list) { if (isLocalBig(store, k)) { try { await lDelBigLocal(k); } catch (e) {} } }
      try {
        if (store === 'settings') for (const k of list) { if (MEMO_SETTINGS_KEYS.has(k)) fontMemo.delete('settings/' + k); }
        if (store === 'chapters') chapMemo.clear();
      } catch (e) {}
      return list.length;
    },
    /* 迁移前:老库还是唯一数据源 ⇒ 两个库都清(与油猴时代表现一致)。
       迁移后:统一库里混着所有站点的数据 ⇒ 只按站点戳清本站(.one/.cc 算同一站);
       settings/images 是共用资源,不动(交给「清理孤儿数据」与资源行上的删除按钮)。 */
    clear: async (store) => {
      if (await migratedHere()) {
        if (store === 'meta' || store === 'chapters') await call('delBySite', { store, site: siteKey() });
        return;
      }
      await call('clear', { store });
      const db = await openLegacy();
      if (db) await lClear(db, store);
    },
    all: async (store) => {
      /* 插图只回传元信息(它们的二进制很大,而调用方只用到 url) */
      const stripBlobs = store === 'images';
      const r = await call('all', { store, stripBlobs });
      const mine = (r.vals || []).map((v) => unPfxRec(store, LN.dec(v)));   // 裸值给调用方
      if (store !== 'settings' && await migratedHere()) return mine;    // 统一库已含全部站点 ⇒ 不再并老库
      const db = await openLegacy();
      if (!db) return mine;
      const lrecs = (await lAll(db, store)) || [];       // 老库**一次性批量读**(原来是逐条 lGet:几百章就是几百次往返)
      if (!lrecs.length) return mine;
      const kf = KEYF[store] || 'key';
      const have = new Set(mine.map((v) => v && v[kf]).filter((x) => x != null));
      const extra = [];
      for (const rec of lrecs) {
        if (!rec) continue;
        const k = rec[kf];
        if (k == null || have.has(k)) continue;
        extra.push(stripBlobs ? { url: k, fromLegacy: true } : rec);     // 老库插图:只给键(上面已说明)
      }
      return mine.concat(extra);
    },
    count: async (store) => {
      const r = await call('count', { store });
      if (store !== 'settings' && await migratedHere()) return r.n || 0;
      const rk = await call('keys', { store });
      const mine = new Set((rk.keys || []).map((k) => String(stripPfx(store, k))));   // 库里的键带前缀,比之前先剥掉
      const lk = await legacyKeys(store);
      let extra = 0;
      for (const k of lk) if (!mine.has(String(k))) extra++;
      return (r.n || 0) + extra;
    },
    has: async (store, key) => {
      if ((await call('has', { store, key: pfxKey(store, key) })).yes) return true;
      if (keyNeedsPrefix(store) && (await call('has', { store, key: String(key) })).yes) return true;  // 旧格式
      /* 同上:images 也要算上老库(理由见 get) */
      if (store !== 'settings' && store !== 'images' && await migratedHere()) return false;
      const db = await openLegacy();
      if (!db) return false;
      return (await lGet(db, store, key)) != null;
    },
    /* ---- 扩展移植专用:便宜的读(面板/目录要看"多大"、要列章节,不需要把字节搬过消息通道) ----
       ① metaOnly(store,key):记录照旧,但二进制换成能回答 .size / .byteLength 的占位 ——
          字模 24 MB / 模型几十 MB / wasm 十几 MB 不再 base64 过通道(它们只是要显示占用);
       ② chaptersBrief(novelId):章节不带正文,附 __textBytes(正文+译文/原文字节数);
       ③ chaptersOf(novelId):章节**全量**但只取一本书(导出/阅读要正文,不必把别的书的正文也搬来)。 */
    metaOnly: async (store, key) => {
      /* 本地剥二进制:老库读出来的是本 origin 的 Blob 句柄,不过通道,直接本地换算大小 */
      const stripLocal = (v, d) => {
        d = d || 0;
        if (v == null || typeof v !== 'object' || d > 4) return v;
        if (typeof Blob !== 'undefined' && v instanceof Blob) return { size: v.size, byteLength: v.size, type: v.type || '', stub: true };
        if (v instanceof ArrayBuffer) return { size: v.byteLength, byteLength: v.byteLength, stub: true };
        if (ArrayBuffer.isView(v)) return { size: v.byteLength, byteLength: v.byteLength, stub: true };
        if (Array.isArray(v)) return v.map((x) => stripLocal(x, d + 1));
        const o = {};
        for (const k of Object.keys(v)) o[k] = stripLocal(v[k], d + 1);
        return o;
      };
      try {
        const r = await call('getMeta', { store, key: pfxKey(store, key) });
        if (r.val) return r.val;
        if (keyNeedsPrefix(store)) {
          const r2 = await call('getMeta', { store, key: String(key) });
          if (r2.val) return r2.val;
        }
      } catch (e) {}
      try {
        const db = await openLegacy();
        if (!db) return null;
        const rec = await lGet(db, store, key);
        return rec == null ? null : stripLocal(rec);
      } catch (e) { return null; }
    },
    chaptersBrief: (novelId) => call('chaptersBrief', { store: 'chapters', novelId }).then((r) => (r.vals || []).map(withSite)),
    /* 章节**全量**但只取一本书;**短期记忆**:阅读器开场会连着调两次(先归一化 order、再取有序列表),
       同一本书的正文没必要搬两遍(4 MB 的书 = 白省一遍 4 MB 的 JSON 过通道)。 */
    chaptersOf: (novelId) => {
      const k = String(novelId), hit = chapMemo.get(k);
      if (hit && Date.now() - hit.at < CHAP_TTL) return Promise.resolve(hit.vals);
      return call('chaptersOf', { store: 'chapters', novelId }).then((r) => {
        const vals = (r.vals || []).map(withSite);
        if (chapMemo.size > 8) chapMemo.clear();
        chapMemo.set(k, { at: Date.now(), vals });
        return vals;
      });
    },
    /* 给调试用:看看桥活着没 */
    ping: () => call('open').then(() => true).catch(() => false),
    /* 给面板用:本站老库搬进统一库(搬过一次就变 no-op);migrated() 供调用方先问一句。
       并发去重:同一时刻只跑一次(不然面板后台搬迁 + 用户手动点会各搬一遍)。 */
    migrate: (onProgress) => {
      if (!migP) {
        migP = migrateLegacy(onProgress).then((r) => { migP = null; return r; }, (e) => { migP = null; throw e; });
      }
      return migP;
    },
    migrated: migratedForCallers,
  };

  globalThis.LN_STORE = LN_STORE;

  /* ------------------------- v4.9.176-扩展移植:阅读器「后几章预取」-----------------------------
     阅读器点「下一章」= 从统一库读这一章的记录(正文 HTML,常见 0.3~3 MB,过消息通道要 0.3~2 秒)。
     油猴时代这是"页面内直读 IDB"(几乎 0ms),搬到扩展后就成了唯一那下"点了等一下"的来源。
     这里给阅读器一个入口:趁空把**后面几章**的记录先读进内存(与 OCR 归档预读同一招),
     点下去时 get('chapters', …) 直接命中 ⇒ 立刻出。
     只预取**记录**,不渲染、不碰 DOM ⇒ 不影响任何现有行为;读失败静默,点开照旧走原路径。
     真源仍在库里:任何章节写入/删除都会立刻作废(见 call() 里的失效钩子)。 */
  const pfMemo = new Map();                  // 'novelId/cid'(裸键,与 getChapter 一致)-> { at, val }
  const PF_TTL = 5 * 60 * 1000;
  const PF_MAX = 4;                          // 当前章前后各留一点就够,多了白占内存
  const pfRunning = new Set();
  async function prefetchChapter(novelId, cid) {
    try {
      if (novelId == null || cid == null) return false;
      const k = String(novelId) + '/' + String(cid);
      const hit = pfMemo.get(k);
      /* v4.9.182:命中时把**记录本身**还回去(阅读器要用它的 imgUrls 预取插图)—— 原来只回 true。
         既有调用方都只看"成没成"(不看返回值),所以多给一点信息不影响任何行为。 */
      if (hit && Date.now() - hit.at < PF_TTL) return hit.val || true;
      if (pfRunning.has(k)) return false;
      pfRunning.add(k);
      try {
        const v = await LN_STORE.get('chapters', k);
        if (v) {
          pfMemo.delete(k);
          pfMemo.set(k, { at: Date.now(), val: v });
          while (pfMemo.size > PF_MAX) { const f = pfMemo.keys().next().value; pfMemo.delete(f); }
          return v;
        }
      } finally { pfRunning.delete(k); }
      return false;
    } catch (e) { return false; }
  }
  LN_STORE.prefetchChapter = prefetchChapter;
  /* v4.9.183-扩展移植(六项路线 ③):给面板「配置与运行数据」区看的一眼数字(只读)。
     顺手把 extVer 也导出一份 —— 面板要靠它显示"现在跑的是哪一版"(版本号是唯一可靠的判据)。 */
  LN_STORE.prefetchStats = () => ({ n: pfMemo.size, max: PF_MAX, ttlMs: PF_TTL });
  LN_STORE.extVersion = extVer;

  /* v4.9.185-扩展移植(六项路线 ③):面板「🗄 其他存储」要用的几件事 —— 都只是往 offscreen 转一手。
     ⚠ 只列键名 / 只删单键,绝不把 settings 的**值**拉进页面:里面躺着几十 MB 的 OCR 模型字节。 */
  LN_STORE.settingsKeys = async () => {
    try {
      const r = await call('keys', { store: 'settings' });
      const arr = (r && (r.keys || r.vals || r.val)) || [];
      return (Array.isArray(arr) ? arr : []).map(String);
    } catch (e) { return []; }
  };
  LN_STORE.delSetting = (key) => LN_STORE.del('settings', String(key)).catch(() => ({ ok: false }));
  LN_STORE.delMetaExact = (site, novelId) => {
    const k = (site ? (String(site) + '|') : '') + String(novelId);
    /* v4.9.203:这条(面板「🗄 其他存储」里删某本书的记录)也记一笔账,免得被搬迁又搬回来 */
    try { delLedgerAdd('meta', [k]); } catch (e) {}
    return call('delExact', { store: 'meta', key: k }).catch(() => ({ ok: false }));
  };
  LN_STORE.prefetchClear = () => { try { pfMemo.clear(); } catch (e) {} return pfMemo.size; };

  /* ------------------------- v4.9.174-扩展移植:OCR 走扩展侧常驻引擎 -------------------------
     背景:引擎(onnxruntime 会话)原来建在网页标签页内存里,刷新即丢 ⇒ 每次开页都要重建
     ("加载中…"),模型/ORT 还得从统一库过通道搬进页面。现在把识别交给 offscreen 里常驻的
     引擎(ocr-host.js):它不随网页刷新消失、所有站点共用,模型字节在它自己库里本地直读。
     请求只有两样:模型 id + 页面已切好的 png dataURL(字符串,不走 pack —— PNG base64 压不动);
     响应 {text, paras} 与脚本里 paddleOcrOne 的出参**同结构** ⇒ 调用方一行都不用改。
     任何失败都抛错,页面侧是静默 try/catch 退回本页引擎 ⇒ 不会更差。 */
  let _ocrHostLogged = false;
  async function ocrHostRun(mid, dataUrl, meta) {
    const r = await call('ocrHostRun', { mid: mid, img: dataUrl, meta: meta || null });
    if (!r || r.val == null) throw new Error((r && r.error) || '扩展侧 OCR 无结果');
    /* 第一次真的走通时给一句(默认级别,控制台可见)—— 它证明"引擎已经在扩展侧常驻" */
    if (!_ocrHostLogged) {
      _ocrHostLogged = true;
      try { console.info('[ln-port] OCR 识别已走扩展侧常驻引擎(' + mid + '):不随页面刷新重建,也不再搬模型'); } catch (e) {}
    }
    return r.val;
  }
  let _hostEnvLogged = false;
  async function ocrHostStatus() {
    try {
      const r = await call('ocrHostStatus', {});
      const v = (r && r.val) || null;
      /* 第一次问就把结果说一句(默认级别可见)—— 这一行就能分清"扩展侧到底起没起来" */
      if (!_hostEnvLogged) {
        _hostEnvLogged = true;
        try {
          console.info('[ln-port] 扩展侧 OCR 引擎:host=' + !!(v && v.host)
            + ' 已常驻=[' + (((v && v.engines) || []).join(',')) + ']'
            + ' 库里有模型=[' + (((v && v.cached) || []).join(',')) + ']');
        } catch (e) {}
      }
      return v;
    } catch (e) { return null; }
  }
  /* 让扩展侧**现在**就把这个模型的会话建起来(建成功 = 它真的能用)。失败会抛,由调用方决定是否走本页引擎。
     先"确保统一库里真有这个模型":扩展侧引擎读不到模型时**没法自己向页面要**,而大件写进统一库
     只在**下载那一刻**发生 ⇒ "统一库那份被删过、本地那份还在"(实测:`库里有模型=[]` + 删完缓存秒加载不下载)
     就会一直是死结。这里用本页那份补一次(只补缺的),补完再建引擎。 */
  async function ocrHostWarm(mid, detRatio) {
    try {
      const st = await call('ocrHostStatus', {});
      const cached = (((st && st.val && st.val.cached) || [])).map(String);
      if (cached.indexOf(String(mid)) < 0) {
        const lv = await lGetBig('paddle_model_' + mid);
        if (lv != null) {
          try { console.info('[ln-port] 统一库里没有模型 ' + mid + ':用本页本地那份补进去(补完扩展侧就能常驻)'); } catch (e) {}
          try { await uniPush('settings', 'paddle_model_' + mid, lv); }
          catch (e) { try { console.warn('[ln-port] 模型补进统一库失败(本页引擎照常可用): ' + ((e && e.message) || e)); } catch (e2) {} }
        }
      }
    } catch (e) {}
    const r = await call('ocrHostWarm', { mid: mid, meta: { id: mid, detRatio: detRatio || 2 } });
    if (!r || !r.val) throw new Error((r && r.error) || '扩展侧引擎建不起来');
    return r.val;
  }
  LN_STORE.ocrHostRun = ocrHostRun;
  LN_STORE.ocrHostStatus = ocrHostStatus;
  LN_STORE.ocrHostWarm = ocrHostWarm;

  /* 给脚本用:阅读进度 / 在线阅读记录的键要用"站点模块"(不是域名),这样 .one / .cc 共享同一份进度。
     脚本里那 4 处已被构建补丁换成 globalThis.__LN_SITE_KEY || location.hostname —— 没装新 ln-main.js
     也不会坏(退回按域名,和以前一样)。 */
  try { globalThis.__LN_SITE_KEY = siteKey(); } catch (e) {}

  /* 老进度记录("域名|…"键)顺手改名成"站点模块|…":不然后面脚本按模块键去找,老进度会变成孤儿(看着像被重置)。
     只在域名与模块不同时动(例如 www.esjzone.one → esjzone);narou 那种域名即模块的原样不动。 */
  try {
    const _host = location.hostname, _mod = siteKey();
    if (_host !== _mod && typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
      const PROG_GM_KEY = 'esj_reader_progress_v1';
      const all = GM_getValue(PROG_GM_KEY, null);
      if (all && typeof all === 'object') {
        let changed = false;
        for (const k of Object.keys(all)) {
          if (k.indexOf(_host + '|') !== 0) continue;
          const nk = _mod + '|' + k.slice(_host.length + 1);
          if (!(nk in all)) all[nk] = all[k];
          delete all[k];
          changed = true;
        }
        if (changed) GM_setValue(PROG_GM_KEY, all);
      }
    }
  } catch (e) {}

  /* ------------------------- 占用显示:原脚本读的是本站点用量,这里改成统一库用量 ------------------------- */
  try {
    const sm = navigator.storage;
    const orig = sm && sm.estimate ? sm.estimate.bind(sm) : null;
    if (orig) {
      sm.estimate = async () => {
        try {
          const r = await call('estimate');
          if (r && r.usage != null) return { usage: r.usage, quota: r.quota };
        } catch (e) {}
        return await orig();
      };
    }
  } catch (e) {}

  /* ------------------------- 预热:offscreen 文档 + 统一库连接 -------------------------
     "刷新页面后第一次打开缓存管理,要等一会儿"里有一部分是这座桥刚从零建起来(offscreen 文档
     要加载 fflate/codec/db 三个脚本、再打开 IDB 连接)。页面空闲时先 ping 一次,把这笔挪到
     用户点之前 —— 页面首屏不受影响,失败也无所谓(真正要用的时候会再建)。
     注:浏览器已经把 offscreen 文档和 SW 拉起来了的话,这一下就是一次空转。 */
  try {
    const _warm = () => { try { Promise.resolve(LN_STORE.ping()).catch(() => {}); } catch (e) {} };
    setTimeout(() => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(_warm, { timeout: 4000 });
      else _warm();
    }, 1200);
  } catch (e) {}

  /* ------------------------- P3-1 老库全局迁移自动触发(计划书 P3,可选) -------------------------
     原触发点在"站点面板打开"(collect);这里把触发提前到**内容脚本注入** —— 访问站点任意页即自动
     把该站油猴老库搬进统一库并清空,没开过面板的站点老库不再干占空间。
     · 幂等:migrateLegacy 内部"已搬过/已清空"标记跳过;无老库不打标记;有失败不打标记(下次访问自动重试);
     · 并发安全:与面板手动触发共用 LN_STORE.migrate() 的并发去重;
     · 非阻塞:延迟 2.5s + fire-and-forget,不影响页面首屏与阅读器初始化;
     · 无新基础设施:不引入 SW 开隐藏 tab 机制,访问到哪个站就迁哪个站,效果等价"安装后全局迁移"。 */
  try {
    setTimeout(() => {
      try { Promise.resolve(LN_STORE.migrate()).catch(() => {}); } catch (e) {}
    }, 2500);
  } catch (e) {}
})();
