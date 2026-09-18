import { telegram } from '../telegram.js';
import {
  MEDIA_STATUS_HQ_MENU,
  galleryMediaMeta,
  galleryStatusProfileButtons,
} from '../bot/media-actions.js';

export async function processStatusProfileMenu(callbackQuery) {
  const action = String(callbackQuery?.data || '');
  if (!action.startsWith(MEDIA_STATUS_HQ_MENU)) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  const gallery = galleryMediaMeta(action, MEDIA_STATUS_HQ_MENU);

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
