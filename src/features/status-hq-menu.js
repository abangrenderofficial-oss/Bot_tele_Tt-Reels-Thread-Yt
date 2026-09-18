import { telegram } from '../telegram.js';
import {
  MEDIA_STATUS_HQ,
  MEDIA_STATUS_HQ_MENU,
  callbackSourceUrl,
  galleryMediaMeta,
  galleryStatusProfileButtons,
  socialStatusProfileButtons,
} from '../bot/media-actions.js';

function profileMenuAlreadyOpen(callbackQuery) {
  const rows = callbackQuery?.message?.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return false;
  return rows.flat().some((button) => {
    const text = String(button?.text || '');
    return text.includes('Standard HQ') || text.includes('Android Compatibility');
  });
}

export async function processStatusProfileMenu(callbackQuery) {
  const action = String(callbackQuery?.data || '');
  const directMenu = action.startsWith(MEDIA_STATUS_HQ_MENU);
  const legacyGallery = galleryMediaMeta(action, MEDIA_STATUS_HQ);
  const isVideo = Boolean(callbackQuery?.message?.video?.file_id);
  const legacySocial = Boolean(
    !directMenu
    && !legacyGallery
    && isVideo
    && action.startsWith(MEDIA_STATUS_HQ)
    && !profileMenuAlreadyOpen(callbackQuery)
  );

  // Backward compatibility:
  // - old Gallery messages used MEDIA_STATUS_HQ directly;
  // - old social-video messages also used MEDIA_STATUS_HQ directly.
  // Both are upgraded into the chooser. Once the chooser is visible, the
  // Standard HQ button is allowed to fall through to the encoder handler.
  if (!directMenu && !legacyGallery && !legacySocial) return false;
  if (!directMenu && legacyGallery && profileMenuAlreadyOpen(callbackQuery)) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  const caption = callbackQuery?.message?.caption || '';
  const gallery = directMenu
    ? galleryMediaMeta(action, MEDIA_STATUS_HQ_MENU)
    : legacyGallery;

  if (!chatId || !messageId || (!gallery && !isVideo)) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery?.id,
      text: 'Pilihan Status HQ ni dah tak valid. Hantar video semula.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  const sourceUrl = gallery
    ? ''
    : callbackSourceUrl(
      action,
      directMenu ? MEDIA_STATUS_HQ_MENU : MEDIA_STATUS_HQ,
      caption,
    );

  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});
  await telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: gallery
      ? galleryStatusProfileButtons(gallery.sourceMessageId, gallery.fileSize)
      : socialStatusProfileButtons(sourceUrl),
  }).catch(async (error) => {
    console.warn('[status-hq/menu] profile menu failed:', error?.code, error?.message);
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Tak dapat buka profile Status HQ. Hantar video semula dan cuba lagi.',
      show_alert: true,
    }).catch(() => {});
  });

  return true;
}
