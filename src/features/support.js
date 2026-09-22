import { createSupportOrderNumber, createSupportPayment, isBayarcashConfigured } from '../payments/bayarcash.js';
import { createPendingSupport, markSupportIntentCreated, markSupportIntentFailed } from '../support/store.js';
import { sendMessage, telegram } from '../telegram.js';

const SUPPORT_SELECT_PREFIX = 'support:select:';
const SUPPORT_AMOUNTS_ACTION = 'support:amounts';
const SUPPORT_BACK_ACTION = 'support:back';
const SUPPORT_AMOUNTS = new Set([3, 5, 10, 20, 50]);

function amountFromCallback(action = '') {
  if (!String(action).startsWith(SUPPORT_SELECT_PREFIX)) return null;
  const amount = Number(String(action).slice(SUPPORT_SELECT_PREFIX.length));
  return SUPPORT_AMOUNTS.has(amount) ? amount : null;
}

function supportMenuText() {
  return [
    '❤️ Support Abang Render',
    '',
    'Kalau bot ni membantu, boleh support sedikit untuk kos server & development. Terima kasih sebab guna bot ni 🤍',
    ...(!isBayarcashConfigured() ? ['', '⚙️ Payment gateway tengah disediakan. Cuba lagi kejap nanti.'] : []),
  ].join('\n');
}

function supportMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'RM3', callback_data: `${SUPPORT_SELECT_PREFIX}3` },
        { text: 'RM5', callback_data: `${SUPPORT_SELECT_PREFIX}5` },
        { text: 'RM10', callback_data: `${SUPPORT_SELECT_PREFIX}10` },
      ],
      [
        { text: 'RM20', callback_data: `${SUPPORT_SELECT_PREFIX}20` },
        { text: 'RM50', callback_data: `${SUPPORT_SELECT_PREFIX}50` },
      ],
      [{ text: '↩️ Back', callback_data: SUPPORT_BACK_ACTION }],
    ],
  };
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

export async function handleSupportCommand(message = {}) {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  if (!chatId || !userId) return true;

  await sendMessage(chatId, supportMenuText(), {
    reply_markup: supportMenuKeyboard(),
  });
  return true;
}

export async function processSupportCallback(callbackQuery = {}, context = {}) {
  const action = String(callbackQuery?.data || '');
  const amount = amountFromCallback(action);
  const isSupportAction = Boolean(amount)
    || action === SUPPORT_AMOUNTS_ACTION
    || action === SUPPORT_BACK_ACTION;
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

  await answerSupportCallback(callbackQuery, `Preparing RM${amount} support...`);

  if (!isBayarcashConfigured()) {
    await editSupportMessage(
      callbackQuery,
      '⚙️ Payment gateway tengah disediakan. Cuba lagi kejap nanti.',
      { inline_keyboard: [[{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }]] },
    );
    return true;
  }

  const orderNumber = createSupportOrderNumber();
  await createPendingSupport({
    orderNumber,
    userId: user.id,
    username: user.username || '',
    amount,
  });

  try {
    const payment = await createSupportPayment({
      amount,
      user,
      publicBaseUrl: context.baseUrl,
      orderNumber,
    });
    await markSupportIntentCreated(orderNumber, payment.paymentIntentId);

    const edited = await editSupportMessage(
      callbackQuery,
      [
        `❤️ Support RM${amount}`,
        '',
        'Thank you korang 🤍',
      ].join('\n'),
      {
        inline_keyboard: [
          [{ text: `💳 Bayar RM${amount}`, url: payment.url }],
          [{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }],
        ],
      },
    );

    if (!edited) {
      await sendMessage(
        chatId,
        [`❤️ Support RM${amount}`, '', 'Thank you korang 🤍'].join('\n'),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: `💳 Bayar RM${amount}`, url: payment.url }],
              [{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }],
            ],
          },
        },
      );
    }
  } catch (error) {
    await markSupportIntentFailed(orderNumber, error?.code || 'UNKNOWN').catch(() => {});
    console.error('[support] checkout failed:', error?.code, error?.status, error?.message, error?.details || '');

    const errorText = error?.code === 'BAYARCASH_PAYER_EMAIL_REQUIRED'
      ? '⚙️ Support payment belum ready sepenuhnya. Admin tengah lengkapkan email payment gateway.'
      : '❌ Payment page tak dapat dibuat sekarang. Cuba semula kejap lagi.';

    await editSupportMessage(
      callbackQuery,
      errorText,
      { inline_keyboard: [[{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }]] },
    );
  }

  return true;
}
