import { createSupportOrderNumber, createSupportPayment, isBayarcashConfigured } from '../payments/bayarcash.js';
import { createPendingSupport, markSupportIntentCreated, markSupportIntentFailed } from '../support/store.js';
import { createSupportSubmission, markSupportSubmissionCheckout } from '../support/submissions.js';
import { sendMessage, telegram } from '../telegram.js';

const SUPPORT_SELECT_PREFIX = 'support:select:';
const SUPPORT_AMOUNTS_ACTION = 'support:amounts';
const SUPPORT_BACK_ACTION = 'support:back';
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
    'Korang boleh pilih amount yg korang mampu 🙇🏻',
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

// Feedback/name capture is intentionally disabled for now.
// Returning false ensures normal text and downloader links continue to the normal bot flow.
export async function processSupportMessage() {
  return false;
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
    // Keep a lightweight submission only so the selected tier is retained for payment confirmation.
    // No feedback message or display name is requested or stored.
    await createSupportSubmission({
      orderNumber,
      userId: user.id,
      username: user.username || '',
      amount,
      tierKey: tier.key,
      tierLabel: tier.label,
    });

    await createPendingSupport({
      orderNumber,
      userId: user.id,
      username: user.username || '',
      amount,
    });

    const payment = await createSupportPayment({
      amount,
      user,
      publicBaseUrl: context.baseUrl,
      orderNumber,
    });

    await markSupportIntentCreated(orderNumber, payment.paymentIntentId);
    await markSupportSubmissionCheckout(orderNumber, payment.url, payment.paymentIntentId);

    await editSupportMessage(
      callbackQuery,
      [
        `🤍 Support RM${amount} dipilih — ${tier.label}!`,
        '',
        'Tekan button di bawah untuk terus ke payment.',
      ].join('\n'),
      {
        inline_keyboard: [
          [{ text: `💳 Bayar RM${amount}`, url: payment.url }],
          [{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }],
        ],
      },
    );
  } catch (error) {
    await markSupportIntentFailed(orderNumber, error?.code || 'UNKNOWN').catch(() => {});
    console.error('[support] checkout failed:', error?.code, error?.status, error?.message, error?.details || '');
    await editSupportMessage(
      callbackQuery,
      error?.code === 'BAYARCASH_PAYER_EMAIL_REQUIRED'
        ? '⚙️ Support payment belum ready sepenuhnya. Admin tengah lengkapkan email payment gateway.'
        : '❌ Payment page tak dapat dibuat sekarang. Cuba /support semula kejap lagi.',
      { inline_keyboard: [[{ text: '← Tukar Amount', callback_data: SUPPORT_AMOUNTS_ACTION }]] },
    );
  }

  return true;
}
