import { dispatchHeavyMediaJob, heavyVideoLimitBytes, heavyWorkerConfigured } from '../heavy-worker-dispatch.js';
import { isJobFenceActive } from '../recovery.js';
import { sendMessage, telegram } from '../telegram.js';
import {
  MEDIA_LIVE_WALLPAPER,
  claimMediaButtons,
  galleryMediaMeta,
} from '../bot/media-actions.js';
import { removeHeavyProgress, startHeavyLiveProgress } from '../bot/progress.js';

function cancelled(fence) {
  return fence && !isJobFenceActive(fence);
}

export async function processLiveWallpaperButton(callbackQuery, context = {}) {
  const action = String(callbackQuery?.data || '');
  if (!action.startsWith(MEDIA_LIVE_WALLPAPER)) return false;

  const fence = context.fence || null;
  const chatId = callbackQuery?.message?.chat?.id;
  const video = callbackQuery?.message?.video || null;
  const fileId = video?.file_id;
  const gallery = galleryMediaMeta(action, MEDIA_LIVE_WALLPAPER);
  const fileSize = Number(video?.file_size || gallery?.fileSize || 0);
  const callbackMessageId = Math.max(0, Number(callbackQuery?.message?.message_id || 0));
  if (!chatId) return true;

  if (!fileId) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '❌ Video untuk Apple Live Photo tak dijumpai. Hantar video/link semula.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  if (gallery && fileSize > heavyVideoLimitBytes()) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Sorry, you can only upload videos up to 150 MB.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  if (!heavyWorkerConfigured()) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '⚠️ Apple Live Photo worker belum aktif sepenuhnya.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  const claimed = await claimMediaButtons(callbackQuery);
  if (!claimed) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Pilihan ini dah digunakan. Hantar video/link semula untuk buat lagi.',
      show_alert: false,
    }).catch(() => {});
    return true;
  }

  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});
  if (cancelled(fence)) return true;

  const progressMessage = await startHeavyLiveProgress(chatId);
  try {
    await dispatchHeavyMediaJob({
      chatId,
      videoFileId: fileId,
      fileSize,
      action: 'live_wallpaper',
      sourceKind: gallery ? 'gallery' : 'link',
      progressMessageId: progressMessage?.message_id || 0,
      sourceMessageId: gallery?.sourceMessageId || callbackMessageId || 0,
    });
  } catch (error) {
    console.error('[live-wallpaper] dispatch failed:', error?.code, error?.message);
    await removeHeavyProgress(chatId, progressMessage?.message_id);
    if (!cancelled(fence)) {
      await sendMessage(chatId, '❌ Apple Live Photo worker tak dapat dimulakan sekarang. Cuba lagi.').catch(() => {});
    }
  }
  return true;
}
