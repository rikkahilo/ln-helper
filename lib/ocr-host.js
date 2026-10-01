/* ============================================================================
   ocr-host.js —— v4.9.174-扩展移植:把 PaddleOCR 的「引擎」搬到扩展侧常驻
   ----------------------------------------------------------------------------
   为什么:引擎(onnxruntime 会话 + 模型权重)原来建在**网页标签页的 JS 上下文**里。
   页面一刷新 / 一关标签,整个上下文销毁 ⇒ 引擎跟着没 ⇒ 每次开页都要"加载中…"重建,
   模型与 onnxruntime 字节还得从统一库**过消息通道**搬进页面。

   现在:引擎建在 **offscreen 文档**里 —— 它不随网页刷新/关闭而消失,而且是**所有站点共用**的
   同一个文档。模型 / ORT 字节就在**这个文档自己的库**里 ⇒ 建引擎时本地直读,一个字节都不过通道。
   页面只发两样:模型 id + 已经切好的 png dataURL;收回 {text, paras}。
   (出参结构与脚本里 paddleOcrOne 完全一致 ⇒ 调用方一行都不用改)

   安全口径:任何一步失败都**抛错**,页面侧 catcher 静默退回"本页引擎"的老路 ⇒ 不会更差。
   引擎常驻内存,页面刷新也不再重建 —— 这正是"引擎只活在页面内存里"的解法。

   依赖(必须在本文件之前加载):lib/fflate.js · lib/ort.wasm.min.js ·
   lib/eSearchOCR.umd.js · ln-codec.js —— 见 offscreen.html。
   ========================================================================== */
(function () {
  'use strict';
  const LNC = globalThis.LN_CODEC;
  const UNI_DB = 'lnlib';
  const engines = {};   // mid -> { engine, detRatio, at }
  const building = {};  // mid -> Promise(正在建的引擎)
  let uniP = null;
  let wasmEnvDone = false;

  function openUni() {
    if (uniP) return uniP;
    uniP = new Promise((resolve, reject) => {
      const rq = indexedDB.open(UNI_DB, 1);
      rq.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'novelId' });
        if (!db.objectStoreNames.contains('chapters')) db.createObjectStore('chapters', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'url' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return uniP;
  }
  async function getSettings(key) {
    const db = await openUni();
    return await new Promise((resolve) => {
      try {
        const rq = db.transaction('settings', 'readonly').objectStore('settings').get(key);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  /* 库里存的是"编码后"的记录(二进制被 ln-codec 换成可 JSON 化的壳)⇒ 这里解回来 */
  async function readDecoded(key) {
    const rec = await getSettings(key);
    if (!rec) return null;
    try { return LNC ? LNC.dec(rec) : rec; } catch (e) { return rec; }
  }
  async function listSettingsKeys() {
    const db = await openUni();
    return await new Promise((resolve) => {
      try {
        const rq = db.transaction('settings', 'readonly').objectStore('settings').getAllKeys();
        rq.onsuccess = () => resolve(rq.result || []);
        rq.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  }
  /* 记录里的二进制有三种落法,必须全收:
     ① offscreen 库里是**真 Blob**(页面侧 `new Blob([u8])` 落库,codec 还原成 Blob)—— 这是最常见的;
     ② codec 万一没还原的 `{__lnb,__lnt,__lnm}` 包;
     ③ base64 字符串 / 纯文本(字典就是 txt,老库里也可能直接是文本)。
     Blob → 字节是异步的(await v.arrayBuffer()),所以这个函数整体是 async,调用点都要 await。
     ⚠ 曾经这里漏掉 ① ⇒「文件齐」判定通过、紧接着转换返回 null ⇒ 抛「字典文件读不出来」,
     页面侧静默退回"在本页建引擎"(功能不受影响,但扩展侧常驻引擎白做了)。 */
  const toU8 = async (v) => {
    if (!v) return null;
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      try { return new Uint8Array(await v.arrayBuffer()); } catch (e) { return null; }
    }
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (typeof v === 'string') {
      const s = v.replace(/^data:[^,]*,/, ''); /* 万一是 dataURL */
      try {
        const bs = atob(s);
        const t = new Uint8Array(bs.length);
        for (let i = 0; i < bs.length; i++) t[i] = bs.charCodeAt(i);
        return t;
      } catch (e) {}
      try { return new TextEncoder().encode(v); } catch (e) { return null; }
    }
    if (typeof v === 'object' && typeof v.__lnb === 'string') return await toU8(v.__lnb);
    /* 兜底:万一拿到的是"被当成普通对象拆开"的字节数组(数值键 0,1,2,… 一路排到末尾),
       就按索引重建。它能自愈历史上"记录被解码两遍"造成的脏读 —— 旧版 offscreen 还活着时
       (只按 F5、没点「↻ 重新加载」)仍会走到这里;字典/模型都不大,重建很快。
       超过 8 MB 就放弃(那种规模的普通对象光遍历就要几百 MB 内存,不冒险)。 */
    if (typeof v === 'object' && !Array.isArray(v)) {
      try {
        const ks = Object.keys(v);
        if (ks.length && ks[0] === '0' && ks[ks.length - 1] === String(ks.length - 1) && ks.length <= 8 * 1024 * 1024) {
          const out = new Uint8Array(ks.length);
          for (let i = 0; i < ks.length; i++) out[i] = (Number(v[i]) || 0) & 255;
          return out;
        }
      } catch (e) {}
    }
    return null;
  };
  /* 角色解析:与脚本里 pickFirst 同口径 —— 先关键字，再扩展名兜底，不依赖候选名表 */
  function pickModelFiles(files) {
    const out = { dict: null, det: null, rec: null };
    if (!files || typeof files !== 'object') return out;
    const keys = Object.keys(files).filter(k => files[k]);
    for (const k of keys) if (/\.(txt|dic)$/i.test(k) && !out.dict) out.dict = files[k];
    for (const k of keys) if (/\.onnx$/i.test(k) && /det/i.test(k) && !out.det) out.det = files[k];
    for (const k of keys) if (/\.onnx$/i.test(k) && /rec/i.test(k) && !out.rec) out.rec = files[k];
    return out;
  }
  /* 引擎只建一次;之后页面刷新、切标签、换站点都复用它 */
  async function ensureEngine(mid, detRatio) {
    if (engines[mid] && engines[mid].engine) return engines[mid].engine;
    if (building[mid]) return await building[mid];
    building[mid] = (async () => {
      const ort = globalThis.ort;
      const ESLib = globalThis.eSearchOCR;
      if (!ort) throw new Error('offscreen 里没有 ort(检查 offscreen.html 的脚本顺序)');
      if (!ESLib) throw new Error('offscreen 里没有 eSearchOCR(检查 offscreen.html 的脚本顺序)');
      /* wasm 运行环境:主线程 + wasmBinary。
         offscreen 没有界面要保(卡它不影响任何页面),所以不需要 proxy worker ⇒ 少一层 CSP 风险。 */
      if (!wasmEnvDone) {
        try {
          const wr = (await readDecoded('ortwasm_v1220')) || (await readDecoded('ortwasm_bin_v1220'));
          const bytes = await toU8(wr && (wr.bytes || wr));
          if (bytes) ort.env.wasm.wasmBinary = bytes;
          /* WASM 胶水(mjs):ORT 初始化时**一定会 import() 它**。页面侧走的是 CDN/blob 化,
             而这里是扩展页 —— CSP 是 script-src 'self'(MV3 不许放宽)⇒ 远程模块、blob 模块
             都会被拦下来 ⇒ 只能用**扩展自己那份**(随包发在 lib/ 下,同源 = 'self' ✓)。
             wasm 二进制优先用上面读到的本地字节;万一本地没有,让 ORT 去 CDN 取(纯 fetch,不受 CSP 管)。 */
          try {
            ort.env.wasm.wasmPaths = {
              mjs: chrome.runtime.getURL('lib/ort-wasm-simd-threaded.mjs'),
              wasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm'
            };
          } catch (e) {}
          ort.env.wasm.proxy = false;
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.simd = true;
          wasmEnvDone = true;
        } catch (e) {}
      }
      const rec = await readDecoded('paddle_model_' + mid);
      if (!rec || !rec.files) throw new Error('扩展侧库里没有模型 ' + mid + '(先在页面「AI 设置」里加载过一次即可)');
      const f = pickModelFiles(rec.files);
      if (!f.dict || !f.det || !f.rec) throw new Error('模型文件不齐(dict/det/rec),库里只有:' + Object.keys(rec.files).join(','));
      const dictU8 = await toU8(f.dict);
      if (!dictU8) throw new Error('字典文件读不出来(值类型 ' + ((f.dict && f.dict.constructor && f.dict.constructor.name) || typeof f.dict) + ')');
      const dictText = new TextDecoder().decode(dictU8);
      const initFn = ESLib.init || ESLib.default || ESLib;
      if (typeof initFn !== 'function') throw new Error('eSearchOCR 没有提供 init');
      const res = await initFn.apply(ESLib, [{
        det: { input: await toU8(f.det), ratio: (detRatio || 2) },
        rec: { input: await toU8(f.rec), decodeDic: dictText, optimize: { space: false } },
        dev: false,
        ort: ort
      }]);
      const engine = (res && typeof res.ocr === 'function') ? res
        : (typeof res === 'function' ? res : ((res && res.default && typeof res.default.ocr === 'function') ? res.default : null));
      if (!engine || typeof engine.ocr !== 'function') throw new Error('init 返回值缺少 ocr 方法');
      engines[mid] = { engine: engine, detRatio: detRatio || 2, at: Date.now() };
      try { console.info('[ln-port] OCR 引擎已在扩展侧常驻(' + mid + '):不再随页面刷新重建,也不再搬模型'); } catch (e) {}
      return engine;
    })();
    try { return await building[mid]; } finally { delete building[mid]; }
  }
  /* png dataURL → ImageData(放大规则与脚本里 paddleOcrOne 一致:高 < 960px 的小条放大 2×) */
  async function decodeImage(dataUrl) {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片解码失败'));
      im.src = dataUrl;
    });
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
    const scale = (ih < 960) ? 2 : 1;
    const cw = Math.max(1, Math.round(iw * scale)), ch = Math.max(1, Math.round(ih * scale));
    const cvs = document.createElement('canvas');
    cvs.width = cw; cvs.height = ch;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    try { ctx.drawImage(img, 0, 0, cw, ch); } catch (e) {}
    return { data: ctx.getImageData(0, 0, cw, ch), scale: scale };
  }
  /* 识别一片:出参与脚本里 paddleOcrOne **逐字同结构** { text, paras:[{text,y0,y1}] } */
  async function run(mid, dataUrl, detRatio) {
    if (!mid) throw new Error('缺少模型 id');
    if (!dataUrl) throw new Error('缺少切片图');
    const engine = await ensureEngine(mid, detRatio);
    const im = await decodeImage(dataUrl);
    const result = await engine.ocr(im.data);
    const paras = result && (result.parragraphs || result.paragraphs);
    if (!Array.isArray(paras) || !paras.length) return { text: '', paras: [] };
    const scale = im.scale;
    /* 按左上角 Y 升序、再 X 升序得阅读顺序(与脚本同口径) */
    const sorted = paras.slice().sort((a, b) => {
      const ay = a.box && a.box[0] ? (a.box[0][1] || 0) : 0;
      const by = b.box && b.box[0] ? (b.box[0][1] || 0) : 0;
      if (Math.abs(ay - by) > 8) return ay - by;
      const ax = a.box && a.box[0] ? (a.box[0][0] || 0) : 0;
      const bx = b.box && b.box[0] ? (b.box[0][0] || 0) : 0;
      return ax - bx;
    });
    /* 检测框按纵向间距聚合成自然段落(段内小行距合并,段间留白切断) */
    const groups = [];
    for (const p of sorted) {
      const t = String(p.text || '').replace(/[ \t]+$/gm, '').trim();
      if (!t) continue;
      let y0 = 0, y1 = 0;
      if (p.box && Array.isArray(p.box)) {
        const ys = p.box.map(pt => (pt && pt[1]) || 0);
        y0 = Math.min.apply(null, ys) / scale;
        y1 = Math.max.apply(null, ys) / scale;
      }
      y1 = Math.max(y0 + 1, y1);
      const last = groups[groups.length - 1];
      const gap = last ? (y0 - last.y1) : 0;
      const lineH = last ? Math.max(1, last.h) : 1;
      if (last && gap < Math.max(14, lineH * 0.8)) {
        last.text += '\n' + t;
        last.y1 = Math.max(last.y1, y1);
        last.h = last.y1 - last.y0;
        last.lines++;
      } else {
        groups.push({ text: t, y0: y0, y1: y1, h: y1 - y0, lines: 1 });
      }
    }
    return {
      text: groups.map(g => g.text).join('\n\n'),
      paras: groups.map(g => ({ text: g.text, y0: g.y0, y1: g.y1 })),
      scale: scale
    };
  }

  globalThis.LN_OCR_HOST = {
    /* 状态:哪些模型在扩展侧已有引擎 / 库里有缓存(面板与页面判断"要不要在本页再建引擎") */
    status: async () => {
      let cached = [];
      try {
        const ks = await listSettingsKeys();
        cached = ks.filter(k => String(k).indexOf('paddle_model_') === 0).map(k => String(k).slice('paddle_model_'.length));
      } catch (e) {}
      return { engines: Object.keys(engines), cached: cached };
    },
    warm: async (mid, detRatio) => { await ensureEngine(mid, detRatio); return { ok: true, mid: mid }; },
    run: async (mid, dataUrl, detRatio) => await run(mid, dataUrl, detRatio),
    drop: (mid) => { try { delete engines[mid]; } catch (e) {} return { ok: true }; }
  };
})();
