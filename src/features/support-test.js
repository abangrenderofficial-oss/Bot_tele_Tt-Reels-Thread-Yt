import {
  createSupportOrderNumber,
  createSupportPayment,
  getBayarcashPortalDiagnostic,
  isBayarcashConfigured,
  isBayarcashSandbox,
} from '../payments/bayarcash.js';
import { createPendingSupport, markSupportIntentCreated, markSupportIntentFailed } from '../support/store.js';
import { sendMessage } from '../telegram.js';
import { isResetAdmin } from '../recovery.js';

const SUPPORT_AMOUNTS = [10, 20, 30, 50, 100];
const TEST_CHANNEL_PRIORITY = [1, 5, 6, 12, 16, 17, 18, 21, 4, 23, 7, 8, 9, 10, 11, 13, 14, 15, 19, 20, 2, 3];

function commandAmount(message = {}) {
  const text = String(message?.text || '').trim();
  const [, raw] = text.split(/\s+/);
  const amount = Number(raw || 10);
  if (!SUPPORT_AMOUNTS.includes(amount)) return null;
  return amount;
}

function chooseTestChannel(channels = []) {
  for (const id of TEST_CHANNEL_PRIORITY) {
    const found = channels.find((channel) => Number(channel?.id) === id);
    if (found) return found;
  }
  return channels[0] || null;
}

function channelSummary(channels = []) {
  if (!channels.length) return 'None';
  return channels
    .map((channel) => `${channel.id} ${channel.name || channel.label || channel.code || 'Channel'}`)
    .join(', ');
}

export async function handleSupportTestCommand(message, context = {}) {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  if (!chatId) return true;

  if (!isResetAdmin(userId)) {
    await sendMessage(chatId, '❌ /supporttest hanya untuk owner bot.').catch(() => {});
    return true;
  }

  const sandbox = isBayarcashSandbox();
  const modeLabel = sandbox ? '🧪 SANDBOX' : '🔴 PRODUCTION';

  if (!isBayarcashConfigured()) {
    const required = sandbox
      ? 'BAYARCASH_SANDBOX_API_TOKEN, BAYARCASH_SANDBOX_API_SECRET_KEY dan BAYARCASH_SANDBOX_PORTAL_KEY'
      : 'BAYARCASH_API_TOKEN, BAYARCASH_API_SECRET_KEY dan BAYARCASH_PORTAL_KEY';
    await sendMessage(
      chatId,
      `⚙️ Bayarcash ${modeLabel} belum lengkap di Railway. ${required} belum aktif.`,
    );
    return true;
  }

  const amount = commandAmount(message);
  if (!amount) {
    await sendMessage(chatId, 'Guna: /supporttest 10\nPilihan test: RM10, RM20, RM30, RM50 atau RM100.');
    return true;
  }

  let orderNumber = '';
  try {
    await sendMessage(chatId, `${modeLabel}\n🔎 Checking Bayarcash API token, portal & payment channels...`).catch(() => {});

    const diagnostic = await getBayarcashPortalDiagnostic();
    const testChannel = chooseTestChannel(diagnostic.paymentChannels);
    if (!testChannel) {
      const error = new Error('Portal dijumpai tetapi tiada payment channel aktif. Enable sekurang-kurangnya satu channel dalam Bayarcash portal.');
      error.code = 'BAYARCASH_NO_ACTIVE_CHANNEL';
      throw error;
    }

    await sendMessage(
      chatId,
      [
        `${modeLabel}`,
        '✅ Bayarcash API connection OK.',
        `Portal: ${diagnostic.portalName}`,
        `Active channels: ${channelSummary(diagnostic.paymentChannels)}`,
        `Test channel: ${testChannel.id} ${testChannel.name || testChannel.label || testChannel.code || ''}`.trim(),
      ].join('\n'),
    ).catch(() => {});

    orderNumber = createSupportOrderNumber();
    await createPendingSupport({
      orderNumber,
      userId,
      username: message?.from?.username || '',
      amount,
    });

    await sendMessage(chatId, `${modeLabel}\n⏳ Creating Bayarcash support payment RM${amount}...`).catch(() => {});

    const payment = await createSupportPayment({
      amount,
      user: message.from,
      publicBaseUrl: context.baseUrl,
      orderNumber,
      paymentChannel: testChannel.id,
    });
    await markSupportIntentCreated(orderNumber, payment.paymentIntentId);

    await sendMessage(
      chatId,
      [
        `${modeLabel}`,
        '✅ Bayarcash support payment berjaya dibuat.',
        '',
        `Amount: RM${payment.amount}`,
        `Support ID: ${payment.orderNumber}`,
        `Channel: ${payment.paymentChannelLabel}`,
        '',
        `Tekan button bawah untuk buka payment page.${sandbox ? ' Ini Sandbox — tiada duit sebenar digunakan.' : ''}`,
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [[{ text: `${sandbox ? '🧪 Test' : '❤️ Support'} RM${amount}`, url: payment.url }]],
        },
      },
    );
  } catch (error) {
    if (orderNumber) await markSupportIntentFailed(orderNumber, error?.code || 'UNKNOWN').catch(() => {});
    console.error('[support-test] Bayarcash failed:', error?.code, error?.status, error?.message, error?.details || '');
    await sendMessage(
      chatId,
      [
        `${modeLabel}`,
        '❌ Bayarcash support test gagal.',
        error?.message || 'Unknown error',
        '',
        `Code: ${error?.code || 'UNKNOWN'}`,
        error?.status ? `HTTP: ${error.status}` : '',
      ].filter(Boolean).join('\n'),
    ).catch(() => {});
  }

  return true;
}
