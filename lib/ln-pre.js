/* ============================================================================
   ln-pre.js —— 必须排在 lib/ort.wasm.min.js **之前**执行(manifest 里 js 数组第一位)
   ----------------------------------------------------------------------------
   onnxruntime-web 在模块初始化那一刻就算「自己的脚本 URL」:
       Bn = () => typeof document < 'u' ? document.currentScript?.src : self.location?.href
   这个 URL 它要用来:① 起 proxy worker(把**同一个文件**当 worker 跑,靠 self.name 分辨)
   ② 找不到 wasmPaths 时兜底找 .mjs / .wasm。

   **内容脚本里 document.currentScript 恒为 null**(它不是页面里的 <script>)⇒ R = undefined ⇒
     · proxy 模式直接抛:Failed to load proxy worker: cannot determine the script source URL.
     · 更糟:ORT 内部「正在 initWasm」的标志位只在**成功分支**清掉,失败后一直留在 true ⇒
       脚本自带的「降级主线程重试」必然再报 multiple calls to 'initWasm()' detected.
     ⇒ PaddleOCR 彻底起不来(本地 OCR / 图片识别全废)。

   修法:在**隔离世界**里补一个 currentScript 垫片,指向本扩展里那份 ort 脚本
   (manifest 已把它列进 web_accessible_resources,内容脚本 fetch 得到)。
   ORT 于是走它自己的跨源分支:fetch(R) → Blob → new Worker(blob) ⇒ proxy 模式照常可用
   (OCR 推理不阻塞页面主线程,和油猴里表现一致)。

   垫片**只被读一次**:第一个读的人就是 ORT(Bn 只调一次),之后自动失效返回 null,
   所以排在后面的 lib/eSearchOCR.umd.js、gm-shim.js、原脚本看到的仍是 null —— 与不加垫片时一致。
   网页自己的 JS 世界看不到这个改动(内容脚本有独立的 JS wrapper)。
   ========================================================================== */
(() => {
  try {
    const src = chrome.runtime.getURL('lib/ort.wasm.min.js');
    let taken = false;
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      get() {
        if (taken) return null;                 // 只有 ORT 那次拿得到,后面一律如实返回 null
        taken = true;
        return { src, tagName: 'SCRIPT', nodeName: 'SCRIPT' };
      },
    });
  } catch (e) {
    console.warn('[ln-port] currentScript 垫片没装上(ORT proxy 可能起不来):', (e && e.message) || e);
  }
})();
