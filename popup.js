'use strict';
/* popup.js —— 扩展菜单(工具栏图标)的界面逻辑
   三件事:① 缓存管理 ② 设置 ③ 版本信息。
   前两件都是"在当前标签页里打开脚本自带的对话框":本页若已有内容脚本就直接喊它,
   没有就请 SW 按需注入(和站点页同一份注入集)—— 所以**任意网站**都能开。
   版本信息不注入任何脚本:只问 SW 扩展版本 + 统一库规模(数量走 offscreen)。 */
const $ = (s) => document.querySelector(s);
let busy = false;

function setMsg(t, cls) {
  const el = $('#msg');
  el.textContent = t || '';
  el.className = cls || '';
}
function fmtBytes(n) {
  if (n == null || !isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}
async function currentTab() {
  try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t || null; }
  catch (e) { return null; }
}
async function openUi(target, btn) {
  if (busy) return;
  busy = true;
  setMsg('正在打开…');
  const tab = await currentTab();
  if (!tab || tab.id == null) { setMsg('拿不到当前标签页', 'bad'); busy = false; return; }
  btn.disabled = true;
  let r = null;
  try {
    r = await chrome.runtime.sendMessage({ type: 'lnUiOpen', target: target, tabId: tab.id });
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  btn.disabled = false;
  busy = false;
  if (r && r.ok) {
    setMsg(target === 'settings' ? '已在当前页打开「设置」' : '已在当前页打开「缓存管理」', 'ok');
    setTimeout(() => { try { window.close(); } catch (e) {} }, 600);
  } else {
    setMsg((r && r.error) || '打开失败(没有回应)', 'bad');
  }
}
async function showVersion() {
  const box = $('#verbox');
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = '读取中…';
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type: 'lnVersionInfo' }); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (!r || !r.ok) { box.textContent = '读取失败:' + ((r && r.error) || '没有回应'); return; }
  const c = r.counts || {};
  const rows = [
    ['扩展', r.name || '轻小说助手'],
    ['版本', 'v' + (r.version || '—')],
    ['统一库 · 书', c.books == null ? '读取失败' : (c.books + ' 本')],
    ['统一库 · 章节', c.chapters == null ? '读取失败' : (c.chapters + ' 章')],
    ['统一库 · 图片', c.images == null ? '读取失败' : (c.images + ' 张')],
    ['已用空间', r.usage == null ? '—' : (fmtBytes(r.usage) + (r.quota ? ' / ' + fmtBytes(r.quota) : ''))],
  ];
  box.textContent = '';
  for (const row of rows) {
    const d = document.createElement('div');
    const em = document.createElement('em');
    em.textContent = row[0];
    const sp = document.createElement('span');
    sp.textContent = row[1];
    d.appendChild(em);
    d.appendChild(sp);
    box.appendChild(d);
  }
}
document.addEventListener('DOMContentLoaded', () => {
  try { $('#ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
  $('#btn-cache').addEventListener('click', (e) => openUi('cache', e.currentTarget));
  $('#btn-settings').addEventListener('click', (e) => openUi('settings', e.currentTarget));
  $('#btn-version').addEventListener('click', showVersion);
});
