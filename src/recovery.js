const STATE_KEY = Symbol.for('abangrender.downloader.recovery.v1');

const DEFAULT_STALE_AFTER_MS = 120_000;
const DEFAULT_SEEN_TTL_MS = 15 * 60_000;
const MAX_SEEN_UPDATES = 5000;

function state() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      globalGeneration: 0,
      globalResetFloor: 0,
      userGenerations: new Map(),
      userResetFloors: new Map(),
      seenUpdates: new Map(),
    };
  }
  return globalThis[STATE_KEY];
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name] || 0);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function updateMessage(update = {}) {
  return update?.message ?? update?.edited_message ?? null;
}

function userKeyFrom(update = {}) {
  const message = updateMessage(update);
  const callback = update?.callback_query;
  const chatId = message?.chat?.id ?? callback?.message?.chat?.id ?? '';
  const userId = message?.from?.id ?? callback?.from?.id ?? '';
  return `${String(chatId)}:${String(userId)}`;
}

function cleanupSeen(now = Date.now()) {
  const s = state();
  const ttl = numericEnv('UPDATE_DEDUPE_TTL_MS', DEFAULT_SEEN_TTL_MS);
  for (const [updateId, seenAt] of s.seenUpdates) {
    if (now - seenAt > ttl) s.seenUpdates.delete(updateId);
  }
  while (s.seenUpdates.size > MAX_SEEN_UPDATES) {
    const first = s.seenUpdates.keys().next().value;
    if (first === undefined) break;
    s.seenUpdates.delete(first);
  }
}

function messageTimestampMs(update = {}) {
  const message = updateMessage(update);
  const seconds = Number(message?.edit_date || message?.date || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function commandName(update = {}) {
  const message = updateMessage(update);
  const text = String(message?.text || message?.caption || '').trim();
  const token = text.split(/\s+/)[0]?.toLowerCase() || '';
  return token.split('@')[0];
}

export function beginUpdate(update = {}) {
  const s = state();
  const now = Date.now();
  cleanupSeen(now);

  const updateId = Number(update?.update_id || 0);
  const key = userKeyFrom(update);
  const command = commandName(update);
  const resetCommand = command === '/reset' || command === '/resetadmin';

  if (Number.isFinite(updateId) && updateId > 0) {
    if (s.globalResetFloor && updateId < s.globalResetFloor) {
      return { accept: false, reason: 'before_global_reset', updateId, key, command };
    }
    const userFloor = Number(s.userResetFloors.get(key) || 0);
    if (userFloor && updateId < userFloor) {
      return { accept: false, reason: 'before_user_reset', updateId, key, command };
    }
    if (s.seenUpdates.has(updateId)) {
      return { accept: false, reason: 'duplicate_update', updateId, key, command };
    }
    s.seenUpdates.set(updateId, now);
  }

  // Old webhook deliveries are safe to discard for this downloader: users can
  // simply resend the link. Reset/start/help are always allowed through.
  if (!resetCommand && command !== '/start' && command !== '/help') {
    const messageTime = messageTimestampMs(update);
    const staleAfter = numericEnv('UPDATE_STALE_AFTER_MS', DEFAULT_STALE_AFTER_MS);
    if (messageTime && now - messageTime > staleAfter) {
      return { accept: false, reason: 'stale_update', updateId, key, command };
    }
  }

  return { accept: true, reason: 'accepted', updateId, key, command };
}

export function captureJobFence(update = {}) {
  const s = state();
  const key = userKeyFrom(update);
  return {
    key,
    globalGeneration: Number(s.globalGeneration || 0),
    userGeneration: Number(s.userGenerations.get(key) || 0),
  };
}

export function isJobFenceActive(fence) {
  if (!fence) return true;
  const s = state();
  return Number(s.globalGeneration || 0) === Number(fence.globalGeneration || 0)
    && Number(s.userGenerations.get(fence.key) || 0) === Number(fence.userGeneration || 0);
}

export function resetUserFence(update = {}) {
  const s = state();
  const key = userKeyFrom(update);
  const current = Number(s.userGenerations.get(key) || 0);
  const next = current + 1;
  s.userGenerations.set(key, next);

  const updateId = Number(update?.update_id || 0);
  if (Number.isFinite(updateId) && updateId > 0) {
    s.userResetFloors.set(key, updateId);
  }

  return { key, generation: next, updateId };
}

export function resetGlobalFence(update = {}) {
  const s = state();
  s.globalGeneration = Number(s.globalGeneration || 0) + 1;
  const updateId = Number(update?.update_id || 0);
  if (Number.isFinite(updateId) && updateId > 0) {
    s.globalResetFloor = updateId;
  }
  return { generation: s.globalGeneration, updateId };
}

export function isResetAdmin(userId) {
  const allowed = String(
    process.env.BOT_OWNER_ID
      || process.env.RESET_ADMIN_USER_ID
      || process.env.TELEGRAM_ADMIN_ID
      || '',
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return allowed.includes(String(userId || ''));
}
