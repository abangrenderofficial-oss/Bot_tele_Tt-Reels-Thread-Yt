import { sendMessage, telegram } from '../telegram.js';

const RPC_RECORD = 'record_downloader_usage';
const RPC_STATS = 'get_downloader_usage_stats';
const EVENT_TYPES = new Set(['download', 'status_hq', 'live_wallpaper']);

function config() {
  const url = String(process.env.STATS_SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.STATS_SUPABASE_KEY || '').trim();
  const secret = String(process.env.STATS_RPC_SECRET || '').trim();
  return { url, key, secret, ready: Boolean(url && key && secret) };
}

async function rpc(functionName, body) {
  const { url, key, ready } = config();
  if (!ready) return null;

  const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Stats RPC ${functionName} failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

export async function recordUsage(userId, eventType = null) {
  const id = Number(userId || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  if (eventType && !EVENT_TYPES.has(eventType)) return false;

  const { secret, ready } = config();
  if (!ready) return false;

  try {
    await rpc(RPC_RECORD, {
      p_secret: secret,
      p_user_id: id,
      p_event_type: eventType || null,
    });
    return true;
  } catch (error) {
    console.warn('[stats/record] failed:', error?.message);
    return false;
  }
}

export async function getUsageStats() {
  const { secret, ready } = config();
  if (!ready) throw new Error('Stats storage is not configured.');

  const payload = await rpc(RPC_STATS, { p_secret: secret });
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row) throw new Error('Stats RPC returned no data.');

  return {
    totalUsers: Number(row.total_users || 0),
    active30Days: Number(row.active_30_days || 0),
    downloadsThisMonth: Number(row.downloads_this_month || 0),
    statusHqUsers: Number(row.status_hq_users || 0),
    liveWallpaperUsers: Number(row.live_wallpaper_users || 0),
  };
}

function number(value) {
  return new Intl.NumberFormat('en-MY').format(Number(value || 0));
}

async function isGroupAdmin(chatId, userId) {
  if (!chatId || !userId) return false;
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
