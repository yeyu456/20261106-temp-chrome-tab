/**
 * 标签收纳箱 — 后台逻辑
 * - 收纳：把当前窗口除当前页以外的标签页关掉，先落盘 URL / 标题 / favicon / 固定状态
 * - 取回：按原来的位置把标签页放回来，并从箱内移除（可通过 storage.session 撤销）
 * 所有写操作都排队执行，避免侧边栏连点造成读改写竞争。
 */

import {
  clearUndo,
  loadState,
  loadUndo,
  newId,
  pruneState,
  saveState,
  saveUndo,
  totalItems,
} from './lib/store.js';

const BADGE_COLOR = '#1a73e8';
const BLANK_URL_PREFIXES = ['chrome://newtab', 'chrome://welcome', 'chrome://intro'];

function isBlankUrl(url) {
  if (!url) return true;
  if (url === 'about:blank') return true;
  return BLANK_URL_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}#`));
}

/** favicon 可能是一大段 data URI，过长就不存，渲染时用 _favicon 兜底。 */
function pickFavicon(url) {
  if (typeof url !== 'string' || !url) return '';
  if (url.startsWith('data:') && url.length > 2048) return '';
  return url;
}

let queue = Promise.resolve();

function enqueue(task) {
  const next = queue.then(task, task);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function updateBadge() {
  try {
    const state = await loadState();
    const count = totalItems(state);
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
    await chrome.action.setBadgeText({ text: count > 0 ? (count > 999 ? '999+' : String(count)) : '' });
  } catch {
    /* 徽标失败不影响主流程 */
  }
}

/* ---------------- 收纳 ---------------- */

async function parkWindow(windowId) {
  const query = Number.isInteger(windowId) ? { windowId } : { currentWindow: true };
  const tabs = await chrome.tabs.query(query);
  const activeTab = tabs.find((tab) => tab.active) || null;
  const state = await loadState();

  const knownUrls = new Set();
  for (const batch of state.batches) {
    for (const item of batch.items) knownUrls.add(item.url);
  }

  const closeIds = [];
  const items = [];
  let blank = 0;
  let duplicate = 0;
  let kept = 0;

  const others = tabs.filter((tab) => !activeTab || tab.id !== activeTab.id).sort((a, b) => a.index - b.index);

  for (const tab of others) {
    if (tab.id === undefined) continue;
    if (state.settings.skipPinned && tab.pinned) {
      kept += 1;
      continue;
    }
    if (state.settings.skipAudible && tab.audible) {
      kept += 1;
      continue;
    }

    closeIds.push(tab.id);

    if (isBlankUrl(tab.url)) {
      blank += 1;
      continue;
    }
    if (knownUrls.has(tab.url)) {
      duplicate += 1;
      continue;
    }
    knownUrls.add(tab.url);

    items.push({
      id: newId('t'),
      url: tab.url,
      title: (tab.title || '').trim() || tab.url,
      favIconUrl: pickFavicon(tab.favIconUrl),
      pinned: !!tab.pinned,
      audible: !!tab.audible,
      idx: tab.index,
    });
  }

  if (closeIds.length === 0) {
    return { ok: true, parked: 0, closed: 0, blank: 0, duplicate: 0, kept };
  }

  if (items.length > 0) {
    state.batches.unshift({ id: newId('b'), createdAt: Date.now(), items });
    pruneState(state);
    await saveState(state);
    await updateBadge();
  }

  let closed = 0;
  try {
    await chrome.tabs.remove(closeIds);
    closed = closeIds.length;
  } catch {
    const results = await Promise.allSettled(closeIds.map((id) => chrome.tabs.remove(id)));
    closed = results.filter((result) => result.status === 'fulfilled').length;
  }

  return { ok: true, parked: items.length, closed, blank, duplicate, kept };
}

/* ---------------- 取回 ---------------- */

function insertBatchByTime(state, batch) {
  state.batches.push(batch);
  state.batches.sort((a, b) => b.createdAt - a.createdAt);
}

function findBatch(state, batchId) {
  return state.batches.find((batch) => batch.id === batchId) || null;
}

async function createTabForItem(item, index, active, windowId) {
  const options = { url: item.url, active };
  if (Number.isFinite(index)) options.index = index;
  if (item.pinned) options.pinned = true;
  if (Number.isInteger(windowId)) options.windowId = windowId;
  try {
    return await chrome.tabs.create(options);
  } catch {
    const fallback = { url: item.url, active };
    if (Number.isInteger(windowId)) fallback.windowId = windowId;
    return await chrome.tabs.create(fallback);
  }
}

async function restoreItem(batchId, itemId, windowId) {
  const state = await loadState();
  const batch = findBatch(state, batchId);
  if (!batch) return { ok: false, error: '这一批已经不存在了' };

  const position = batch.items.findIndex((item) => item.id === itemId);
  if (position < 0) return { ok: false, error: '这个标签页已经不在箱子里了' };

  const item = batch.items[position];
  const tabs = await chrome.tabs.query(Number.isInteger(windowId) ? { windowId } : { currentWindow: true });
  const index = Math.max(0, Math.min(item.idx ?? tabs.length, tabs.length));

  let tab;
  try {
    tab = await createTabForItem(item, index, true, windowId);
  } catch (error) {
    return { ok: false, error: '打不开这个地址' };
  }

  batch.items.splice(position, 1);
  if (batch.items.length === 0) {
    state.batches = state.batches.filter((entry) => entry.id !== batchId);
  }
  await saveState(state);
  await saveUndo({
    kind: 'restore',
    at: Date.now(),
    batchId,
    batchCreatedAt: batch.createdAt,
    item,
    position,
    openedTabId: tab?.id,
  });
  await updateBadge();
  return { ok: true, tabId: tab?.id };
}

async function openBatch(batchId, windowId) {
  const state = await loadState();
  const batchIndex = state.batches.findIndex((batch) => batch.id === batchId);
  if (batchIndex < 0) return { ok: false, error: '这一批已经不存在了' };

  const batch = state.batches[batchIndex];
  const openedTabIds = [];
  for (const item of batch.items) {
    try {
      const tab = await createTabForItem(item, undefined, false, windowId);
      if (tab?.id !== undefined) openedTabIds.push(tab.id);
    } catch {
      /* 单个失败不影响其余 */
    }
  }

  state.batches.splice(batchIndex, 1);
  await saveState(state);
  await saveUndo({ kind: 'openBatch', at: Date.now(), batch, index: batchIndex, openedTabIds });
  await updateBadge();
  return { ok: true, opened: openedTabIds.length };
}

/* ---------------- 删除 ---------------- */

async function deleteItem(batchId, itemId) {
  const state = await loadState();
  const batch = findBatch(state, batchId);
  if (!batch) return { ok: false, error: '这一批已经不存在了' };

  const position = batch.items.findIndex((item) => item.id === itemId);
  if (position < 0) return { ok: false, error: '这个标签页已经不在箱子里了' };

  const [item] = batch.items.splice(position, 1);
  const batchCreatedAt = batch.createdAt;
  if (batch.items.length === 0) {
    state.batches = state.batches.filter((entry) => entry.id !== batchId);
  }
  await saveState(state);
  await saveUndo({ kind: 'deleteItem', at: Date.now(), batchId, batchCreatedAt, item, position });
  await updateBadge();
  return { ok: true };
}

async function deleteBatch(batchId) {
  const state = await loadState();
  const index = state.batches.findIndex((batch) => batch.id === batchId);
  if (index < 0) return { ok: false, error: '这一批已经不存在了' };

  const [batch] = state.batches.splice(index, 1);
  await saveState(state);
  await saveUndo({ kind: 'deleteBatch', at: Date.now(), batch, index });
  await updateBadge();
  return { ok: true, removed: batch.items.length };
}

async function clearAll() {
  const state = await loadState();
  const batches = state.batches;
  const removed = totalItems(state);
  if (removed === 0) return { ok: true, removed: 0 };

  state.batches = [];
  await saveState(state);
  await saveUndo({ kind: 'clear', at: Date.now(), batches });
  await updateBadge();
  return { ok: true, removed };
}

/* ---------------- 撤销 ---------------- */

async function undoLast() {
  const undo = await loadUndo();
  if (!undo) return { ok: false, error: '没有可撤销的操作' };

  const state = await loadState();

  if (undo.kind === 'restore' || undo.kind === 'deleteItem') {
    if (undo.openedTabId !== undefined) {
      try {
        await chrome.tabs.remove(undo.openedTabId);
      } catch {
        /* 标签页可能已被手动关闭 */
      }
    }
    const batch = findBatch(state, undo.batchId);
    if (batch) {
      const position = Math.max(0, Math.min(undo.position, batch.items.length));
      batch.items.splice(position, 0, undo.item);
    } else {
      insertBatchByTime(state, {
        id: undo.batchId,
        createdAt: undo.batchCreatedAt || Date.now(),
        items: [undo.item],
      });
    }
  } else if (undo.kind === 'openBatch') {
    for (const tabId of undo.openedTabIds || []) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 忽略已关闭的 */
      }
    }
    if (!findBatch(state, undo.batch.id)) {
      insertBatchByTime(state, undo.batch);
    }
  } else if (undo.kind === 'deleteBatch') {
    if (!findBatch(state, undo.batch.id)) insertBatchByTime(state, undo.batch);
  } else if (undo.kind === 'clear') {
    const existing = new Set(state.batches.map((batch) => batch.id));
    for (const batch of undo.batches || []) {
      if (!existing.has(batch.id)) state.batches.push(batch);
    }
    state.batches.sort((a, b) => b.createdAt - a.createdAt);
  } else {
    return { ok: false, error: '未知的撤销类型' };
  }

  await saveState(state);
  await clearUndo();
  await updateBadge();
  return { ok: true };
}

/* ---------------- 设置 ---------------- */

async function setSettings(patch) {
  const state = await loadState();
  const allowed = ['skipPinned', 'skipAudible'];
  for (const key of allowed) {
    if (patch && typeof patch[key] === 'boolean') state.settings[key] = patch[key];
  }
  await saveState(state);
  return { ok: true, settings: state.settings };
}

async function getState() {
  const state = await loadState();
  const undo = await loadUndo();
  return { ok: true, state, total: totalItems(state), canUndo: !!undo };
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message && message.type;
  if (!type) return false;

  const task = enqueue(async () => {
    switch (type) {
      case 'park':
        return parkWindow(message.windowId);
      case 'restore':
        return restoreItem(message.batchId, message.itemId, message.windowId);
      case 'openBatch':
        return openBatch(message.batchId, message.windowId);
      case 'deleteItem':
        return deleteItem(message.batchId, message.itemId);
      case 'deleteBatch':
        return deleteBatch(message.batchId);
      case 'clear':
        return clearAll();
      case 'undo':
        return undoLast();
      case 'setSettings':
        return setSettings(message.settings);
      case 'getState':
        return getState();
      default:
        return { ok: false, error: `未知指令：${type}` };
    }
  });

  task.then(
    (result) => sendResponse(result || { ok: true }),
    (error) => sendResponse({ ok: false, error: String((error && error.message) || error) }),
  );
  return true;
});

/* ---------------- 快捷键 ---------------- */

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'park-other-tabs') return;

  void (async () => {
    // 先开侧边栏（借用这次快捷键的用户手势），再收纳，面板会随 storage 变化实时刷新
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (win && win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
    } catch {
      /* 侧边栏打不开时，徽标仍然会更新 */
    }
    try {
      await enqueue(() => parkWindow());
    } catch {
      /* 收纳失败不影响已打开的面板 */
    }
  })();
});

/* ---------------- 启动 ---------------- */

async function init() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* 老版本忽略 */
  }
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(() => {
  void init();
});

chrome.runtime.onStartup.addListener(() => {
  void init();
});

void init();
