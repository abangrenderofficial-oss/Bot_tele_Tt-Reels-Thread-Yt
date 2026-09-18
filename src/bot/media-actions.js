import { extractFirstUrl } from '../platform.js';
import { telegram } from '../telegram.js';

export const MEDIA_STATUS_HQ = 'media:status:v2';
export const MEDIA_LIVE_WALLPAPER = 'media:live:v1';

function compactMediaSourceToken(sourceUrl = '') {
  const raw = String(sourceUrl || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
      const videoId = parsed.pathname.match(/\/video\/(\d+)/)?.[1] || '';
      if (videoId) return `tt:${videoId}`;

      if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com') {
        const token = parsed.pathname.split('/').filter(Boolean)[0] || '';
        if (/^[A-Za-z0-9_-]{4,40}$/.test(token)) return `vt:${token}`;
      }
    }
  } catch {}

  return '';
}

export function callbackData(prefix, sourceUrl = '') {
  const raw = String(sourceUrl || '').trim();
  if (!raw) return prefix;

  const token = compactMediaSourceToken(raw);
  if (token) {
    const tokenData = `${prefix}|${token}`;
    if (Buffer.byteLength(tokenData, 'utf8') <= 64) return tokenData;
  }

  try {
    const compact = new URL(raw);
    compact.search = '';
    compact.hash = '';
    const data = `${prefix}|${compact.toString()}`;
    if (Buffer.byteLength(data, 'utf8') <= 64) return data;
  } catch {}

  return prefix;
}

export function mediaActionButtons(sourceUrl = '') {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Status HQ', callback_data: callbackData(MEDIA_STATUS_HQ, sourceUrl) }],
        [{ text: '🍎 Live Wallpaper iPhone', callback_data: callbackData(MEDIA_LIVE_WALLPAPER, sourceUrl) }],
      ],
    },
  };
}

export function imageStatusButton() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '📱 Status HQ', callback_data: MEDIA_STATUS_HQ }]],
    },
  };
}

export function galleryMediaActionButtons(sourceMessageId = 0, fileSize = 0) {
  const messageId = Math.max(0, Number(sourceMessageId || 0));
  const size = Math.max(0, Number(fileSize || 0));
  const suffix = `|g:${messageId}:${size}`;
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Status HQ', callback_data: `${MEDIA_STATUS_HQ}${suffix}` }],
        [{ text: '🍎 Live Wallpaper iPhone', callback_data: `${MEDIA_LIVE_WALLPAPER}${suffix}` }],
      ],
    },
  };
}

export function galleryMediaMeta(action, prefix) {
  const marker = `${prefix}|g:`;
  const raw = String(action || '');
  if (!raw.startsWith(marker)) return null;
  const [messageIdRaw, fileSizeRaw] = raw.slice(marker.length).split(':');
  const sourceMessageId = Number(messageIdRaw || 0);
  const fileSize = Number(fileSizeRaw || 0);
  if (!Number.isFinite(sourceMessageId) || sourceMessageId <= 0) return null;
  return {
    sourceMessageId,
    fileSize: Number.isFinite(fileSize) ? Math.max(0, fileSize) : 0,
  };
}

export function callbackSourceUrl(action, prefix, caption = '') {
  const captionUrl = extractFirstUrl(caption);
  if (captionUrl) return captionUrl;

  const embedded = String(action || '').startsWith(`${prefix}|`)
    ? String(action).slice(prefix.length + 1)
    : '';

  const tikTokId = embedded.match(/^tt:(\d{10,25})$/)?.[1] || '';
  if (tikTokId) return `https://www.tiktok.com/@_/video/${tikTokId}`;

  const shortToken = embedded.match(/^vt:([A-Za-z0-9_-]{4,40})$/)?.[1] || '';
  if (shortToken) return `https://vt.tiktok.com/${shortToken}/`;

  return extractFirstUrl(embedded);
}

export async function claimMediaButtons(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  if (!chatId || !messageId) return false;

  try {
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    return true;
  } catch (error) {
    console.warn('Media action buttons already used or could not be claimed:', error?.code, error?.message);
    return false;
  }
}
