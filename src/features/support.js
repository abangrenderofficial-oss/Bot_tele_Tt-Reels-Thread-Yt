import { createSupportOrderNumber, createSupportPayment, isBayarcashConfigured } from '../payments/bayarcash.js';
import { createPendingSupport, getSupportProfile, markSupportIntentCreated, markSupportIntentFailed } from '../support/store.js';
import { sendMessage, telegram } from '../telegram.js';

const SUPPORT_CALLBACK_PREFIX = 'support:pay:';
const SUPPORT_AMOUNTS = new Set([10, 20, 30]);

function amountFromCallback(action = '') {
  if (!String(action).startsWith(SUPPORT_CALLBACK_PREFIX)) return null;
  const amount = Number(String(action).slice(SUPPORT_CALLBACK_PREFIX.length));
  return SUPPORT_AMOUNTS.has(amount) ? amount : null;
}

export async function handleSupportCommand(message = {}) {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  if (!chatId || !userId) return true;

  const profile = await getSupportProfile(userId).catch(() => ({ totalSupport: '0.00', tier: { label: '' } }));
  const tierLine = profile?.tier?.label
    ? `\nStatus sekarang: ${profile.tier.label}\nJumlah support: RM${profile.totalSupport}`
    : '';

  const configNote = isBayarcashConfigured()
    ? ''
    : '\n\n⚙️ Payment gateway tengah disediakan. Cuba lagi kejap nanti.';

  await sendMessage(
    chatId,
    [
      '❤️ Support Bot Kita',
      '',
      'Kalau korang rasa bot ni membantu dan nak support kos server + development, boleh pilih mana-mana amount bawah ni. Support ni optional je 🥹',
      tierLine,
      configNote,
    ].filter(Boolean).join('\n'),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '☕ RM10', callback_data: `${SUPPORT_CALLBACK_PREFIX}10` },
            { text: '❤️ RM20', callback_data: `${SUPPORT_CALLBACK_PREFIX}20` },
            { text: '👑 RM30', callback_data: `${SUPPORT_CALLBACK_PREFIX}30` },
          ],
        ],
      },
    },
  );
  return true;
}

export async function processSupportCallback(callbackQuery = {}, context = {}) {
  const action = String(callbackQuery?.data || '');
  const amount = amountFromCallback(action);
  if (!amount) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  const user = callbackQuery?.from || {};
  if (!chatId || !user?.id) return true;

  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: `Preparing RM${amount} support...`,
    show_alert: false,
  }).catch(() => {});

  if (!isBayarcashConfigured()) {
    await sendMessage(chatId, '⚙️ Payment gateway tengah disediakan. Cuba lagi kejap nanti.').catch(() => {});
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

    await sendMessage(
      chatId,
      [
        `❤️ Support RM${payment.amount}`,
        '',
        'Tekan button bawah untuk buka payment page Bayarcash.',
        `Support ID: ${payment.orderNumber}`,
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [[{ text: `Bayar RM${amount} ❤️`, url: payment.url }]],
        },
      },
    );
  } catch (error) {
    await markSupportIntentFailed(orderNumber, error?.code || 'UNKNOWN').catch(() => {});
    console.error('[support] checkout failed:', error?.code, error?.status, error?.message, error?.details || '');
    await sendMessage(
      chatId,
      error?.code === 'BAYARCASH_PAYER_EMAIL_REQUIRED'
        ? '⚙️ Support payment belum ready sepenuhnya. Admin tengah lengkapkan email payment gateway.'
        : '❌ Payment page tak dapat dibuat sekarang. Cuba semula kejap lagi.',
    ).catch(() => {});
  }

  return true;
}
