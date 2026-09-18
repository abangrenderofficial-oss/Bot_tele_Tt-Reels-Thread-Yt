import { dispatchHeavyMediaJob, heavyVideoLimitBytes, heavyWorkerConfigured } from '../heavy-worker-dispatch.js';
import { isJobFenceActive } from '../recovery.js';
import { sendMessage, telegram } from '../telegram.js';
import {
  MEDIA_LIVE_BACK,
  MEDIA_LIVE_CHANGE_SPEED,
  MEDIA_LIVE_CREATE,
  MEDIA_LIVE_PREVIEW,
  MEDIA_LIVE_SPEED,
  MEDIA_LIVE_WALLPAPER,
  claimMediaButtons,
  galleryMediaActionButtons,
  galleryMediaMeta,
  liveWallpaperSelectedButtons,
  liveWallpaperSpeedButtons,
  liveWallpaperSpeedFromAction,
} from '../bot/media-actions.js';
import {
  removeHeavyProgress,
  startHeavyLivePreviewProgress,
  startHeavyLiveProgress,
} from '../bot/progress.js';

function cancelled(fence) {
  return fence && !isJobFenceActive(fence);
}

function isOpenEditorAction(action) {
  return action === MEDIA_LIVE_WALLPAPER || action.startsWith(`${MEDIA_LIVE_WALLPAPER}|`);
}

function isLiveWallpaperAction(action) {
  return isOpenEditorAction(action)
    || action === MEDIA_LIVE_CHANGE_SPEED
    || action === MEDIA_LIVE_BACK
    || action.startsWith(`${MEDIA_LIVE_SPEED}:`)
    || action.startsWith(`${MEDIA_LIVE_PREVIEW}:`)
    || action.startsWith(`${MEDIA_LIVE_CREATE}:`);
}

async function answer(callbackQuery, text = '', showAlert = false) {
  if (!callbackQuery?.id) return;
  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    ...(text ? { text } : {}),
    ...(showAlert ? { show_alert: true } : {}),
  }).catch(() => {});
}

async function replaceButtons(callbackQuery, actions) {
  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  if (!chatId || !messageId) return false;

  try {
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: actions.reply_markup,
    });
    return true;
  } catch (error) {
    console.warn('[live-wallpaper] button edit failed:', error?.code, error?.message);
    return false;
  }
}

export async function processLiveWallpaperButton(callbackQuery, context = {}) {
  const action = String(callbackQuery?.data || '');
  if (!isLiveWallpaperAction(action)) return false;

  const fence = context.fence || null;
  const chatId = callbackQuery?.message?.chat?.id;
  const video = callbackQuery?.message?.video || null;
  const fileId = video?.file_id;
  const callbackMessageId = Math.max(0, Number(callbackQuery?.message?.message_id || 0));
  const gallery = isOpenEditorAction(action)
    ? galleryMediaMeta(action, MEDIA_LIVE_WALLPAPER)
    : null;
  const fileSize = Number(video?.file_size || gallery?.fileSize || 0);
  if (!chatId) return true;

  if (action === MEDIA_LIVE_BACK) {
    await replaceButtons(callbackQuery, galleryMediaActionButtons(callbackMessageId, fileSize));
    await answer(callbackQuery);
    return true;
  }

  if (!fileId) {
    await answer(
      callbackQuery,
      '❌ Video untuk Live Wallpaper tak dijumpai. Hantar video semula.',
      true,
    );
    return true;
  }

  if (fileSize > heavyVideoLimitBytes()) {
    await answer(callbackQuery, '❌ Buat masa ini video Gallery maksimum 500MB.', true);
    return true;
  }

  if (isOpenEditorAction(action) || action === MEDIA_LIVE_CHANGE_SPEED) {
    await replaceButtons(callbackQuery, liveWallpaperSpeedButtons());
    await answer(callbackQuery, 'Pilih speed motion dulu.');
    return true;
  }

  const selected = action.startsWith(`${MEDIA_LIVE_SPEED}:`)
    ? liveWallpaperSpeedFromAction(action, MEDIA_LIVE_SPEED)
    : null;
  if (selected) {
    await replaceButtons(callbackQuery, liveWallpaperSelectedButtons(selected));
    await answer(
      callbackQuery,
      `Speed ${selected.label} dipilih. Preview dulu atau terus Create.`,
    );
    return true;
  }

  const previewSpeed = action.startsWith(`${MEDIA_LIVE_PREVIEW}:`)
    ? liveWallpaperSpeedFromAction(action, MEDIA_LIVE_PREVIEW)
    : null;
  const createSpeed = action.startsWith(`${MEDIA_LIVE_CREATE}:`)
    ? liveWallpaperSpeedFromAction(action, MEDIA_LIVE_CREATE)
    : null;

  if (!previewSpeed && !createSpeed) {
    await answer(callbackQuery, 'Pilihan speed tak sah. Pilih semula.', true);
    await replaceButtons(callbackQuery, liveWallpaperSpeedButtons());
    return true;
  }

  if (!heavyWorkerConfigured()) {
    await answer(callbackQuery, '⚠️ Apple Live Photo worker belum aktif sepenuhnya.', true);
    return true;
  }

  if (previewSpeed) {
    await answer(callbackQuery, `Preview ${previewSpeed.label} sedang dibuat.`);
    if (cancelled(fence)) return true;

    const progressMessage = await startHeavyLivePreviewProgress(chatId);
    try {
      await dispatchHeavyMediaJob({
        chatId,
        videoFileId: fileId,
        fileSize,
        action: 'live_preview',
        speed: previewSpeed.value,
        progressMessageId: progressMessage?.message_id || 0,
        sourceMessageId: callbackMessageId,
      });
    } catch (error) {
      console.error('[live-wallpaper/preview] dispatch failed:', error?.code, error?.message);
      await removeHeavyProgress(chatId, progressMessage?.message_id);
      if (!cancelled(fence)) {
        await sendMessage(chatId, '❌ Preview motion tak dapat dibuat sekarang. Cuba lagi.').catch(() => {});
      }
    }
    return true;
  }

  const claimed = await claimMediaButtons(callbackQuery);
  if (!claimed) {
    await answer(
      callbackQuery,
      'Pilihan ini dah digunakan. Hantar video semula untuk buat lagi.',
      false,
    );
    return true;
  }

  await answer(callbackQuery);
  if (cancelled(fence)) return true;

  const progressMessage = await startHeavyLiveProgress(chatId);
  try {
    await dispatchHeavyMediaJob({
      chatId,
      videoFileId: fileId,
      fileSize,
      action: 'live_wallpaper',
      speed: createSpeed.value,
      progressMessageId: progressMessage?.message_id || 0,
      sourceMessageId: callbackMessageId,
    });
  } catch (error) {
    console.error('[live-wallpaper/create] dispatch failed:', error?.code, error?.message);
    await removeHeavyProgress(chatId, progressMessage?.message_id);
    await replaceButtons(callbackQuery, liveWallpaperSelectedButtons(createSpeed));
    if (!cancelled(fence)) {
      await sendMessage(chatId, '❌ Apple Live Photo worker tak dapat dimulakan sekarang. Cuba lagi.').catch(() => {});
    }
  }
  return true;
}
