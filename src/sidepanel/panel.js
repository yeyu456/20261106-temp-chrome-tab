import { loadState, totalItems } from '../lib/store.js';

const $ = (id) => document.getElementById(id);

const els = {
  countPill: $('countPill'),
  settingsBtn: $('settingsBtn'),
  parkBtn: $('parkBtn'),
  parkLabel: $('parkLabel'),
  parkHint: $('parkHint'),
  search: $('search'),
  list: $('list'),
  empty: $('empty'),
  emptyTitle: $('emptyTitle'),
  emptyDesc: $('emptyDesc'),
  footer: $('footer'),
  footerCount: $('footerCount'),
  clearBtn: $('clearBtn'),
  toast: $('toast'),
  toastText: $('toastText'),
  undoBtn: $('undoBtn'),
  settingsDialog: $('settingsDialog'),
  settingsClose: $('settingsClose'),
  skipPinned: $('skipPinned'),
  skipAudible: $('skipAudible'),
  confirmDialog: $('confirmDialog'),
  confirmTitle: $('confirmTitle'),
  confirmDesc: $('confirmDesc'),
  confirmOk: $('confirmOk'),
  confirmCancel: $('confirmCancel'),
};

let state = { batches: [], settings: {} };
let query = '';
let toastTimer = 0;
let parkSeq = 0;
let refreshSeq = 0;
let confirmResolve = null;

/* ---------------- 基础工具 ---------------- */

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, error: '后台没有响应，试试重新打开侧边栏' };
  }
}

async function currentWindowId() {
  try {
    const win = await chrome.windows.getCurrent();
    return win?.id;
  } catch {
    return undefined;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function runtimeFavicon(url) {
  try {
    return chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  } catch {
    return '';
  }
}

function faviconUrl(item) {
  const stored = item.favIconUrl || '';
  if (/^(https?:|data:image\/)/i.test(stored)) return stored;
  return runtimeFavicon(item.url);
}

function tileColor(host) {
  let hash = 0;
  for (let i = 0; i < host.length; i += 1) hash = (hash * 31 + host.charCodeAt(i)) % 360;
  return `hsl(${hash} 46% 46%)`;
}

function formatBatchTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  if (timestamp >= startOfToday) return `今天 ${clock}`;
  if (timestamp >= startOfToday - day) return `昨天 ${clock}`;
  if (timestamp >= startOfToday - 6 * day) return `周${'日一二三四五六'[date.getDay()]} ${clock}`;
  const prefix = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${prefix}${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

function findBatch(batchId) {
  return state.batches.find((batch) => batch.id === batchId) || null;
}

function findItem(batchId, itemId) {
  const batch = findBatch(batchId);
  return batch ? batch.items.find((item) => item.id === itemId) || null : null;
}

/* ---------------- 渲染 ---------------- */

async function refresh() {
  const seq = (refreshSeq += 1);
  const next = await loadState();
  if (seq !== refreshSeq) return;
  state = next;
  syncSettingsUI();
  render();
}

function render() {
  const total = totalItems(state);
  els.countPill.hidden = total === 0;
  els.countPill.textContent = total > 999 ? '999+' : String(total);
  els.footer.hidden = total === 0;
  els.footerCount.textContent = `共 ${total} 个标签页`;
  renderList();
  void updateParkButton();
}

function visibleBatches() {
  const needle = query.trim().toLowerCase();
  const result = [];
  for (const batch of state.batches) {
    const items = needle
      ? batch.items.filter(
          (item) => item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle),
        )
      : batch.items;
    if (items.length > 0) result.push({ batch, items });
  }
  return result;
}

function renderList() {
  const active = document.activeElement;
  let focusKey = null;
  if (active && active.classList && active.classList.contains('item')) {
    focusKey = `${active.dataset.batch}::${active.dataset.item}`;
  }

  els.list.replaceChildren();

  if (totalItems(state) === 0) {
    showEmpty('箱子是空的', '点上面的按钮，把当前窗口里不用的标签页收进来。');
    return;
  }

  const batches = visibleBatches();
  if (batches.length === 0) {
    showEmpty('没有找到', `箱子里没有包含「${query.trim()}」的标签页。`);
    return;
  }

  hideEmpty();
  for (const entry of batches) els.list.append(renderBatch(entry.batch, entry.items));

  if (focusKey) {
    const [batchId, itemId] = focusKey.split('::');
    const el = els.list.querySelector(
      `.item[data-batch="${CSS.escape(batchId)}"][data-item="${CSS.escape(itemId)}"]`,
    );
    if (el) el.focus({ preventScroll: true });
  }
}

function showEmpty(title, desc) {
  els.empty.hidden = false;
  els.list.hidden = true;
  els.emptyTitle.textContent = title;
  els.emptyDesc.textContent = desc;
}

function hideEmpty() {
  els.empty.hidden = true;
  els.list.hidden = false;
}

function renderBatch(batch, items) {
  const section = document.createElement('section');
  section.className = 'batch';
  section.dataset.batch = batch.id;

  const head = document.createElement('div');
  head.className = 'batch-head';

  const time = document.createElement('span');
  time.className = 'batch-time';
  time.textContent = `${formatBatchTime(batch.createdAt)} · ${items.length} 个`;

  const actions = document.createElement('div');
  actions.className = 'batch-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.dataset.act = 'open';
  openBtn.textContent = '全部打开';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.dataset.act = 'delete';
  deleteBtn.textContent = '删除';

  actions.append(openBtn, deleteBtn);
  head.append(time, actions);

  const list = document.createElement('ul');
  list.className = 'items';
  for (const item of items) list.append(renderItem(batch, item));

  section.append(head, list);
  return section;
}

function renderItem(batch, item) {
  const host = hostOf(item.url) || '网页';

  const row = document.createElement('li');
  row.className = 'item';
  row.tabIndex = 0;
  row.dataset.batch = batch.id;
  row.dataset.item = item.id;
  row.setAttribute('role', 'button');
  row.title = `${item.title}\n${item.url}`;

  const favWrap = document.createElement('span');
  favWrap.className = 'fav-wrap';

  const img = document.createElement('img');
  img.className = 'fav';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  const src = faviconUrl(item);
  if (src) img.src = src;

  const tile = document.createElement('span');
  tile.className = 'fav-tile';
  tile.hidden = true;
  tile.textContent = (host[0] || '?').toUpperCase();
  tile.style.background = tileColor(host);

  img.addEventListener('error', () => {
    if (!img.dataset.fallback) {
      img.dataset.fallback = '1';
      const fallback = runtimeFavicon(item.url);
      if (fallback && img.src !== fallback) {
        img.src = fallback;
        return;
      }
    }
    img.hidden = true;
    tile.hidden = false;
  });

  favWrap.append(img, tile);

  const meta = document.createElement('span');
  meta.className = 'meta';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.title;

  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = host;
  if (item.pinned) {
    const pin = document.createElement('span');
    pin.className = 'pin-mark';
    pin.textContent = '· 已固定';
    sub.append(pin);
  }

  meta.append(title, sub);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.textContent = '×';
  del.title = '从箱子中删除';
  del.setAttribute('aria-label', '从箱子中删除');

  row.append(favWrap, meta, del);
  return row;
}

/* ---------------- 收纳按钮 ---------------- */

async function updateParkButton() {
  const seq = (parkSeq += 1);
  let tabs;
  try {
    tabs = await chrome.tabs.query({ currentWindow: true });
  } catch {
    return;
  }
  if (seq !== parkSeq) return;

  const active = tabs.find((tab) => tab.active) || null;
  const settings = state.settings || {};
  let count = 0;

  for (const tab of tabs) {
    if (active && tab.id === active.id) continue;
    if (settings.skipPinned && tab.pinned) continue;
    if (settings.skipAudible && tab.audible) continue;
    count += 1;
  }

  els.parkBtn.disabled = count === 0;
  els.parkLabel.textContent = count > 0 ? `收纳其他 ${count} 个标签页` : '没有可收纳的标签页';
  els.parkHint.textContent = count > 0 ? '只保留当前页，其余收进箱子' : '当前窗口只有这一个标签页';
}

async function onPark() {
  if (els.parkBtn.disabled) return;
  els.parkBtn.disabled = true;

  const result = await send({ type: 'park', windowId: await currentWindowId() });
  if (!result || !result.ok) {
    showToast((result && result.error) || '收纳失败，请重试');
    void updateParkButton();
    return;
  }

  const parts = [];
  if (result.parked > 0) parts.push(`收纳 ${result.parked} 个`);
  if (result.duplicate > 0) parts.push(`${result.duplicate} 个已在箱中`);
  if (result.blank > 0) parts.push(`关闭 ${result.blank} 个空白页`);
  showToast(parts.length > 0 ? parts.join(' · ') : '没有需要收纳的标签页');
  void updateParkButton();
}

/* ---------------- 条目操作 ---------------- */

async function openItem(batchId, itemId, row) {
  if (row && row.classList.contains('is-busy')) return;
  if (row) row.classList.add('is-busy');

  const result = await send({ type: 'restore', batchId, itemId, windowId: await currentWindowId() });
  if (!result || !result.ok) {
    if (row) row.classList.remove('is-busy');
    showToast((result && result.error) || '打开失败');
    return;
  }
  showToast('已打开', true);
}

async function removeItem(batchId, itemId) {
  const result = await send({ type: 'deleteItem', batchId, itemId });
  if (result && result.ok) showToast('已移出箱子', true);
  else showToast((result && result.error) || '删除失败');
}

async function openBatch(batchId) {
  const result = await send({ type: 'openBatch', batchId, windowId: await currentWindowId() });
  if (result && result.ok) showToast(`已打开 ${result.opened} 个标签页`, true);
  else showToast((result && result.error) || '打开失败');
}

async function removeBatch(batchId) {
  const batch = findBatch(batchId);
  const count = batch ? batch.items.length : 0;
  const confirmed = await askConfirm({
    title: '删除这一批？',
    desc: `将从箱子中移除 ${count} 个标签页，这些标签页不会重新打开。此操作可以撤销。`,
    okText: '删除',
  });
  if (!confirmed) return;

  const result = await send({ type: 'deleteBatch', batchId });
  if (result && result.ok) showToast(`已删除 ${count} 个`, true);
  else showToast((result && result.error) || '删除失败');
}

async function clearAll() {
  const total = totalItems(state);
  if (total === 0) return;
  const confirmed = await askConfirm({
    title: '清空收纳箱？',
    desc: `将移除全部 ${total} 个已收纳的标签页，它们不会重新打开。此操作可以撤销。`,
    okText: '清空',
  });
  if (!confirmed) return;

  const result = await send({ type: 'clear' });
  if (result && result.ok) showToast(`已清空 ${result.removed} 个`, true);
  else showToast((result && result.error) || '清空失败');
}

/* ---------------- 列表交互 ---------------- */

function onListClick(event) {
  const deleteBtn = event.target.closest('.del');
  if (deleteBtn) {
    const row = deleteBtn.closest('.item');
    if (row) void removeItem(row.dataset.batch, row.dataset.item);
    return;
  }

  const batchAction = event.target.closest('[data-act]');
  if (batchAction) {
    const batchId = batchAction.closest('.batch').dataset.batch;
    if (batchAction.dataset.act === 'open') void openBatch(batchId);
    if (batchAction.dataset.act === 'delete') void removeBatch(batchId);
    return;
  }

  const row = event.target.closest('.item');
  if (row) void openItem(row.dataset.batch, row.dataset.item, row);
}

function onListKeydown(event) {
  const row = event.target.closest('.item');
  if (!row) return;

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void openItem(row.dataset.batch, row.dataset.item, row);
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const rows = Array.from(els.list.querySelectorAll('.item'));
    const index = rows.indexOf(row);
    const target = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (target) target.focus();
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    void removeItem(row.dataset.batch, row.dataset.item);
  }
}

function onSearchInput() {
  query = els.search.value;
  renderList();
}

function onGlobalKeydown(event) {
  const target = event.target;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

  if (event.key === '/' && !typing) {
    event.preventDefault();
    els.search.focus();
    els.search.select();
    return;
  }

  if (event.key === 'Escape' && document.activeElement === els.search) {
    if (els.search.value) {
      els.search.value = '';
      query = '';
      renderList();
    }
  }
}

/* ---------------- Toast / 撤销 ---------------- */

function showToast(text, undoable = false) {
  els.toastText.textContent = text;
  els.undoBtn.hidden = !undoable;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), undoable ? 9000 : 3200);
}

async function onUndo() {
  const result = await send({ type: 'undo' });
  els.toast.classList.remove('show');
  showToast(result && result.ok ? '已撤销' : (result && result.error) || '没有可撤销的操作');
}

/* ---------------- 弹层 ---------------- */

function askConfirm({ title, desc, okText = '确定' }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    els.confirmTitle.textContent = title;
    els.confirmDesc.textContent = desc;
    els.confirmOk.textContent = okText;
    els.confirmDialog.showModal();
  });
}

function settleConfirm(value) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (els.confirmDialog.open) els.confirmDialog.close();
  if (resolve) resolve(value);
}

function isBackdropClick(dialog, event) {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

/* ---------------- 设置 ---------------- */

function syncSettingsUI() {
  els.skipPinned.checked = !!state.settings.skipPinned;
  els.skipAudible.checked = !!state.settings.skipAudible;
}

async function saveSettings() {
  const settings = { skipPinned: els.skipPinned.checked, skipAudible: els.skipAudible.checked };
  const result = await send({ type: 'setSettings', settings });
  if (!result || !result.ok) showToast('设置保存失败');
}

/* ---------------- 启动 ---------------- */

function bindEvents() {
  els.parkBtn.addEventListener('click', onPark);
  els.search.addEventListener('input', onSearchInput);
  els.list.addEventListener('click', onListClick);
  els.list.addEventListener('keydown', onListKeydown);
  els.clearBtn.addEventListener('click', clearAll);
  els.undoBtn.addEventListener('click', onUndo);
  document.addEventListener('keydown', onGlobalKeydown);

  els.settingsBtn.addEventListener('click', () => {
    syncSettingsUI();
    els.settingsDialog.showModal();
  });
  els.settingsClose.addEventListener('click', () => els.settingsDialog.close());
  els.settingsDialog.addEventListener('click', (event) => {
    if (event.target === els.settingsDialog && isBackdropClick(els.settingsDialog, event)) {
      els.settingsDialog.close();
    }
  });
  els.skipPinned.addEventListener('change', saveSettings);
  els.skipAudible.addEventListener('change', saveSettings);

  els.confirmOk.addEventListener('click', () => settleConfirm(true));
  els.confirmCancel.addEventListener('click', () => settleConfirm(false));
  els.confirmDialog.addEventListener('click', (event) => {
    if (event.target === els.confirmDialog && isBackdropClick(els.confirmDialog, event)) {
      settleConfirm(false);
    }
  });
  els.confirmDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    settleConfirm(false);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.shelfState) void refresh();
  });

  const refreshCount = () => void updateParkButton();
  chrome.tabs.onCreated.addListener(refreshCount);
  chrome.tabs.onRemoved.addListener(refreshCount);
  chrome.tabs.onActivated.addListener(refreshCount);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.pinned !== undefined || changeInfo.audible !== undefined) refreshCount();
  });
  chrome.windows.onFocusChanged.addListener(refreshCount);
}

async function boot() {
  bindEvents();
  await refresh();
  void updateParkButton();
}

void boot();
