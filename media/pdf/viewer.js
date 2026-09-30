/**
 * AI 学习助手 PDF 阅读器 viewer（原生 ES module，无构建步骤）。
 *
 * 职责：用 PDF.js 渲染 PDF 页面与文本层；监听浏览器选择事件，在文本层选区上方
 * 显示浮动工具栏 [翻译] [解释] [复制]；页码/缩放/错误占位；与扩展侧通过
 * postMessage 通信（协议见 src/pdf/pdfEditor.ts 的注释与本文底部消息说明）。
 */
import * as pdfjsLib from './pdf.min.mjs';

const vscode = acquireVsCodeApi();

/* ---------------- pdf.js 运行时配置（相对本模块的 asWebviewUri 解析） ---------------- */
const MODULE_BASE = new URL('.', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', MODULE_BASE).href;
const C_MAP_URL = new URL('cmaps/', MODULE_BASE).href;

/* ---------------- 状态 ---------------- */
const state = {
  /** @type {import('./pdf.min.mjs').PDFDocumentProxy | null} */
  doc: null,
  numPages: 0,
  currentPage: 1,
  /** 相对「适配宽度」的缩放倍率 */
  zoom: 1,
  /** .page-wrap 元素数组（index = 页码 - 1） */
  pageWraps: [],
  /** 最近一次 pdf:open 参数（「重新加载」按钮使用） */
  openConfig: null,
  /** 加载/渲染令牌：自增即作废进行中的任务 */
  loadToken: 0,
  renderToken: 0,
  selectionPage: 0,
  selectionText: '',
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const pagesEl = $('pages');
const containerEl = $('pdf-container');
const pageInput = $('page-input');
const pageTotalEl = $('page-total');
const filenameEl = $('filename');
const loadingEl = $('loading');
const errorEl = $('error-placeholder');
const errorMsgEl = $('error-message');
const floatToolbar = $('floating-toolbar');

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/* ---------------- 加载 PDF ---------------- */

async function openPdf(config) {
  state.openConfig = config;
  const token = ++state.loadToken;
  if (state.doc) {
    try {
      state.doc.destroy();
    } catch {
      /* 忽略 */
    }
    state.doc = null;
  }
  state.pageWraps = [];
  pagesEl.textContent = '';
  hideError();
  hideFloatToolbar();
  loadingEl.hidden = false;
  document.title = config.fileName || 'PDF 阅读器';
  filenameEl.textContent = config.fileName || '';
  filenameEl.title = config.fileName || '';

  try {
    const resp = await fetch(config.src);
    if (!resp.ok) {
      throw new Error(`读取文件失败（HTTP ${resp.status}）`);
    }
    if (token !== state.loadToken) {
      return;
    }
    const data = await resp.arrayBuffer();
    const doc = await pdfjsLib.getDocument({
      data,
      cMapUrl: C_MAP_URL,
      cMapPacked: true,
    }).promise;
    if (token !== state.loadToken) {
      void doc.destroy();
      return;
    }
    state.doc = doc;
    state.numPages = doc.numPages;
    pageTotalEl.textContent = `/ ${doc.numPages}`;
    const target = clamp(Math.floor(config.initialPage || 1), 1, doc.numPages);
    state.currentPage = target;
    pageInput.value = String(target);
    await renderAllPages(doc, target);
    if (token !== state.loadToken) {
      return;
    }
    vscode.postMessage({ type: 'pdf:loaded', pages: doc.numPages });
  } catch (err) {
    if (token !== state.loadToken) {
      return;
    }
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    if (token === state.loadToken) {
      loadingEl.hidden = true;
    }
  }
}

/* ---------------- 渲染 ---------------- */

async function renderAllPages(doc, targetPage) {
  const token = ++state.renderToken;
  const wraps = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = String(i);
    wrap.innerHTML =
      '<canvas></canvas>' +
      '<div class="textLayer"></div>' +
      '<div class="scanned-notice" hidden>' +
      '<span>此页没有文本层，无法划词。</span>' +
      '<button type="button" class="manual-note-btn">手动添加笔记</button>' +
      '</div>';
    pagesEl.appendChild(wrap);
    wraps.push(wrap);
  }
  state.pageWraps = wraps;

  // 按顺序渲染（每页让出主线程）；全部就绪后再滚到目标页（此时页面已有实际高度）
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    if (token !== state.renderToken) {
      return;
    }
    try {
      const page = await doc.getPage(pageNum);
      if (token !== state.renderToken) {
        return;
      }
      await renderPage(page, wraps[pageNum - 1], token);
    } catch (err) {
      if (token !== state.renderToken) {
        return; // 已被新的加载/缩放取代
      }
      throw err;
    }
    // 让出主线程，保持滚动与选择响应
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (token === state.renderToken) {
    scrollToPage(targetPage);
  }
}

async function renderPage(page, wrap, token) {
  const canvas = wrap.querySelector('canvas');
  const textLayerDiv = wrap.querySelector('.textLayer');
  const baseViewport = page.getViewport({ scale: 1 });
  // 「百分比」分页：页宽 = 容器宽度的百分比（.page-wrap width: 92%），据此计算缩放
  const cssWidth = Math.max(1, wrap.clientWidth);
  const scale = (cssWidth / baseViewport.width) * state.zoom;
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const ctx = canvas.getContext('2d');
  await page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
  }).promise;
  if (token !== state.renderToken) {
    return;
  }
  await renderTextLayer(page, textLayerDiv, viewport, scale, token, wrap);
}

async function renderTextLayer(page, textLayerDiv, viewport, scale, token, wrap) {
  const textContent = await page.getTextContent();
  if (token !== state.renderToken) {
    return;
  }
  const text = textContent.items
    .map((item) => (typeof item.str === 'string' ? item.str : ''))
    .join('');
  const scanned = text.trim() === '';
  wrap.dataset.scanned = String(scanned);
  textLayerDiv.textContent = '';
  const notice = wrap.querySelector('.scanned-notice');
  if (scanned) {
    // 扫描页：隐藏文本层，显示「无文本层」提示条与「手动添加笔记」（Task 6 接线）
    textLayerDiv.hidden = true;
    notice.hidden = false;
    return;
  }
  textLayerDiv.hidden = false;
  // pdf.js 依赖该变量把文本层尺寸换算为 CSS 像素（setLayerDimensions）
  textLayerDiv.style.setProperty('--scale-factor', String(scale));
  await new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
  }).render();
}

/* ---------------- 导航 / 缩放 ---------------- */

function scrollToPage(pageNum) {
  const wrap = state.pageWraps[pageNum - 1];
  if (wrap) {
    wrap.scrollIntoView({ block: 'start' });
  }
}

function goToPage(pageNum) {
  const p = clamp(Math.floor(pageNum), 1, state.numPages || 1);
  state.currentPage = p;
  pageInput.value = String(p);
  scrollToPage(p);
  vscode.postMessage({ type: 'page-change', page: p });
}

function setZoom(zoom) {
  if (!state.doc) {
    return;
  }
  const next = clamp(zoom, 0.2, 5);
  if (next === state.zoom) {
    return;
  }
  state.zoom = next;
  void renderAllPages(state.doc, state.currentPage);
}

function mostVisiblePage() {
  const cRect = containerEl.getBoundingClientRect();
  let best = state.currentPage || 1;
  let bestArea = -1;
  for (const wrap of state.pageWraps) {
    const r = wrap.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.bottom, cRect.bottom) - Math.max(r.top, cRect.top));
    const h = Math.max(0, Math.min(r.right, cRect.right) - Math.max(r.left, cRect.left));
    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      best = Number(wrap.dataset.page) || best;
    }
  }
  return best;
}

let scrollTimer = 0;
containerEl.addEventListener('scroll', () => {
  // 滚动时跟随选区重新定位浮动工具栏
  if (!floatToolbar.hidden) {
    const rect = currentSelectionRect();
    if (rect) {
      positionFloatToolbar(rect);
    } else {
      hideFloatToolbar();
    }
  }
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!state.doc) {
      return;
    }
    const p = mostVisiblePage();
    if (p !== state.currentPage) {
      state.currentPage = p;
      pageInput.value = String(p);
      vscode.postMessage({ type: 'page-change', page: p });
    }
  }, 160);
});

$('btn-prev').addEventListener('click', () => goToPage(state.currentPage - 1));
$('btn-next').addEventListener('click', () => goToPage(state.currentPage + 1));
pageInput.addEventListener('change', () => {
  const v = Number.parseInt(pageInput.value, 10);
  if (Number.isInteger(v)) {
    goToPage(v);
  } else {
    pageInput.value = String(state.currentPage);
  }
});
$('btn-zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('btn-zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('btn-fit').addEventListener('click', () => setZoom(1));

// 适配宽度模式下窗口尺寸变化时重新布局（含 webview 从隐藏恢复可见）
let resizeTimer = 0;
window.addEventListener('resize', () => {
  if (!state.doc) {
    return;
  }
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.zoom === 1) {
      void renderAllPages(state.doc, state.currentPage);
    }
  }, 200);
});

/* ---------------- 选区与浮动工具栏 ---------------- */

function currentSelectionRect() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return null;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return rect && (rect.width > 0 || rect.height > 0) ? rect : null;
}

/* 向扩展侧上报选区（去重；text 为 '' 表示清空） */
const lastPostedSelection = { page: 0, text: null };
function postSelection(page, text) {
  if (lastPostedSelection.page === page && lastPostedSelection.text === text) {
    return;
  }
  lastPostedSelection.page = page;
  lastPostedSelection.text = text;
  vscode.postMessage({ type: 'pdf-selection', page, text });
}

document.addEventListener('selectionchange', onSelectionChange);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
    }
    hideFloatToolbar();
  }
});

function onSelectionChange() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideFloatToolbar();
    return;
  }
  const text = sel.toString();
  if (text.trim() === '') {
    hideFloatToolbar();
    return;
  }
  // 选区必须落在本页文本层内（忽略画布区/工具栏等处的选择）
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const textLayer = el && el.closest ? el.closest('.textLayer') : null;
  if (!textLayer) {
    hideFloatToolbar();
    return;
  }
  const wrap = textLayer.closest('.page-wrap');
  if (!wrap || wrap.dataset.scanned === 'true') {
    hideFloatToolbar();
    return;
  }
  state.selectionText = text;
  state.selectionPage = Number(wrap.dataset.page) || state.currentPage;
  postSelection(state.selectionPage, text);
  const rect = currentSelectionRect();
  if (rect) {
    showFloatToolbar(rect);
  }
}

function showFloatToolbar(rect) {
  floatToolbar.hidden = false;
  positionFloatToolbar(rect);
}

/** 定位到选区上方；视口放不下时翻转到下方，并做左右/底部夹取 */
function positionFloatToolbar(rect) {
  const tw = floatToolbar.offsetWidth || 120;
  const th = floatToolbar.offsetHeight || 32;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.min(Math.max(8, left), Math.max(8, vw - tw - 8));
  let top = rect.top - th - 8;
  if (top < 8) {
    top = rect.bottom + 8; // 上方放不下 → 翻到选区下方
  }
  top = Math.min(top, Math.max(8, vh - th - 8)); // 底部夹取
  floatToolbar.style.left = `${left}px`;
  floatToolbar.style.top = `${top}px`;
}

function hideFloatToolbar() {
  floatToolbar.hidden = true;
  // 选区被清空时通知扩展侧（供 onPdfSelection 事件总线消费）
  if (lastPostedSelection.text) {
    postSelection(lastPostedSelection.page, '');
  }
}

// 防止点击按钮时浏览器把选区清空（mousedown 默认会建新选区）
floatToolbar.addEventListener('mousedown', (e) => e.preventDefault());
floatToolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) {
    return;
  }
  const action = btn.dataset.action;
  const text = state.selectionText || (window.getSelection() ? window.getSelection().toString() : '');
  const page = state.selectionPage || state.currentPage;
  // 真实动作由 Task 5 在扩展侧接线；本任务只发出消息
  vscode.postMessage({ type: 'toolbar-action', action, text, page });
});

// 扫描页「手动添加笔记」占位（Task 6 接线）
pagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.manual-note-btn');
  if (!btn) {
    return;
  }
  const wrap = btn.closest('.page-wrap');
  vscode.postMessage({
    type: 'toolbar-action',
    action: 'note',
    text: '',
    page: Number(wrap ? wrap.dataset.page : state.currentPage) || state.currentPage,
  });
});

/* ---------------- 错误占位 ---------------- */

function showError(message) {
  errorMsgEl.textContent = message;
  errorEl.hidden = false;
}

function hideError() {
  errorEl.hidden = true;
  errorMsgEl.textContent = '';
}

$('btn-reload').addEventListener('click', () => {
  if (state.openConfig) {
    void openPdf(state.openConfig);
  }
});

/* ---------------- 与扩展侧通信 ---------------- */

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') {
    return;
  }
  if (msg.type === 'pdf:open') {
    void openPdf(msg);
  }
});

// 注册好监听后通知扩展侧下发 pdf:open（扩展侧另有 1.5s 兜底补发）
vscode.postMessage({ type: 'ready' });