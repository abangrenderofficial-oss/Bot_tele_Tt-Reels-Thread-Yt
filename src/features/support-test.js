import { createSupportOrderNumber, createSupportPayment, isBayarcashConfigured, isBayarcashSandbox } from '../payments/bayarcash.js';
import { createPendingSupport, markSupportIntentCreated, markSupportIntentFailed } from '../support/store.js';
import { sendMessage } from '../telegram.js';
import { isResetAdmin } from '../recovery.js';

function commandAmount(message = {}) {
  const text = String(message?.text || '').trim();
  const [, raw] = text.split(/\s+/);
  const amount = Number(raw || 10);
  if (![10, 20, 30].includes(amount)) return null;
  return amount;
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
    await sendMessage(chatId, 'Guna: /supporttest 10\nPilihan test: RM10, RM20 atau RM30.');
    return true;
  }

  const orderNumber = createSupportOrderNumber();
  await createPendingSupport({
    orderNumber,
    userId,
    username: message?.from?.username || '',
    amount,
  });

  await sendMessage(chatId, `${modeLabel}\n⏳ Creating Bayarcash support payment RM${amount}...`).catch(() => {});

  try {
    const payment = await createSupportPayment({
      amount,
      user: message.from,
      publicBaseUrl: context.baseUrl,
      orderNumber,
    });
    await markSupportIntentCreated(orderNumber, payment.paymentIntentId);

    await sendMessage(
      chatId,
      `${modeLabel}\n✅ Bayarcash support payment berjaya dibuat.\n\nAmount: RM${payment.amount}\nSupport ID: ${payment.orderNumber}\n\nTekan button bawah untuk buka payment page.${sandbox ? ' Ini Sandbox — tiada duit sebenar digunakan.' : ''}`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: `${sandbox ? '🧪 Test' : '❤️ Support'} RM${amount}`, url: payment.url }]],
        },
      },
    );
  } catch (error) {
    await markSupportIntentFailed(orderNumber, error?.code || 'UNKNOWN').catch(() => {});
    console.error('[support-test] Bayarcash failed:', error?.code, error?.status, error?.message, error?.details || '');
    await sendMessage(
      chatId,
      `${modeLabel}\n❌ Bayarcash support test gagal.\n${error?.message || 'Unknown error'}\n\nError ini boleh digunakan untuk betulkan config/API seterusnya.`,
    ).catch(() => {});
  }

  return true;
}
