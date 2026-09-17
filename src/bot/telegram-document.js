import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    const error = new Error('Telegram bot token is not configured.');
    error.code = 'TELEGRAM_NOT_CONFIGURED';
    throw error;
  }
  return token;
}

function uploadLimitBytes() {
  const configured = Number(process.env.TELEGRAM_UPLOAD_MAX_MB || 0);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : 50;
  return Math.floor(mb * 1024 * 1024);
}

function endpoint(method) {
  const base = String(process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '');
  return `${base}/bot${botToken()}/${method}`;
}

export async function sendDocumentFileUpload(chatId, filePath, caption = '', fileName = '') {
  if (!filePath) throw new Error('Local document path is missing.');
  const fileStat = await stat(filePath);
  if (fileStat.size > uploadLimitBytes()) {
    const error = new Error(`Document is too large for the configured Telegram upload limit (${fileStat.size} bytes).`);
    error.code = 'TELEGRAM_FILE_TOO_LARGE';
    throw error;
  }

  const buffer = await readFile(filePath);
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase() || 'bin';
  const contentType = extension === 'jpg' || extension === 'jpeg'
    ? 'image/jpeg'
    : extension === 'png'
      ? 'image/png'
      : 'application/octet-stream';
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption.slice(0, 1024));
  form.set('document', new Blob([buffer], { type: contentType }), fileName || `file.${extension}`);

  const response = await fetch(endpoint('sendDocument'), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TELEGRAM_DOCUMENT_UPLOAD_TIMEOUT_MS || 55000)),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    const error = new Error(result?.description || `Telegram sendDocument failed (${response.status}).`);
    error.code = 'TELEGRAM_API_ERROR';
    error.status = response.status;
    throw error;
  }
  return result.result;
}
