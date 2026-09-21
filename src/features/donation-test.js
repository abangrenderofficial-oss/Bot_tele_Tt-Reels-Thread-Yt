import { createDonationPayment, isBayarcashConfigured } from '../payments/bayarcash.js';
import { sendMessage } from '../telegram.js';
import { isResetAdmin } from '../recovery.js';

function commandAmount(message = {}) {
  const text = String(message?.text || '').trim();
  const [, raw] = text.split(/\s+/);
  const amount = Number(raw || 10);
  if (![10, 20, 30].includes(amount)) return null;
  return amount;
}

export async function handleDonationTestCommand(message, context = {}) {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  if (!chatId) return true;

  if (!isResetAdmin(userId)) {
    await sendMessage(chatId, '❌ /donatetest hanya untuk owner bot.').catch(() => {});
    return true;
  }

  if (!isBayarcashConfigured()) {
    await sendMessage(
      chatId,
      '⚙️ Bayarcash belum lengkap di Railway. Tambah BAYARCASH_API_TOKEN, BAYARCASH_API_SECRET_KEY dan BAYARCASH_PORTAL_KEY dahulu.',
    );
    return true;
  }

  const amount = commandAmount(message);
  if (!amount) {
    await sendMessage(chatId, 'Guna: /donatetest 10\nPilihan test: RM10, RM20 atau RM30.');
    return true;
  }

  await sendMessage(chatId, `⏳ Creating Bayarcash DuitNow QR payment test RM${amount}...`).catch(() => {});

  try {
    const payment = await createDonationPayment({
      amount,
      user: message.from,
      publicBaseUrl: context.baseUrl,
    });

    await sendMessage(
      chatId,
      `✅ Bayarcash payment intent berjaya dibuat.\n\nAmount: RM${payment.amount}\nOrder: ${payment.orderNumber}\n\nTekan button bawah untuk buka payment page. Tak perlu bayar dulu kalau kita cuma nak confirm flow.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: `💳 Open RM${amount} Payment`, url: payment.url }]],
        },
      },
    );
  } catch (error) {
    console.error('[donation-test] Bayarcash failed:', error?.code, error?.status, error?.message, error?.details || '');
    await sendMessage(
      chatId,
      `❌ Bayarcash test gagal.\n${error?.message || 'Unknown error'}\n\nAku boleh guna error ni untuk betulkan config/API seterusnya.`,
    ).catch(() => {});
  }

  return true;
}
