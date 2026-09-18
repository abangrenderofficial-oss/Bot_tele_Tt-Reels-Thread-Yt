import { prepareWhatsAppStatusAndroidHQ } from '../status-hq-android.js';
import { detectPlatform } from '../platform.js';
import { getTelegramFileSource, sendChatAction, sendMessage, sendVideoFileUpload, telegram } from '../telegram.js';
import { dispatchHeavyMediaJob, heavyVideoLimitBytes, heavyWorkerConfigured, shouldUseHeavyWorker } from '../heavy-worker-dispatch.js';
import { isJobFenceActive } from '../recovery.js';
import { chooseBestVideo, resolveMedia } from '../bot/media-resolver.js';
import {
  MEDIA_STATUS_HQ_ANDROID,
  callbackSourceUrl,
  claimMediaButtons,
  galleryMediaMeta,
} from '../bot/media-actions.js';
import { localMediaLane } from '../bot/job-lanes.js';
import { removeHeavyProgress, startHeavyStatusProgress, startStatusProgress } from '../bot/progress.js';

function cancelled(fence) {
  return fence && !isJobFenceActive(fence);
}

async function prepareAndroidFromSocialSource(sourceUrl) {
  const platform = detectPlatform(sourceUrl);
  if (!platform) {
    const error = new Error('Android Beta could not detect the social source platform.');
    error.code = 'STATUS_ANDROID_PLATFORM_UNKNOWN';
    throw error;
  }

  const media = await resolveMedia(platform, sourceUrl);
  const best = chooseBestVideo(media?.videos || []);
  if (!best?.url) {
    const error = new Error('Android Beta could not resolve a usable social source video.');
    error.code = 'STATUS_ANDROID_SOURCE_NOT_FOUND';
    throw error;
  }

  return prepareWhatsAppStatusAndroidHQ({ video: best, sourceUrl, platform });
}

export async function processStatusAndroidButton(callbackQuery, context = {}) {
  const action = String(callbackQuery?.data || '');
  if (!action.startsWith(MEDIA_STATUS_HQ_ANDROID)) return false;

  const fence = context.fence || null;
  const chatId = callbackQuery?.message?.chat?.id;
  const video = callbackQuery?.message?.video || null;
  const videoFileId = video?.file_id;
  const caption = callbackQuery?.message?.caption || '';
  const gallery = galleryMediaMeta(action, MEDIA_STATUS_HQ_ANDROID);
  const sourceUrl = gallery ? '' : callbackSourceUrl(action, MEDIA_STATUS_HQ_ANDROID, caption);
  const fileSize = Number(video?.file_size || gallery?.fileSize || 0);
  const heavyCandidate = Boolean(gallery && videoFileId && shouldUseHeavyWorker({ file_size: fileSize }));
  if (!chatId) return true;

  if (!videoFileId) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Android Compatibility Beta hanya untuk video.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  if (fileSize > heavyVideoLimitBytes()) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '❌ Buat masa ini video maksimum 500MB.',
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
    prepared = await localMediaLane(async () => {
      let socialSourceError = null;

      // Social-link videos must prefer the original social source. Telegram's
      // cloud Bot API getFile path can reject videos above its download limit
      // even though the video message itself was delivered successfully.
      if (!gallery && sourceUrl) {
        try {
          return await prepareAndroidFromSocialSource(sourceUrl);
        } catch (error) {
          socialSourceError = error;
          console.warn(
            '[status-hq/android] social source failed, trying Telegram file fallback:',
            error?.code,
            error?.message,
          );
        }
      }

      try {
        const telegramVideo = await getTelegramFileSource(videoFileId);
        return await prepareWhatsAppStatusAndroidHQ({ video: telegramVideo });
      } catch (telegramFileError) {
        console.warn(
          '[status-hq/android] Telegram fallback failed:',
          telegramFileError?.code,
          telegramFileError?.message,
        );
        if (socialSourceError) throw socialSourceError;
        throw telegramFileError;
      }
    });

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
      await sendMessage(chatId, '❌ Android Compatibility Beta tak dapat disiapkan. Hantar video/link semula dan cuba lagi.').catch(() => {});
    }
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }

  return true;
}
