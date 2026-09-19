import { extractFirstUrl, detectPlatform } from '../platform.js';
import { getTelegramFileSource, sendChatAction, sendMessage, sendVideoFileUpload } from '../telegram.js';
import { isResetAdmin } from '../recovery.js';
import { chooseBestVideo, resolveMedia } from '../bot/media-resolver.js';
import { localMediaLane } from '../bot/job-lanes.js';
import { prepareHqLab } from '../hq-lab.js';

const STATE_KEY = Symbol.for('abangrender.downloader.hq-lab.v1');
const LAB_TTL_MS = 15 * 60_000;

function state() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = new Map();
  return globalThis[STATE_KEY];
}

function stateKey(message) {
  return `${String(message?.chat?.id || '')}:${String(message?.from?.id || '')}`;
}

function isPrivateOwner(message) {
  return message?.chat?.type === 'private' && isResetAdmin(message?.from?.id);
}

function commandFromMessage(message) {
  const text = String(message?.text || message?.caption || '').trim();
  const token = text.split(/\s+/)[0]?.toLowerCase() || '';
  return token.split('@')[0];
}

function activeLab(message) {
  if (!isPrivateOwner(message)) return false;
  const key = stateKey(message);
  const value = state().get(key);
  if (!value) return false;
  if (Date.now() > Number(value.expiresAt || 0)) {
    state().delete(key);
    return false;
  }
  return true;
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '-';
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatFps(value) {
  const fps = Number(value || 0);
  if (!fps) return '-';
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
}

function resultCaption(result, burnLabel) {
  const output = result?.output || {};
  return [
    `🧪 ${result.id} — ${result.name}`,
    output.width && output.height ? `📐 ${output.width} × ${output.height}` : null,
    output.fps ? `🎞 ${formatFps(output.fps)} fps` : null,
    `📊 Target video: ${result.videoKbps} kbps`,
    `📦 ${formatSize(result.size)}`,
    `⚡ Encode: ${(Number(result.elapsedMs || 0) / 1000).toFixed(1)}s`,
    burnLabel ? '🏷️ Label test dibakar pada video' : '🏷️ Label: caption sahaja (drawtext runtime tak tersedia)',
  ].filter(Boolean).join('\n').slice(0, 1024);
}

async function resolveLabInput(message) {
  const uploadedFileId = message?.video?.file_id
    || (String(message?.document?.mime_type || '').startsWith('video/') ? message.document.file_id : '');
  if (uploadedFileId) {
    const video = await getTelegramFileSource(uploadedFileId);
    return { sourceUrl: '', platform: 'telegram', video };
  }

  const url = extractFirstUrl(message?.text || message?.caption || '');
  if (!url) return null;
  const platform = detectPlatform(url);
  if (!platform) {
    const error = new Error('Link ini belum disokong oleh HQ Lab.');
    error.code = 'HQ_LAB_UNSUPPORTED_LINK';
    throw error;
  }
  if (platform === 'youtube') return { sourceUrl: url, platform, video: null };

  const media = await resolveMedia(platform, url);
  const video = chooseBestVideo(media?.videos || []);
  if (!video) {
    const error = new Error('HQ Lab tak jumpa video pada link ini.');
    error.code = 'HQ_LAB_VIDEO_NOT_FOUND';
    throw error;
  }
  return { sourceUrl: url, platform, video };
}

export async function handleHqLabCommand(message) {
  if (commandFromMessage(message) !== '/hqlab') return false;
  if (!isPrivateOwner(message)) return true;

  const chatId = message.chat.id;
  const raw = String(message?.text || '').trim().toLowerCase();
  if (/\s+(?:off|stop|cancel|batal)$/.test(raw)) {
    state().delete(stateKey(message));
    await sendMessage(chatId, '🧪 HQ Lab ditutup.').catch(() => {});
    return true;
  }

  state().set(stateKey(message), { expiresAt: Date.now() + LAB_TTL_MS });
  await sendMessage(
    chatId,
    [
      '🧪 HQ Lab aktif — hanya untuk owner.',
      '',
      'Sekarang hantar SATU:',
      '• link TikTok / Reels / Threads / X / YouTube',
      '• atau upload satu video dari Gallery',
      '',
      'Bot akan hasilkan A–E dari source yang sama:',
      'A Current HQ • B Light HQ • C Sharp HQ • D 900p HQ • E Motion HQ',
      '',
      'Setiap result akan dilabel dan dihantar satu-satu untuk test WhatsApp Status.',
      'Taip /hqlab off untuk batal.',
    ].join('\n'),
  );
  return true;
}

export async function processHqLabMessage(message, context = {}) {
  if (!activeLab(message)) return false;
  if (commandFromMessage(message).startsWith('/')) return false;

  const chatId = message?.chat?.id;
  if (!chatId) return false;

  let input;
  try {
    input = await resolveLabInput(message);
  } catch (error) {
    await sendMessage(chatId, `❌ ${error?.message || 'HQ Lab tak dapat baca input ini.'}`).catch(() => {});
    return true;
  }
  if (!input) {
    await sendMessage(chatId, 'HQ Lab tunggu link video atau upload video dari Gallery.').catch(() => {});
    return true;
  }

  state().delete(stateKey(message));
  await sendMessage(chatId, '🧪 HQ Lab sedang buat 5 versi. Production user lain tak terjejas.').catch(() => {});
  await sendChatAction(chatId, 'upload_video').catch(() => {});

  let prepared = null;
  try {
    prepared = await localMediaLane(() => prepareHqLab(input));
    const successes = prepared.results.filter((item) => item.ok);
    const failures = prepared.results.filter((item) => !item.ok);

    for (const result of successes) {
      await sendChatAction(chatId, 'upload_video').catch(() => {});
      await sendVideoFileUpload(chatId, result.filePath, resultCaption(result, prepared.burnLabel));
    }

    if (failures.length) {
      await sendMessage(
        chatId,
        `⚠️ HQ Lab siap ${successes.length}/5. Gagal: ${failures.map((item) => `${item.id} ${item.name}`).join(', ')}.`,
      ).catch(() => {});
    } else {
      await sendMessage(
        chatId,
        '✅ HQ Lab siap A–E. Upload kelima-lima result ke WhatsApp Status dan compare sharpness selepas WhatsApp compress.',
      ).catch(() => {});
    }
  } catch (error) {
    console.error('[hq-lab] failed:', error?.code, error?.message);
    await sendMessage(chatId, '❌ HQ Lab tak dapat disiapkan untuk source ini. Production Status HQ tidak disentuh.').catch(() => {});
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
  return true;
}
