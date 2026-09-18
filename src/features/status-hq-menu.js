import { telegram } from '../telegram.js';
import {
  MEDIA_STATUS_HQ,
  MEDIA_STATUS_HQ_MENU,
  galleryMediaMeta,
  galleryStatusProfileButtons,
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

  // Backward compatibility: Gallery messages created before the profile chooser
  // used MEDIA_STATUS_HQ directly. Open the chooser for those old buttons too,
  // but let the Standard HQ button inside an already-open chooser fall through
  // to the normal Status HQ handler.
  if (!directMenu && (!legacyGallery || profileMenuAlreadyOpen(callbackQuery))) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  const gallery = directMenu
    ? galleryMediaMeta(action, MEDIA_STATUS_HQ_MENU)
    : legacyGallery;

  if (!chatId || !messageId || !gallery) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery?.id,
      text: 'Pilihan Status HQ ni dah tak valid. Hantar video semula.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});
  await telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: galleryStatusProfileButtons(gallery.sourceMessageId, gallery.fileSize),
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
