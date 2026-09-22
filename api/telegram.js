import { detectPlatform, extractFirstUrl } from '../src/platform.js';
import { sendMessage } from '../src/telegram.js';
import { beginUpdate, captureJobFence, isResetAdmin, resetGlobalFence, resetUserFence } from '../src/recovery.js';
import { commandMenuText, START_TEXT } from '../src/bot/commands.js';
import { handleConnectCommand, processAuditDelete, setMirrorWebhook } from '../src/bot/audit.js';
import { MEDIA_LIVE_WALLPAPER, MEDIA_STATUS_HQ, MEDIA_STATUS_HQ_ANDROID } from '../src/bot/media-actions.js';
import { handleTotalUserCommand, markPremiumHqCompleted, recordUsage } from '../src/bot/stats.js';
import { processStatusProfileMenu } from '../src/features/status-hq-menu.js';
import { processStatusAndroidButton } from '../src/features/status-hq-android.js';
import { processStatusButton } from '../src/features/status-hq.js';
import { processLiveWallpaperButton } from '../src/features/live-wallpaper.js';
import { processUploadedPhoto, processUploadedVideo } from '../src/features/uploaded-media.js';
import { handleHqLabCommand, processHqLabMessage } from '../src/features/hq-lab.js';
import { processTikTokSlideshowChoice } from '../src/features/tiktok-slideshow.js';
import { handleSupportTestCommand } from '../src/features/support-test.js';
import { handleSupportCommand, processSupportCallback } from '../src/features/support.js';
import { enforceChannelGateForCallback, enforceChannelGateForMessage, maybePromptChannelAfterSuccess, processChannelGateCallback } from '../src/features/channel-gate.js';
import { scheduleLinkJob } from '../src/link-queue.js';

function json(res, status, body) { res.status(status).json(body); }

function isAuthorizedWebhook(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  return !expected || req.headers['x-telegram-bot-api-secret-token'] === expected;
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
  return (text.split(/\s+/)[0]?.toLowerCase() || '').split('@')[0];
}

async function recordPremiumHqSuccess(userId, chatId, completionId) {
  const marked = await markPremiumHqCompleted(userId, completionId);
  if (!marked) return false;
  await recordUsage(userId, 'status_hq');
  await maybePromptChannelAfterSuccess(chatId, userId);
  return true;
}

async function processMessage(message, context) {
  const chatId = message?.chat?.id;
  const text = message?.text || message?.caption || '';
  if (!chatId) return;

  const command = commandFromMessage(message);
  if (command === '/connect') return handleConnectCommand(message, context.baseUrl, false);
  if (command === '/disconnect') return handleConnectCommand(message, context.baseUrl, true);
  if (command === '/start' || command === '/help') return sendMessage(chatId, START_TEXT);
  if (command === '/support') return handleSupportCommand(message, context);
  if (await enforceChannelGateForMessage(message)) return;
  if (await handleHqLabCommand(message, context)) return;
  if (await processHqLabMessage(message, context)) return;

  if (Array.isArray(message?.photo) && message.photo.length) return processUploadedPhoto(message, context);
  if (message?.video?.file_id) return processUploadedVideo(message, context);

  const statusMode = command === '/status' || command === 'status';
  const url = extractFirstUrl(text);
  if (!url) {
    await sendMessage(chatId, statusMode
      ? 'Guna format: /status <link video>'
      : 'Hantar satu link TikTok, Instagram, Threads, X/Twitter atau YouTube, atau upload video/gambar dari gallery.');
    return;
  }

  const platform = detectPlatform(url);
  if (!platform) {
    await sendMessage(chatId, 'Link ni belum disokong. Buat masa sekarang: TikTok, Instagram, Threads, X/Twitter dan YouTube.');
    return;
  }

  await scheduleLinkJob({ message, context, url, platform, statusMode });
}

async function runWebhookUpdate(update, context) {
  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    const action = String(callbackQuery?.data || '');
    const userId = callbackQuery?.from?.id;
    const chatId = callbackQuery?.message?.chat?.id;

    if (await processChannelGateCallback(callbackQuery)) return;
    if (await processSupportCallback(callbackQuery, context)) return;
    if (await enforceChannelGateForCallback(callbackQuery)) return;
    if (await processAuditDelete(callbackQuery)) return;
    if (await processStatusProfileMenu(callbackQuery, context)) return;
    if (await processStatusAndroidButton(callbackQuery, context)) {
      if (action.startsWith(MEDIA_STATUS_HQ_ANDROID)) await recordUsage(userId, 'status_hq');
      return;
    }

    const premiumResult = await processStatusButton(callbackQuery, context);
    if (premiumResult) {
      if (action.startsWith(MEDIA_STATUS_HQ) && premiumResult?.premiumVideoCompleted) {
        await recordPremiumHqSuccess(userId, chatId, `telegram:${callbackQuery.id}`);
      }
      return;
    }

    if (await processLiveWallpaperButton(callbackQuery, context)) {
      if (action.startsWith(MEDIA_LIVE_WALLPAPER)) await recordUsage(userId, 'live_wallpaper');
      return;
    }
    if (await processTikTokSlideshowChoice(callbackQuery, context)) await recordUsage(userId, 'download');
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
  if (!isAuthorizedWebhook(req)) return json(res, 401, { ok: false, error: 'invalid_webhook_secret' });

  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const decision = beginUpdate(update);
    if (!decision.accept) return json(res, 200, { ok: true, ignored: decision.reason });

    const context = { baseUrl: requestBaseUrl(req), mirrorGroupId: mirrorGroupFromRequest(req) };
    const message = update?.message ?? update?.edited_message;
    const callbackQuery = update?.callback_query;
    const actor = callbackQuery?.from || message?.from;
    const actorChatType = callbackQuery?.message?.chat?.type || message?.chat?.type;
    if (actorChatType === 'private' && actor?.id) await recordUsage(actor.id);

    const command = commandFromMessage(message);
    if (command === '/menu') {
      const userId = message?.from?.id;
      await sendMessage(message.chat.id, commandMenuText(userId)).catch((error) => console.warn('Menu reply failed:', error?.message));
      return json(res, 200, { ok: true, menu: isResetAdmin(userId) ? 'owner' : 'user' });
    }
    if (command === '/totaluser') {
      await handleTotalUserCommand(message, context);
      return json(res, 200, { ok: true, stats: true });
    }
    if (command === '/supporttest') {
      await handleSupportTestCommand(message, context);
      return json(res, 200, { ok: true, support_test: true });
    }
    if (command === '/reset') {
      resetUserFence(update);
      await sendMessage(message.chat.id, '♻️ Sesi anda telah direset.\nSemua proses lama untuk sesi ini dibatalkan. Bot kembali normal.\nSila hantar link atau video semula.')
        .catch((error) => console.warn('User reset reply failed:', error?.message));
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
        await sendMessage(message.chat.id, '♻️ ADMIN RESET selesai.\nPending update lama dibuang dan semua proses lama ditandakan batal. Bot kembali ke keadaan bersih.');
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
