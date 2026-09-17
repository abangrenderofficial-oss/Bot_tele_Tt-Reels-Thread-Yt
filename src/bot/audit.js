import { platformLabel } from '../platform.js';
import { sendMessage, telegram } from '../telegram.js';

const AUDIT_DELETE = 'audit:delete:v1';

function userFullName(from = {}) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || '-';
}

function formatAuditTime(unixSeconds) {
  const seconds = Number(unixSeconds || 0);
  if (!seconds) return new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour12: false });
  return new Date(seconds * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour12: false });
}

function auditDeleteButton(profileMessageId = '') {
  const extra = Number(profileMessageId || 0) > 0 ? `|${Number(profileMessageId)}` : '';
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '🗑️ Deleted', callback_data: `${AUDIT_DELETE}${extra}` }]],
    },
  };
}

function buildAuditCaption(from = {}, audit = {}) {
  const username = from.username ? `@${from.username}` : '-';
  const platform = audit.platform ? platformLabel(audit.platform) : '-';
  return [
    '📋 USER RECORD',
    `👤 Username: ${username}`,
    `🆔 Telegram ID: ${from.id || '-'}`,
    `📝 Nama: ${userFullName(from)}`,
    `🕒 Masa: ${formatAuditTime(audit.sourceTimestamp)}`,
    `📱 Platform: ${platform}`,
  ].join('\n').slice(0, 1024);
}

async function latestProfilePhotoFileId(userId) {
  if (!userId) return '';
  try {
    const result = await telegram('getUserProfilePhotos', { user_id: userId, offset: 0, limit: 1 });
    const sizes = result?.photos?.[0];
    return Array.isArray(sizes) && sizes.length ? String(sizes.at(-1)?.file_id || '') : '';
  } catch (error) {
    console.warn('Profile photo lookup failed:', error?.code, error?.message);
    return '';
  }
}

export async function mirrorMediaToGroup(sourceChatId, sentMessage, mirrorGroupId, from, audit = {}) {
  if (!mirrorGroupId || !sentMessage?.message_id) return false;
  if (String(sourceChatId) === String(mirrorGroupId)) return false;

  const caption = buildAuditCaption(from, audit);
  const profilePhotoId = await latestProfilePhotoFileId(from?.id);
  let profileMessageId = 0;

  try {
    if (profilePhotoId) {
      const profileMessage = await telegram('sendPhoto', { chat_id: mirrorGroupId, photo: profilePhotoId });
      profileMessageId = Number(profileMessage?.message_id || 0);
    }

    await telegram('copyMessage', {
      chat_id: mirrorGroupId,
      from_chat_id: sourceChatId,
      message_id: sentMessage.message_id,
      caption,
      ...auditDeleteButton(profileMessageId),
    });
    return true;
  } catch (error) {
    if (profileMessageId) {
      await telegram('deleteMessage', { chat_id: mirrorGroupId, message_id: profileMessageId }).catch(() => {});
    }
    console.warn('Group mirror failed:', error?.code, error?.message);
    return false;
  }
}

async function isGroupAdmin(chatId, userId) {
  if (!chatId || !userId) return false;
  try {
    const member = await telegram('getChatMember', { chat_id: chatId, user_id: userId });
    return member?.status === 'creator' || member?.status === 'administrator';
  } catch {
    return false;
  }
}

export async function processAuditDelete(callbackQuery) {
  const action = String(callbackQuery?.data || '');
  if (!action.startsWith(AUDIT_DELETE)) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  const userId = callbackQuery?.from?.id;
  const chatType = callbackQuery?.message?.chat?.type;
  if (!chatId || !messageId) return true;

  if (['group', 'supergroup'].includes(chatType) && !(await isGroupAdmin(chatId, userId))) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Hanya admin group boleh delete rekod ini.',
      show_alert: false,
    }).catch(() => {});
    return true;
  }

  const profileMessageId = Number(action.split('|')[1] || 0);
  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: 'Rekod dipadam.',
    show_alert: false,
  }).catch(() => {});
  await telegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  if (profileMessageId > 0 && profileMessageId !== Number(messageId)) {
    await telegram('deleteMessage', { chat_id: chatId, message_id: profileMessageId }).catch(() => {});
  }
  return true;
}

export async function setMirrorWebhook(baseUrl, mirrorGroupId = '', dropPendingUpdates = false) {
  if (!baseUrl) throw new Error('Public webhook base URL is unavailable.');
  const endpoint = new URL(`${baseUrl}/api/telegram`);
  if (mirrorGroupId) endpoint.searchParams.set('mirror_group', String(mirrorGroupId));
  await telegram('setWebhook', {
    url: endpoint.toString(),
    ...(process.env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET } : {}),
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    drop_pending_updates: Boolean(dropPendingUpdates),
  });
}

export async function handleConnectCommand(message, baseUrl, disconnect = false) {
  const chatId = message?.chat?.id;
  const chatType = message?.chat?.type;
  const userId = message?.from?.id;

  if (!['group', 'supergroup'].includes(chatType)) {
    await sendMessage(chatId, '❌ /connect hanya boleh digunakan di dalam group Telegram.');
    return;
  }
  if (!(await isGroupAdmin(chatId, userId))) {
    await sendMessage(chatId, '❌ Hanya admin group boleh guna command ini.');
    return;
  }

  try {
    await setMirrorWebhook(baseUrl, disconnect ? '' : chatId);
    await sendMessage(
      chatId,
      disconnect
        ? '✅ Group ini sudah disconnect daripada mirror bot.'
        : '✅ Connected. Mulai sekarang video yang user download melalui bot akan dicopy terus ke group ini bersama username user.',
    );
  } catch (error) {
    console.error('Connect webhook failed:', error?.message);
    await sendMessage(chatId, '❌ Tak berjaya connect group sekarang. Cuba sekali lagi.');
  }
}
