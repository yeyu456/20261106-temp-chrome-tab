/**
 * 收纳箱的本地数据层。
 * 只有 background（service worker）会写 storage；侧边栏只读，靠 storage.onChanged 刷新。
 */

export const SCHEMA_VERSION = 1;
export const MAX_ITEMS = 5000;
export const STORAGE_KEY = 'shelfState';
export const UNDO_KEY = 'lastUndo';

export const DEFAULT_SETTINGS = Object.freeze({
  skipPinned: false,
  skipAudible: false,
});

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyState() {
  return { v: SCHEMA_VERSION, batches: [], settings: { ...DEFAULT_SETTINGS } };
}

function normalizeItem(raw) {
  const url = typeof raw.url === 'string' ? raw.url : '';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : url;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('t'),
    url,
    title,
    favIconUrl: typeof raw.favIconUrl === 'string' ? raw.favIconUrl : '',
    pinned: !!raw.pinned,
    audible: !!raw.audible,
    idx: Number.isFinite(raw.idx) ? raw.idx : 0,
  };
}

export function normalizeState(raw) {
  const state = createEmptyState();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.batches)) return state;

  state.settings = { ...DEFAULT_SETTINGS, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) };
  state.batches = raw.batches
    .filter((batch) => batch && Array.isArray(batch.items))
    .map((batch) => ({
      id: typeof batch.id === 'string' && batch.id ? batch.id : newId('b'),
      createdAt: Number.isFinite(batch.createdAt) ? batch.createdAt : Date.now(),
      items: batch.items.filter((item) => item && typeof item.url === 'string' && item.url).map(normalizeItem),
    }))
    .filter((batch) => batch.items.length > 0)
    .sort((a, b) => b.createdAt - a.createdAt);

  return state;
}

export function totalItems(state) {
  return state.batches.reduce((sum, batch) => sum + batch.items.length, 0);
}

/** 超过上限时，从最旧的一批末尾开始丢弃，保证写入不会无限膨胀。 */
export function pruneState(state) {
  let total = totalItems(state);
  while (total > MAX_ITEMS && state.batches.length > 0) {
    const oldest = state.batches[state.batches.length - 1];
    const overflow = total - MAX_ITEMS;
    if (oldest.items.length > overflow) {
      oldest.items.splice(oldest.items.length - overflow, overflow);
      total = MAX_ITEMS;
    } else {
      total -= oldest.items.length;
      state.batches.pop();
    }
  }
}

export async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(stored[STORAGE_KEY]);
}

export async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

/* ---------------- 撤销 ---------------- */

export async function loadUndo() {
  const stored = await chrome.storage.session.get(UNDO_KEY);
  return stored[UNDO_KEY] || null;
}

export async function saveUndo(undo) {
  await chrome.storage.session.set({ [UNDO_KEY]: undo });
}

export async function clearUndo() {
  await chrome.storage.session.remove(UNDO_KEY);
}
