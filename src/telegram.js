import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_CLOUD_UPLOAD_LIMIT = 50 * 1024 * 1024;

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    const err = new Error('Telegram bot token is not configured.');
    err.code = 'TELEGRAM_NOT_CONFIGURED';
    throw err;
  }
  return token;
}

function telegramApiBase() {
  return String(process.env.TELEGRAM_API_BASE_URL || DEFAULT_TELEGRAM_API_BASE).replace(/\/$/, '');
}

function telegramEndpoint(method) {
  return `${telegramApiBase()}/bot${botToken()}/${method}`;
}

function uploadLimitBytes() {
  const configured = Number(process.env.TELEGRAM_UPLOAD_MAX_MB || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured * 1024 * 1024);
  return DEFAULT_CLOUD_UPLOAD_LIMIT;
}

function sourceHeaders(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const allowed = new Set(['user-agent', 'referer', 'origin', 'accept', 'accept-language']);
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!allowed.has(String(key).toLowerCase())) continue;
    if (typeof value !== 'string' || !value) continue;
    out[key] = value;
  }
  return out;
}

function extensionFor(item, contentType = '') {
  const explicit = String(item?.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (explicit) return explicit;
  if (String(contentType).includes('webm')) return 'webm';
  if (String(contentType).includes('quicktime')) return 'mov';
  return 'mp4';
}

async function parseTelegramResponse(response, method) {
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    const err = new Error(result?.description || `Telegram ${method} failed (${response.status}).`);
    err.code = 'TELEGRAM_API_ERROR';
    err.status = response.status;
    throw err;
  }
  return result.result;
}

export async function telegram(method, payload = {}) {
  const response = await fetch(telegramEndpoint(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });
  return parseTelegramResponse(response, method);
}

export function sendMessage(chatId, text, extra = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

export function sendChatAction(chatId, action = 'typing') {
  return telegram('sendChatAction', { chat_id: chatId, action });
}

export function sendVideoUrl(chatId, url, caption = '') {
  return telegram('sendVideo', {
    chat_id: chatId,
    video: url,
    caption: caption.slice(0, 1024),
    supports_streaming: true,
  });
}

export async function sendVideoUpload(chatId, item, caption = '') {
  if (!item?.url) throw new Error('Video source URL is missing.');

  const limit = uploadLimitBytes();
  const knownSize = Number(item.filesize || 0);
  if (knownSize > limit) {
    const err = new Error(`Video is too large for the configured Telegram upload limit (${knownSize} bytes).`);
    err.code = 'TELEGRAM_FILE_TOO_LARGE';
    throw err;
  }

  const upstream = await fetch(item.url, {
    method: 'GET',
    headers: sourceHeaders(item.headers),
    redirect: 'follow',
    signal: AbortSignal.timeout(Number(process.env.MEDIA_FETCH_TIMEOUT_MS || 45000)),
  });

  if (!upstream.ok) {
    const err = new Error(`Media source returned HTTP ${upstream.status}.`);
    err.code = 'MEDIA_FETCH_ERROR';
    throw err;
  }

  const contentLength = Number(upstream.headers.get('content-length') || 0);
  if (contentLength > limit) {
    const err = new Error(`Video is too large for the configured Telegram upload limit (${contentLength} bytes).`);
    err.code = 'TELEGRAM_FILE_TOO_LARGE';
    throw err;
  }

  const buffer = await upstream.arrayBuffer();
  if (buffer.byteLength > limit) {
    const err = new Error(`Video is too large for the configured Telegram upload limit (${buffer.byteLength} bytes).`);
    err.code = 'TELEGRAM_FILE_TOO_LARGE';
    throw err;
  }

  const contentType = upstream.headers.get('content-type') || 'video/mp4';
  const extension = extensionFor(item, contentType);
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption.slice(0, 1024));
  form.set('supports_streaming', 'true');
  form.set('video', new Blob([buffer], { type: contentType }), `video.${extension}`);

  const response = await fetch(telegramEndpoint('sendVideo'), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS || 55000)),
  });
  return parseTelegramResponse(response, 'sendVideo');
}

export async function sendVideoFileUpload(chatId, filePath, caption = '') {
  if (!filePath) throw new Error('Local video path is missing.');

  const fileStat = await stat(filePath);
  const limit = uploadLimitBytes();
  if (fileStat.size > limit) {
    const err = new Error(`Video is too large for the configured Telegram upload limit (${fileStat.size} bytes).`);
    err.code = 'TELEGRAM_FILE_TOO_LARGE';
    throw err;
  }

  const buffer = await readFile(filePath);
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase() || 'mp4';
  const contentType = extension === 'webm' ? 'video/webm' : extension === 'mov' ? 'video/quicktime' : 'video/mp4';
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption.slice(0, 1024));
  form.set('supports_streaming', 'true');
  form.set('video', new Blob([buffer], { type: contentType }), `video.${extension}`);

  const response = await fetch(telegramEndpoint('sendVideo'), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS || 55000)),
  });
  return parseTelegramResponse(response, 'sendVideo');
}

export function sendPhotoUrl(chatId, url, caption = '') {
  return telegram('sendPhoto', {
    chat_id: chatId,
    photo: url,
    caption: caption.slice(0, 1024),
  });
}

export function sendMediaGroup(chatId, items) {
  return telegram('sendMediaGroup', {
    chat_id: chatId,
    media: items.slice(0, 10),
  });
}

export function sendDownloadButton(chatId, text, url, label = '⬇️ Download') {
  return sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: label, url }]],
    },
  });
}
