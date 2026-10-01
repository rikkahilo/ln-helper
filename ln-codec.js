/* ============================================================================
   ln-codec.js —— 消息通道的二进制编解码(内容脚本 与 offscreen 共用一个文件)
   ----------------------------------------------------------------------------
   Chrome 的扩展消息是 **JSON 序列化**:Blob / ArrayBuffer / TypedArray 传不过去。
   统一库里有两种二进制:插图(Blob)和模型字节(ArrayBuffer)。
   这里把二进制换成 base64 再传,回来时还原成原来的类型(Blob 仍是 Blob,别处直接用)。
   ========================================================================== */
(() => {
  const CH = 0x8000;
  const b64From = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  };
  const bytesFrom = (b64) => {
    const bin = atob(b64 || '');
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };
  const isPlain = (v) => {
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  };
  async function enc(v, depth) {
    depth = depth || 0;
    if (v === null || typeof v !== 'object' || depth > 6) return v;
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      return { __lnb: b64From(new Uint8Array(await v.arrayBuffer())), __lnt: 'blob', __lnm: v.type || '' };
    }
    if (v instanceof ArrayBuffer) return { __lnb: b64From(new Uint8Array(v)), __lnt: 'ab' };
    if (ArrayBuffer.isView(v)) {
      return { __lnb: b64From(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), __lnt: 'u8' };
    }
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) out.push(await enc(x, depth + 1));
      return out;
    }
    if (isPlain(v)) {
      const out = {};
      for (const k of Object.keys(v)) out[k] = await enc(v[k], depth + 1);
      return out;
    }
    return v;
  }
  function dec(v, depth) {
    depth = depth || 0;
    if (v === null || typeof v !== 'object' || depth > 6) return v;
    if (typeof v.__lnb === 'string') {
      const u8 = bytesFrom(v.__lnb);
      if (v.__lnt === 'ab') return u8.buffer;
      if (v.__lnt === 'blob') return new Blob([u8], { type: v.__lnm || '' });
      return u8;
    }
    /* v4.9.178:已经是真二进制就**原样返回**。统一库里存的记录本来就是"解好码"的
       (落库前已经 dec 过一次),再 dec 一遍会把 Uint8Array / Blob 当成普通对象拆成
       {0:..,1:..} 那种百万键对象 ⇒ 上层看到的是「值类型 Object」,字典/模型一个都读不出来
       (实测:模型已经在统一库里,却报「字典文件读不出来(值类型 Object)」)。
       加上这三行,dec 就是**幂等**的:编码壳照旧解,真二进制不动。 */
    if (ArrayBuffer.isView(v)) return v;
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return v;
    if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
    if (Array.isArray(v)) return v.map((x) => dec(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) out[k] = dec(v[k], depth + 1);
    return out;
  }
  /* ---- 通道压缩:字节量 = 延迟 ------------------------------------------------
     扩展消息通道是 JSON 序列化,一个字节一个字符地搬。整本书的章节正文(几 MB)、
     嵌入字模(24 MB)过通道前先 deflate 一下 —— 中文正文的 JSON 一般能压到 1/4,
     base64 再涨 1/3,净省三倍上下。fflate 是脚本里本来就带的(lib/fflate.js):
     内容脚本侧和 offscreen 侧都能用同一个全局。
     编码成"以 \u0001 开头的字符串":JSON 序列化的正常载荷不可能以 \u0001 开头
     (必定是 { [ " 或字面量),所以这个标记天然无歧义,新旧版本混跑也不会误解;
     不认识这个标记的一端 unpack 直接原样返回,不会坏。
     载荷小于阈值就不压(压了反而更慢)。 */
  const PACK_MIN = 64 * 1024;
  const TAG = String.fromCharCode(1);
  function pack(v) {
    try {
      if (v == null || typeof v !== 'object') return v;      // 标量/字符串原样走
      const s = JSON.stringify(v);
      if (!s || s.length < PACK_MIN) return v;
      const ff = globalThis.fflate;
      if (!ff || !ff.deflateSync || !ff.strToU8) return v;
      return TAG + b64From(ff.deflateSync(ff.strToU8(s), { level: 6 }));
    } catch (e) { return v; }
  }
  function unpack(v) {
    if (typeof v !== 'string' || v.charCodeAt(0) !== 1) return v;
    const ff = globalThis.fflate;
    if (!ff || !ff.inflateSync || !ff.strFromU8) throw new Error('缺少 fflate,无法解开压缩载荷');
    return JSON.parse(ff.strFromU8(ff.inflateSync(bytesFrom(v.slice(1)))));
  }
  globalThis.LN_CODEC = { enc, dec, pack, unpack, b64From, bytesFrom };
})();
