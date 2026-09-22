import { createSupportOrderNumber, createSupportPayment, isBayarcashConfigured } from '../payments/bayarcash.js';
import { createPendingSupport, markSupportIntentCreated, markSupportIntentFailed } from '../support/store.js';
import {
  cancelSupportSubmission,
  createSupportSubmission,
  getActiveSupportSubmission,
  markSupportSubmissionCheckout,
  setSupportSubmissionMessage,
  setSupportSubmissionName,
} from '../support/submissions.js';
import { sendMessage, telegram } from '../telegram.js';

const SUPPORT_SELECT_PREFIX = 'support:select:';
const SUPPORT_AMOUNTS_ACTION = 'support:amounts';
const SUPPORT_BACK_ACTION = 'support:back';
const SUPPORT_CANCEL_PREFIX = 'support:cancel:';
const SUPPORT_AMOUNTS = new Set([10, 20, 30, 50, 100]);

const SUPPORT_TIERS = new Map([
  [10, { key: 'supporter', label: '🤍 Supporter' }],
  [20, { key: 'super', label: '🌟 Super Supporter' }],
  [30, { key: 'power', label: '💎 Power Supporter' }],
  [50, { key: 'ultimate', label: '🏆 Ultimate Supporter' }],
  [100, { key: 'legend', label: '👑 Legend Supporter' }],
]);

function amountFromCallback(action = '') {
  if (!String(action).startsWith(SUPPORT_SELECT_PREFIX)) return null;
  const amount = Number(String(action).slice(SUPPORT_SELECT_PREFIX.length));
  return SUPPORT_AMOUNTS.has(amount) ? amount : null;
}

function tierForAmount(amount) {
  return SUPPORT_TIERS.get(Number(amount)) || { key: 'supporter', label: '🤍 Supporter' };
}

function supportMenuText() {
  return [
    '❤️Selamatkan Bot kita !',
    '',
    'Hi korang, best tak guna bot ni? Utk pengetahuan korang. Bot ni adalah bot kita semua. Hak kita semua.',
    '',
    'Tapi sayang, bot ni untuk kekal hidup kita kena bayarkan kos sewa server utk dia. Jom kita saling membantu hidupkan bot ni nak? Sekali seumur hidup pun tak apa. Terima kasih orang baik !🤍',
    '',
    'Korang boleh pilih amount yg korang mampu and tinggalkan kata2 support 🙇🏻',
    ...(!isBayarcashConfigured() ? ['', '⚙️ Payment gateway tengah disediakan. Cuba lagi kejap nanti.'] : []),
  ].join('\n');
}

function supportMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'RM10', callback_data: `${SUPPORT_SELECT_PREFIX}10` },
        { text: 'RM20', callback_data: `${SUPPORT_SELECT_PREFIX}20` },
        { text: 'RM30', callback_data: `${SUPPORT_SELECT_PREFIX}30` },
      ],
      [
        { text: 'RM50', callback_data: `${SUPPORT_SELECT_PREFIX}50` },
        { text: 'RM100', callback_data: `${SUPPORT_SELECT_PREFIX}100` },
      ],
      [{ text: '↩️ Back', callback_data: SUPPORT_BACK_ACTION }],
    ],
  };
}

function containsLink(text = '') {
  return /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i.test(String(text));
}

function cleanInput(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function editSupportMessage(callbackQuery, text, replyMarkup) {
  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  if (!chatId || !messageId) return false;

  try {
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
    return true;
  } catch (error) {
    if (String(error?.message || '').includes('message is not modified')) return true;
    console.warn('[support] edit message failed:', error?.message);
    return false;
  }
}

async function answerSupportCallback(callbackQuery, text = '') {
  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery?.id,
    ...(text ? { text } : {}),
    show_alert: false,
  }).catch(() => {});
}

async function prepareCheckout(message, submission, context = {}) {
  const chatId = message?.chat?.id;
  const user = message?.from || {};
  const amount = Number(submission?.amount || 0);
  if (!chatId || !user?.id || !amount) return true;

  if (!isBayarcashConfigured()) {
    await sendMessage(chatId, '⚙️ Payment gateway tengah disediakan. Cuba lagi kejap nanti.');
    return true;
  }

  try {
    await createPendingSupport({
      orderNumber: submission.orderNumber,
      userId: user.id,
      username: user.username || '',
      amount,
    });

    const payment = await createSupportPayment({
      amount,
      user,
      publicBaseUrl: context.baseUrl,
      orderNumber: submission.orderNumber,
    });
    await markSupportIntentCreated(submission.orderNumber, payment.paymentIntentId);
    await markSupportSubmissionCheckout(submission.orderNumber, payment.url, payment.paymentIntentId);

    await sendMessage(
      chatId,
      [
        `🤍 Support RM${amount} — ${submission.tierLabel}`,
        '',
        'Nama & kata2 support dah diterima 🙇🏻',
        'Tekan Submit di bawah untuk buka QR & buat payment.',
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ Submit & Bayar RM${amount}`, url: payment.url }],
            [{ text: '❌ Batal', callback_data: `${SUPPORT_CANCEL_PREFIX}${submission.orderNumber}` }],
          ],
        },
      },
    );
  } catch (error) {
    await markSupportIntentFailed(submission.orderNumber, error?.code || 'UNKNOWN').catch(() => {});
    console.error('[support] checkout failed:', error?.code, error?.status, error?.message, error?.details || '');
    await sendMessage(
      chatId,
      error?.code === 'BAYARCASH_PAYER_EMAIL_REQUIRED'
        ? '⚙️ Support payment belum ready sepenuhnya. Admin tengah lengkapkan email payment gateway.'
        : '❌ Payment page tak dapat dibuat sekarang. Cuba /support semula kejap lagi.',
    ).catch(() => {});
  }

  return true;
}

export async function handleSupportCommand(message = {}) {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  if (!chatId || !userId) return true;

  await sendMessage(chatId, supportMenuText(), {
    reply_markup: supportMenuKeyboard(),
  });
  return true;
}

export async function processSupportMessage(message = {}, context = {}) {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  if (!chatId || !userId || message?.chat?.type !== 'private') return false;

  const submission = await getActiveSupportSubmission(userId).catch((error) => {
    console.warn('[support] active submission lookup failed:', error?.message);
    return null;
  });
  if (!submission) return false;

  const rawText = String(message?.text || '').trim();
  if (rawText.toLowerCase() === '/cancel') {
    await cancelSupportSubmission(submission.orderNumber, userId).catch(() => {});
    await sendMessage(chatId, '❌ Support dibatalkan. Bila2 nak support, tekan /support ya 🤍');
    return true;
  }

  if (!rawText) {
    await sendMessage(chatId, submission.state === 'AWAITING_MESSAGE'
      ? 'Sila hantar kata2 support dalam bentuk text ya 🙇🏻'
      : 'Sila tulis nama dalam bentuk text ya 🙇🏻');
    return true;
  }

  if (submission.state === 'AWAITING_MESSAGE') {
    const supportMessage = cleanInput(rawText);
    if (supportMessage.length < 2) {
      await sendMessage(chatId, 'Ayat tu pendek sangat 😅 Cuba tulis kata2 support sikit ya.');
      return true;
    }
    if (supportMessage.length > 300) {
      await sendMessage(chatId, 'Kata2 support max 300 aksara ya. Pendekkan sikit 🙇🏻');
      return true;
    }
    if (containsLink(supportMessage)) {
      await sendMessage(chatId, 'Kata2 support tak boleh ada link ya 🙇🏻 Cuba hantar ayat tanpa link.');
      return true;
    }

    await setSupportSubmissionMessage(submission.orderNumber, userId, supportMessage);
    await sendMessage(
      chatId,
      [
        '✍🏻 Sekarang tulis nama yang korang nak paparkan bersama kata2 support tadi.',
        '',
        'Contoh: Amir',
      ].join('\n'),
    );
    return true;
  }

  if (submission.state === 'AWAITING_NAME') {
    const displayName = cleanInput(rawText);
    if (!displayName || displayName.length > 60) {
      await sendMessage(chatId, 'Nama mestilah 1–60 aksara ya 🙇🏻');
      return true;
    }
    if (containsLink(displayName) || displayName.startsWith('/')) {
      await sendMessage(chatId, 'Tulis nama sahaja ya, tanpa link atau command 🙇🏻');
      return true;
    }

    const updated = await setSupportSubmissionName(submission.orderNumber, userId, displayName);
    return prepareCheckout(message, updated || { ...submission, displayName }, context);
  }

  return false;
}

export async function processSupportCallback(callbackQuery = {}, context = {}) {
  const action = String(callbackQuery?.data || '');
  const amount = amountFromCallback(action);
  const isCancel = action.startsWith(SUPPORT_CANCEL_PREFIX);
  const isSupportAction = Boolean(amount)
    || action === SUPPORT_AMOUNTS_ACTION
    || action === SUPPORT_BACK_ACTION
    || isCancel;
  if (!isSupportAction) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  const user = callbackQuery?.from || {};
  if (!chatId || !user?.id) return true;

  if (action === SUPPORT_BACK_ACTION) {
    await answerSupportCallback(callbackQuery);
    if (messageId) {
      await telegram('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => {});
    }
    return true;
  }

  if (action === SUPPORT_AMOUNTS_ACTION) {
    await answerSupportCallback(callbackQuery);
    await editSupportMessage(callbackQuery, supportMenuText(), supportMenuKeyboard());
    return true;
  }

  if (isCancel) {
    const orderNumber = action.slice(SUPPORT_CANCEL_PREFIX.length);
    await cancelSupportSubmission(orderNumber, user.id).catch(() => {});
    await answerSupportCallback(callbackQuery, 'Support dibatalkan.');
    await editSupportMessage(
      callbackQuery,
      '❌ Support dibatalkan.\n\nBila2 nak support, tekan /support ya 🤍',
      { inline_keyboard: [] },
    );
    return true;
  }

  const tier = tierForAmount(amount);
  await answerSupportCallback(callbackQuery, `${tier.label} dipilih!`);

  if (!isBayarcashConfigured()) {
    await editSupportMessage(
      callbackQuery,
      '⚙️ Payment gateway tengah disediakan. Cuba lagi kejap nanti.',
      { inline_keyboard: [[{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }]] },
    );
    return true;
  }

  const orderNumber = createSupportOrderNumber();
  try {
    await createSupportSubmission({
      orderNumber,
      userId: user.id,
      username: user.username || '',
      amount,
      tierKey: tier.key,
      tierLabel: tier.label,
    });

    await editSupportMessage(
      callbackQuery,
      [
        `🤍 Support RM${amount} di pilih - ${tier.label}!`,
        '',
        'Sila tulis kata2 support 🙇🏻',
        '',
        'Kata2 ni akan dipaparkan di channel selepas payment berjaya.',
      ].join('\n'),
      {
        inline_keyboard: [
          [{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }],
        ],
      },
    );
  } catch (error) {
    console.error('[support] submission start failed:', error?.message);
    await editSupportMessage(
      callbackQuery,
      '❌ Tak dapat mula support sekarang. Cuba /support sekali lagi.',
      { inline_keyboard: [[{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }]] },
    );
  }

  return true;
}
