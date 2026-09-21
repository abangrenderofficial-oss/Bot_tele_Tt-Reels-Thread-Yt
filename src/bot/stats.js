import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sendMessage, telegram } from '../telegram.js';

const EVENT_TYPES = new Set(['download', 'status_hq', 'live_wallpaper']);
const STATS_FILE = String(process.env.STATS_FILE_PATH || '/data/bot-stats.json');
const STATS_VERSION = 1;

let statePromise = null;
let writeQueue = Promise.resolve();

function emptyState() {
  return {
    version: STATS_VERSION,
    trackingSince: new Date().toISOString(),
    users: {},
    monthlyDownloads: {},
  };
}

function normalizeState(raw) {
  const fallback = emptyState();
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    version: STATS_VERSION,
    trackingSince: typeof raw.trackingSince === 'string' && raw.trackingSince
      ? raw.trackingSince
      : fallback.trackingSince,
    users: raw.users && typeof raw.users === 'object' ? raw.users : {},
    monthlyDownloads: raw.monthlyDownloads && typeof raw.monthlyDownloads === 'object'
      ? raw.monthlyDownloads
      : {},
  };
}

async function loadState() {
  if (!statePromise) {
    statePromise = (async () => {
      try {
        const text = await readFile(STATS_FILE, 'utf8');
        return normalizeState(JSON.parse(text));
      } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('[stats] load failed:', error?.message);
        return emptyState();
      }
    })();
  }
  return statePromise;
}

async function persistState(state) {
  await mkdir(path.dirname(STATS_FILE), { recursive: true });
  const temp = `${STATS_FILE}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state)}\n`, 'utf8');
  await rename(temp, STATS_FILE);
}

function mutate(mutator) {
  writeQueue = writeQueue.then(async () => {
    const state = await loadState();
    mutator(state);
    await persistState(state);
  }).catch((error) => {
    console.error('[stats] write failed:', error?.message);
  });
  return writeQueue;
}

function validUserKey(userId) {
  const id = Number(userId || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return String(id);
}

function monthKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function touchUser(state, userId, now = new Date()) {
  const key = validUserKey(userId);
  if (!key) return null;
  const iso = now.toISOString();
  const old = state.users[key] && typeof state.users[key] === 'object' ? state.users[key] : {};
  const user = {
    firstSeen: old.firstSeen || iso,
    lastSeen: iso,
    statusHq: Boolean(old.statusHq),
    liveWallpaper: Boolean(old.liveWallpaper),
    completedUse: Boolean(old.completedUse || old.statusHq || old.liveWallpaper),
    premiumHqCompleted: Boolean(old.premiumHqCompleted),
    joinPromptSent: Boolean(old.joinPromptSent),
  };
  state.users[key] = user;
  return user;
}

export async function recordUsage(userId, eventType = null) {
  const key = validUserKey(userId);
  if (!key) return false;
  if (eventType && !EVENT_TYPES.has(eventType)) return false;

  await mutate((state) => {
    const now = new Date();
    const user = touchUser(state, userId, now);
    if (!user) return;

    if (eventType) user.completedUse = true;

    if (eventType === 'download') {
      const month = monthKey(now);
      state.monthlyDownloads[month] = Math.max(0, Number(state.monthlyDownloads[month] || 0)) + 1;
    } else if (eventType === 'status_hq') {
      user.statusHq = true;
    } else if (eventType === 'live_wallpaper') {
      user.liveWallpaper = true;
    }
  });
  return true;
}

export async function hasCompletedUse(userId) {
  const key = validUserKey(userId);
  if (!key) return false;
  await writeQueue;
  const state = await loadState();
  const user = state.users?.[key];
  return Boolean(user?.completedUse || user?.statusHq || user?.liveWallpaper);
}

export async function markPremiumHqCompleted(userId) {
  const key = validUserKey(userId);
  if (!key) return false;
  await mutate((state) => {
    const user = touchUser(state, userId, new Date());
    if (user) user.premiumHqCompleted = true;
  });
  return true;
}

export async function hasPremiumHqCompleted(userId) {
  const key = validUserKey(userId);
  if (!key) return false;
  await writeQueue;
  const state = await loadState();
  return Boolean(state.users?.[key]?.premiumHqCompleted);
}

export async function hasJoinPromptBeenSent(userId) {
  const key = validUserKey(userId);
  if (!key) return false;
  await writeQueue;
  const state = await loadState();
  return Boolean(state.users?.[key]?.joinPromptSent);
}

export async function markJoinPromptSent(userId) {
  const key = validUserKey(userId);
  if (!key) return false;
  await mutate((state) => {
    const user = touchUser(state, userId, new Date());
    if (user) user.joinPromptSent = true;
  });
  return true;
}

export async function getUsageStats() {
  await writeQueue;
  const state = await loadState();
  const users = Object.values(state.users || {});
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);

  return {
    totalUsers: users.length,
    active30Days: users.filter((user) => {
      const lastSeen = Date.parse(String(user?.lastSeen || ''));
      return Number.isFinite(lastSeen) && lastSeen >= cutoff;
    }).length,
    downloadsThisMonth: Math.max(0, Number(state.monthlyDownloads?.[monthKey()] || 0)),
    statusHqUsers: users.filter((user) => Boolean(user?.statusHq)).length,
    liveWallpaperUsers: users.filter((user) => Boolean(user?.liveWallpaper)).length,
    trackingSince: state.trackingSince,
  };
}

function number(value) {
  return new Intl.NumberFormat('en-MY').format(Number(value || 0));
}

async function isGroupAdmin(chatId, userId) {
  if (!chatId || !userId) return false;
  const ownerId = String(process.env.BOT_OWNER_ID || '').trim();
  if (ownerId && String(userId) === ownerId) return true;
  try {
    const member = await telegram('getChatMember', { chat_id: chatId, user_id: userId });
    return member?.status === 'creator' || member?.status === 'administrator';
  } catch {
    return false;
  }
}

export async function handleTotalUserCommand(message, context = {}) {
  const chatId = message?.chat?.id;
  const chatType = message?.chat?.type;
  const userId = message?.from?.id;
  if (!chatId) return;

  if (!['group', 'supergroup'].includes(chatType)) {
    await sendMessage(chatId, '❌ /totaluser hanya boleh digunakan dalam group pemantauan.');
    return;
  }

  if (context.mirrorGroupId && String(context.mirrorGroupId) !== String(chatId)) {
    await sendMessage(chatId, '❌ /totaluser hanya aktif dalam group pemantauan yang sedang connected.');
    return;
  }

  if (!(await isGroupAdmin(chatId, userId))) {
    await sendMessage(chatId, '❌ Hanya admin group boleh guna /totaluser.');
    return;
  }

  try {
    const stats = await getUsageStats();
    await sendMessage(chatId, [
      '📊 Bot Statistics',
      '',
      `Total users: ${number(stats.totalUsers)}`,
      `Active last 30 days: ${number(stats.active30Days)}`,
      `Downloads this month: ${number(stats.downloadsThisMonth)}`,
      `Status HQ users: ${number(stats.statusHqUsers)}`,
      `Live Wallpaper users: ${number(stats.liveWallpaperUsers)}`,
    ].join('\n'));
  } catch (error) {
    console.error('[stats/totaluser] failed:', error?.message);
    await sendMessage(chatId, '❌ Statistik belum dapat dibaca sekarang. Cuba /totaluser sekali lagi nanti.');
  }
}
