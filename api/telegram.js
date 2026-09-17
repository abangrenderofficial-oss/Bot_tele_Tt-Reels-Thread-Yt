import { detectPlatform, extractFirstUrl } from '../src/platform.js';
import { sendMessage } from '../src/telegram.js';
import {
  beginUpdate,
  captureJobFence,
  isResetAdmin,
  resetGlobalFence,
  resetUserFence,
} from '../src/recovery.js';
import { commandMenuText, START_TEXT } from '../src/bot/commands.js';
import { handleConnectCommand, processAuditDelete, setMirrorWebhook } from '../src/bot/audit.js';
import { processStatusButton, processStatusFromLink } from '../src/features/status-hq.js';
import { processLiveWallpaperButton } from '../src/features/live-wallpaper.js';
import { processUploadedPhoto, processUploadedVideo } from '../src/features/uploaded-media.js';
import { processStandardDownload } from '../src/features/downloader.js';
import { processTikTokSlideshowChoice, sendTikTokSlideshowChoice } from '../src/features/tiktok-slideshow.js';

function json(res, status, body) {
  res.status(status).json(body);
}

function isAuthorizedWebhook(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return req.headers['x-telegram-bot-api-secret-token'] === expected;
}

function requestBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!forwardedHost) return '';
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  return `${proto}://${forwardedHost}`;
}

function mirrorGroupFromRequest(req) {
  const raw = Array.isArray(req?.query?.mirror_group) ? req.query.mirror_group[0] : req?.query?.mirror_group;
  const value = String(raw || '').trim();
  return /^-?\d+$/.test(value) ? value : '';
}

function commandFromMessage(message) {
  const text = String(message?.text || message?.caption || '').trim();
  const token = text.split(/\s+/)[0]?.toLowerCase() || '';
  return token.split('@')[0];
}

async function processMessage(message, context) {
  const chatId = message?.chat?.id;
  const text = message?.text || message?.caption || '';
  if (!chatId) return;

  const command = commandFromMessage(message);
  if (command === '/connect') {
    await handleConnectCommand(message, context.baseUrl, false);
    return;
  }
  if (command === '/disconnect') {
    await handleConnectCommand(message, context.baseUrl, true);
    return;
  }
  if (command === '/start' || command === '/help') {
    await sendMessage(chatId, START_TEXT);
    return;
  }

  if (Array.isArray(message?.photo) && message.photo.length) {
    await processUploadedPhoto(message, context);
    return;
  }
  if (message?.video?.file_id) {
    await processUploadedVideo(message, context);
    return;
  }

  const statusMode = command === '/status' || command === 'status';
  const url = extractFirstUrl(text);
  if (!url) {
    await sendMessage(
      chatId,
      statusMode
        ? 'Guna format: /status <link video>'
        : 'Hantar satu link TikTok, Instagram, Threads, X/Twitter atau YouTube, atau upload video/gambar dari gallery.',
    );
    return;
  }

  const platform = detectPlatform(url);
  if (!platform) {
    await sendMessage(chatId, 'Link ni belum disokong. Buat masa sekarang: TikTok, Instagram, Threads, X/Twitter dan YouTube.');
    return;
  }

  if (statusMode) {
    await processStatusFromLink(chatId, url, platform, context.fence);
    return;
  }

  const result = await processStandardDownload({ chatId, url, platform, context, message });
  if (result?.slideshow) await sendTikTokSlideshowChoice(chatId, url);
}

async function runWebhookUpdate(update, context) {
  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    if (await processAuditDelete(callbackQuery)) return;
    if (await processStatusButton(callbackQuery, context)) return;
    if (await processLiveWallpaperButton(callbackQuery, context)) return;
    await processTikTokSlideshowChoice(callbackQuery, context);
    return;
  }

  const message = update?.message ?? update?.edited_message;
  if (message) await processMessage(message, context);
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'telegram-social-downloader',
      endpoint: 'webhook',
      mirror_connected: Boolean(mirrorGroupFromRequest(req)),
      architecture: 'isolated-features-v1',
      recovery: 'sync-recovery-v3',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  if (!isAuthorizedWebhook(req)) {
    return json(res, 401, { ok: false, error: 'invalid_webhook_secret' });
  }

  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const decision = beginUpdate(update);
    if (!decision.accept) return json(res, 200, { ok: true, ignored: decision.reason });

    const context = {
      baseUrl: requestBaseUrl(req),
      mirrorGroupId: mirrorGroupFromRequest(req),
    };

    const message = update?.message ?? update?.edited_message;
    const command = commandFromMessage(message);

    if (command === '/menu') {
      const userId = message?.from?.id;
      await sendMessage(message.chat.id, commandMenuText(userId)).catch((error) => console.warn('Menu reply failed:', error?.message));
      return json(res, 200, { ok: true, menu: isResetAdmin(userId) ? 'owner' : 'user' });
    }

    if (command === '/reset') {
      resetUserFence(update);
      await sendMessage(
        message.chat.id,
        '♻️ Sesi anda telah direset.\nSemua proses lama untuk sesi ini dibatalkan. Bot kembali normal.\nSila hantar link atau video semula.',
      ).catch((error) => console.warn('User reset reply failed:', error?.message));
      return json(res, 200, { ok: true, reset: 'user' });
    }

    if (command === '/resetadmin') {
      const userId = message?.from?.id;
      if (!isResetAdmin(userId)) {
        await sendMessage(message.chat.id, '❌ /resetadmin hanya untuk owner bot.').catch(() => {});
        return json(res, 200, { ok: true, reset: false, reason: 'not_owner' });
      }

      resetGlobalFence(update);
      try {
        await setMirrorWebhook(context.baseUrl, context.mirrorGroupId, true);
        await sendMessage(
          message.chat.id,
          '♻️ ADMIN RESET selesai.\nPending update lama dibuang dan semua proses lama ditandakan batal. Bot kembali ke keadaan bersih.',
        );
      } catch (error) {
        console.error('Admin reset failed:', error?.message);
        await sendMessage(message.chat.id, '❌ Admin reset tak dapat disiapkan sepenuhnya. Cuba sekali lagi.').catch(() => {});
      }
      return json(res, 200, { ok: true, reset: 'admin' });
    }

    context.fence = captureJobFence(update);
    await runWebhookUpdate(update, context);
    return json(res, 200, { ok: true, accepted: true });
  } catch (error) {
    console.error('[webhook/router] error:', error);
    return json(res, 200, { ok: false, handled: true });
  }
}
