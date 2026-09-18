import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
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

function productionBaseUrl() {
  const explicit = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (explicit) return explicit;
  const productionHost = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (productionHost) return `https://${productionHost}`;
  const deploymentHost = String(process.env.VERCEL_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return deploymentHost ? `https://${deploymentHost}` : '';
}

async function ensureInteractiveWebhook() {
  const baseUrl = productionBaseUrl();
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!baseUrl || !process.env.TELEGRAM_BOT_TOKEN) return false;

  try {
    const current = await telegram('getWebhookInfo').catch(() => null);
    const next = new URL(`${baseUrl}/api/telegram`);
    if (current?.url) {
      try {
        const existing = new URL(current.url);
        const mirrorGroup = existing.searchParams.get('mirror_group');
        if (mirrorGroup) next.searchParams.set('mirror_group', mirrorGroup);
      } catch {}
    }

    await telegram('setWebhook', {
      url: next.toString(),
      ...(webhookSecret ? { secret_token: webhookSecret } : {}),
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: false,
    });
    return true;
  } catch (error) {
    console.warn('Interactive webhook refresh failed:', error?.message);
    return false;
  }
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

function appendFormExtra(form, extra = {}) {
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') form.set(key, JSON.stringify(value));
    else form.set(key, String(value));
  }
}

function normalizedRotation(stderr = '') {
  const sideData = String(stderr).match(/rotation of\s+(-?\d+(?:\.\d+)?)\s+degrees/i);
  const metadata = String(stderr).match(/\brotate\s*:\s*(-?\d+(?:\.\d+)?)/i);
  const raw = Number(sideData?.[1] ?? metadata?.[1] ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

async function probeTelegramVideoMetadata(filePath) {
  if (!filePath || !ffmpegPath) return {};
  let stderr = '';
  try {
    await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-i', filePath],
      {
        timeout: Number(process.env.TELEGRAM_VIDEO_PROBE_TIMEOUT_MS || 12000),
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const dimensions = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  let width = dimensions ? Number(dimensions[1]) : 0;
  let height = dimensions ? Number(dimensions[2]) : 0;
  const rotation = normalizedRotation(stderr);
  if ((rotation === 90 || rotation === 270) && width > 0 && height > 0) {
    [width, height] = [height, width];
  }
  const duration = durationMatch
    ? Math.max(1, Math.round((Number(durationMatch[1]) * 3600) + (Number(durationMatch[2]) * 60) + Number(durationMatch[3])))
    : 0;

  return {
    ...(width > 0 ? { width } : {}),
    ...(height > 0 ? { height } : {}),
    ...(duration > 0 ? { duration } : {}),
  };
}

async function probeTelegramVideoBuffer(buffer, extension = 'mp4') {
  if (!buffer?.length || !ffmpegPath) return {};
  const dir = await mkdtemp(path.join(os.tmpdir(), 'telegram-video-probe-'));
  const safeExtension = String(extension || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const filePath = path.join(dir, `source.${safeExtension}`);
  try {
    await writeFile(filePath, buffer);
    return await probeTelegramVideoMetadata(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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

export async function getTelegramFileSource(fileId) {
  if (!fileId) {
    const err = new Error('Telegram file_id is missing.');
    err.code = 'TELEGRAM_FILE_ID_MISSING';
    throw err;
  }

  const file = await telegram('getFile', { file_id: fileId });
  if (!file?.file_path) {
    const err = new Error('Telegram did not return a file path.');
    err.code = 'TELEGRAM_FILE_PATH_MISSING';
    throw err;
  }

  const ext = path.extname(file.file_path).replace(/^\./, '').toLowerCase() || 'mp4';
  return {
    url: `${telegramApiBase()}/file/bot${botToken()}/${file.file_path}`,
    ext,
    filesize: Number(file.file_size || 0) || null,
    headers: null,
    quality: 'Telegram video',
    hasAudio: true,
    source: 'telegram-file',
  };
}

export async function sendMessage(chatId, text, extra = {}) {
  const interactiveText = String(text);
  if (interactiveText.includes('TikTok photo/slideshow dikesan')) {
    await ensureInteractiveWebhook();
  }

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

export function sendVideoUrl(chatId, url, caption = '', extra = {}) {
  return telegram('sendVideo', {
    chat_id: chatId,
    video: url,
    caption: caption.slice(0, 1024),
    supports_streaming: true,
    ...extra,
  });
}

export async function sendVideoUpload(chatId, item, caption = '', extra = {}) {
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

  const arrayBuffer = await upstream.arrayBuffer();
  if (arrayBuffer.byteLength > limit) {
    const err = new Error(`Video is too large for the configured Telegram upload limit (${arrayBuffer.byteLength} bytes).`);
    err.code = 'TELEGRAM_FILE_TOO_LARGE';
    throw err;
  }

  const contentType = upstream.headers.get('content-type') || 'video/mp4';
  const extension = extensionFor(item, contentType);
  const buffer = Buffer.from(arrayBuffer);
  const probedMetadata = await probeTelegramVideoBuffer(buffer, extension).catch((error) => {
    console.warn('[telegram/video-probe] failed:', error?.message);
    return {};
  });
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption.slice(0, 1024));
  form.set('supports_streaming', 'true');
  appendFormExtra(form, {
    ...extra,
    ...probedMetadata,
  });
  form.set('video', new Blob([buffer], { type: contentType }), `video.${extension}`);

  const response = await fetch(telegramEndpoint('sendVideo'), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS || 55000)),
  });
  return parseTelegramResponse(response, 'sendVideo');
}

export async function sendVideoFileUpload(chatId, filePath, caption = '', extra = {}) {
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
  const probedMetadata = await probeTelegramVideoMetadata(filePath).catch(() => ({}));
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption.slice(0, 1024));
  form.set('supports_streaming', 'true');
  appendFormExtra(form, {
    ...extra,
    ...probedMetadata,
  });
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
