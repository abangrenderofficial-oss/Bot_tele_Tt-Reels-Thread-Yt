import { prepareWhatsAppStatusAndroidHQ } from '../status-hq-android.js';
import { getTelegramFileSource, sendChatAction, sendMessage, sendVideoFileUpload, telegram } from '../telegram.js';
import { dispatchHeavyMediaJob, heavyVideoLimitBytes, heavyWorkerConfigured, shouldUseHeavyWorker } from '../heavy-worker-dispatch.js';
import { isJobFenceActive } from '../recovery.js';
import { MEDIA_STATUS_HQ_ANDROID, claimMediaButtons, galleryMediaMeta } from '../bot/media-actions.js';
import { localMediaLane } from '../bot/job-lanes.js';
import { removeHeavyProgress, startHeavyStatusProgress, startStatusProgress } from '../bot/progress.js';

function cancelled(fence) {
  return fence && !isJobFenceActive(fence);
}

export async function processStatusAndroidButton(callbackQuery, context = {}) {
  const action = String(callbackQuery?.data || '');
  if (!action.startsWith(MEDIA_STATUS_HQ_ANDROID)) return false;

  const fence = context.fence || null;
  const chatId = callbackQuery?.message?.chat?.id;
  const video = callbackQuery?.message?.video || null;
  const videoFileId = video?.file_id;
  const gallery = galleryMediaMeta(action, MEDIA_STATUS_HQ_ANDROID);
  const fileSize = Number(video?.file_size || gallery?.fileSize || 0);
  const heavyCandidate = Boolean(gallery && videoFileId && shouldUseHeavyWorker({ file_size: fileSize }));
  if (!chatId) return true;

  if (!gallery || !videoFileId) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Android Compatibility Beta buat masa ini untuk video Gallery sahaja.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  if (fileSize > heavyVideoLimitBytes()) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '❌ Buat masa ini video Gallery maksimum 500MB.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  if (heavyCandidate && !heavyWorkerConfigured()) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '⚠️ Worker 500MB belum aktif sepenuhnya.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  const claimed = await claimMediaButtons(callbackQuery);
  if (!claimed) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Pilihan ini dah digunakan. Hantar media semula untuk buat lagi.',
      show_alert: false,
    }).catch(() => {});
    return true;
  }

  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});
  if (cancelled(fence)) return true;

  if (heavyCandidate) {
    const progressMessage = await startHeavyStatusProgress(chatId);
    try {
      await dispatchHeavyMediaJob({
        chatId,
        videoFileId,
        fileSize,
        action: 'status_hq_android',
        sourceKind: 'gallery',
        progressMessageId: progressMessage?.message_id || 0,
        sourceMessageId: gallery.sourceMessageId,
      });
    } catch (error) {
      console.error('[status-hq/android/heavy] dispatch failed:', error?.code, error?.message);
      await removeHeavyProgress(chatId, progressMessage?.message_id);
      if (!cancelled(fence)) {
        await sendMessage(chatId, '❌ Android Compatibility Beta tak dapat dimulakan sekarang. Cuba lagi.').catch(() => {});
      }
    }
    return true;
  }

  await sendChatAction(chatId, 'upload_video').catch(() => {});
  let prepared = null;
  const progress = await startStatusProgress(chatId);
  try {
    const telegramVideo = await getTelegramFileSource(videoFileId);
    prepared = await localMediaLane(() => prepareWhatsAppStatusAndroidHQ({ video: telegramVideo }));
    if (cancelled(fence)) {
      await progress.remove();
      return true;
    }

    await progress.complete();
    await sendVideoFileUpload(
      chatId,
      prepared.filePath,
      'Video Android Beta ni dah ready untuk upload ke status ✅',
    );
    await progress.remove();
  } catch (error) {
    console.error('[status-hq/android] failed:', error?.code, error?.message);
    await progress.remove();
    if (!cancelled(fence)) {
      await sendMessage(chatId, '❌ Android Compatibility Beta tak dapat disiapkan. Hantar video semula dan cuba lagi.').catch(() => {});
    }
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }

  return true;
}
