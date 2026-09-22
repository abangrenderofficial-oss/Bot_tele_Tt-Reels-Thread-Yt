import { prepareWhatsAppStatusHQ } from '../status-hq.js';
import { prepareWhatsAppStatusImageHQ } from '../status-image-hq.js';
import { detectPlatform } from '../platform.js';
import { getTelegramFileSource, sendChatAction, sendMessage, sendVideoFileUpload, telegram } from '../telegram.js';
import { dispatchHeavyMediaJob, heavyVideoLimitBytes, heavyWorkerConfigured, shouldUseHeavyWorker } from '../heavy-worker-dispatch.js';
import { isJobFenceActive } from '../recovery.js';
import { chooseBestVideo, resolveMedia } from '../bot/media-resolver.js';
import {
  MEDIA_STATUS_HQ,
  callbackSourceUrl,
  claimMediaButtons,
  galleryMediaMeta,
} from '../bot/media-actions.js';
import { localMediaLane } from '../bot/job-lanes.js';
import { removeHeavyProgress, startHeavyStatusProgress, startImageStatusProgress, startStatusProgress } from '../bot/progress.js';
import { sendDocumentFileUpload } from '../bot/telegram-document.js';
import { statusImageCaption, statusVideoCaption } from '../bot/status-caption.js';

function cancelled(fence) {
  return fence && !isJobFenceActive(fence);
}

async function prepareStatusFromSourceUrl(url, platform) {
  if (platform === 'youtube') {
    return prepareWhatsAppStatusHQ({ sourceUrl: url, platform, video: null, audio: null });
  }

  const media = await resolveMedia(platform, url);
  const best = chooseBestVideo(media?.videos || []);
  if (!best) {
    const error = new Error('No suitable source video for Status HQ.');
    error.code = 'STATUS_SOURCE_NOT_FOUND';
    throw error;
  }
  const audio = Array.isArray(media?.audios)
    ? media.audios.find((item) => item?.url) || null
    : null;
  return prepareWhatsAppStatusHQ({ sourceUrl: url, platform, video: best, audio });
}

export async function processStatusFromLink(chatId, url, platform, fence = null) {
  let prepared = null;
  const progress = await startStatusProgress(chatId);
  try {
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    prepared = await localMediaLane(() => prepareStatusFromSourceUrl(url, platform), chatId);
    if (cancelled(fence)) {
      await progress.remove();
      return false;
    }
    await progress.complete();
    await sendVideoFileUpload(chatId, prepared.filePath, await statusVideoCaption());
    await progress.remove();
    return true;
  } catch (error) {
    console.error('[status-hq/link] failed:', error?.code, error?.message);
    await progress.remove();
    if (!cancelled(fence)) {
      await sendMessage(chatId, '❌ Status HQ tak dapat disiapkan untuk link ini. Cuba semula kemudian.').catch(() => {});
    }
    return false;
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
}

export async function processStatusButton(callbackQuery, context = {}) {
  const action = String(callbackQuery?.data || '');
  if (!action.startsWith(MEDIA_STATUS_HQ)) return false;

  const fence = context.fence || null;
  const chatId = callbackQuery?.message?.chat?.id;
  const video = callbackQuery?.message?.video || null;
  const videoFileId = video?.file_id;
  const imageFileId = Array.isArray(callbackQuery?.message?.photo)
    ? callbackQuery.message.photo.at(-1)?.file_id
    : '';
  const isImage = Boolean(imageFileId && !videoFileId);
  const fileId = videoFileId || imageFileId;
  const caption = callbackQuery?.message?.caption || '';
  const sourceUrl = callbackSourceUrl(action, MEDIA_STATUS_HQ, caption);
  const sourcePlatform = sourceUrl ? detectPlatform(sourceUrl) : null;
  const gallery = galleryMediaMeta(action, MEDIA_STATUS_HQ);
  const fileSize = Number(video?.file_size || gallery?.fileSize || 0);
  const heavyCandidate = Boolean(!isImage && gallery && videoFileId && shouldUseHeavyWorker({ file_size: fileSize }));
  if (!chatId) return true;

  if (gallery && fileSize > heavyVideoLimitBytes()) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Sorry, you can only upload videos up to 150 MB.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  if (heavyCandidate && !heavyWorkerConfigured()) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '⚠️ Large video worker is not available right now.',
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
        action: 'status_hq',
        progressMessageId: progressMessage?.message_id || 0,
        sourceMessageId: gallery.sourceMessageId,
      });
      return { premiumVideoCompleted: true };
    } catch (error) {
      console.error('[status-hq/heavy] dispatch failed:', error?.code, error?.message);
      await removeHeavyProgress(chatId, progressMessage?.message_id);
      if (!cancelled(fence)) {
        await sendMessage(chatId, '❌ Worker video besar tak dapat dimulakan sekarang. Cuba lagi.').catch(() => {});
      }
    }
    return true;
  }

  await sendChatAction(chatId, isImage ? 'upload_document' : 'upload_video').catch(() => {});
  let prepared = null;
  let premiumVideoCompleted = false;
  const progress = await (isImage ? startImageStatusProgress(chatId) : startStatusProgress(chatId));
  try {
    if (!fileId) throw new Error('Media file_id missing from callback message.');

    if (isImage) {
      const telegramImage = await getTelegramFileSource(fileId);
      prepared = await localMediaLane(() => prepareWhatsAppStatusImageHQ({ image: telegramImage }), chatId);
      if (cancelled(fence)) {
        await progress.remove();
        return true;
      }
      await progress.complete();
      await sendDocumentFileUpload(chatId, prepared.filePath, await statusImageCaption(), 'status-hq.jpg');
      premiumVideoCompleted = true;
    } else {
      prepared = await localMediaLane(async () => {
        let sourceError = null;

        if (sourceUrl && sourcePlatform) {
          try {
            return await prepareStatusFromSourceUrl(sourceUrl, sourcePlatform);
          } catch (error) {
            sourceError = error;
            console.warn('[status-hq] Original source failed, trying Telegram copy:', error?.code, error?.message);
          }
        }

        try {
          const telegramVideo = await getTelegramFileSource(fileId);
          return await prepareWhatsAppStatusHQ({ sourceUrl: '', platform: 'telegram', video: telegramVideo, audio: null });
        } catch (telegramError) {
          if (sourceError) throw sourceError;
          throw telegramError;
        }
      }, chatId);
      if (cancelled(fence)) {
        await progress.remove();
        return true;
      }
      await progress.complete();
      await sendVideoFileUpload(chatId, prepared.filePath, await statusVideoCaption());
      premiumVideoCompleted = true;
    }

    await progress.remove();
  } catch (error) {
    console.error('[status-hq/button] failed:', error?.code, error?.message);
    await progress.remove();
    if (!cancelled(fence)) {
      await sendMessage(
        chatId,
        isImage
          ? '❌ Status HQ tak dapat disiapkan untuk gambar ini. Hantar gambar semula dan cuba lagi.'
          : '❌ Status HQ tak dapat disiapkan untuk video ini. Hantar video/link semula dan cuba lagi.',
      ).catch(() => {});
    }
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
  return premiumVideoCompleted ? { premiumVideoCompleted: true } : true;
}
