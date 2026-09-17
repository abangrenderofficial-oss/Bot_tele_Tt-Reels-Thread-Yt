import { readFile, stat } from 'node:fs/promises';

const MB = 1024 * 1024;
const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

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

export async function sendLivePhotoFileUpload(chatId, videoPath, photoPath, caption = '') {
  if (!videoPath || !photoPath) throw new Error('Live Photo files are missing.');

  const [videoStat, photoStat] = await Promise.all([stat(videoPath), stat(photoPath)]);
  if (videoStat.size > 10 * MB) {
    const err = new Error(`Live Photo video exceeds 10 MB (${videoStat.size} bytes).`);
    err.code = 'LIVE_PHOTO_TOO_LARGE';
    throw err;
  }
  if (!videoStat.size || !photoStat.size) throw new Error('Live Photo files are empty.');

  const [videoBuffer, photoBuffer] = await Promise.all([readFile(videoPath), readFile(photoPath)]);
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', String(caption || '').slice(0, 1024));
  form.set('live_photo', new Blob([videoBuffer], { type: 'video/mp4' }), 'live-wallpaper.mp4');
  form.set('photo', new Blob([photoBuffer], { type: 'image/jpeg' }), 'live-wallpaper.jpg');

  const response = await fetch(telegramEndpoint('sendLivePhoto'), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TELEGRAM_LIVE_UPLOAD_TIMEOUT_MS || 65000)),
  });
  return parseTelegramResponse(response, 'sendLivePhoto');
}
