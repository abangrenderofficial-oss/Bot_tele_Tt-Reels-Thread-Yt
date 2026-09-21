import { verifyTransactionCallback } from '../src/payments/bayarcash.js';
import { applyBayarcashTransaction } from '../src/support/store.js';
import { sendMessage } from '../src/telegram.js';

function json(res, status, body) {
  res.status(status).json(body);
}

function confirmationText(result) {
  const lines = [
    `❤️ Support diterima — RM${result.amount}`,
    '',
    'Terima kasih banyak-banyak sebab support bot kita 🥹❤️',
    `Support ID: ${result.orderNumber}`,
    `Jumlah support: RM${result.totalSupport}`,
  ];
  if (result?.tier?.label) lines.push(`Status: ${result.tier.label}`);
  return lines.join('\n');
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'bayarcash-callback',
      configured: Boolean(
        process.env.BAYARCASH_API_TOKEN
        && process.env.BAYARCASH_API_SECRET_KEY
        && process.env.BAYARCASH_PORTAL_KEY,
      ),
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const valid = verifyTransactionCallback(payload);

  if (!valid) {
    console.warn('[bayarcash] rejected callback with invalid checksum', {
      order_number: payload?.order_number || null,
      status: payload?.status || null,
    });
    return json(res, 400, { ok: false, error: 'invalid_checksum' });
  }

  const result = await applyBayarcashTransaction(payload);
  console.log('[bayarcash] verified support callback', {
    order_number: payload?.order_number || null,
    transaction_id: payload?.transaction_id || null,
    amount: payload?.amount || null,
    status: payload?.status || null,
    known_order: result?.knownOrder || false,
    became_paid: result?.becamePaid || false,
    duplicate: result?.duplicate || false,
    amount_mismatch: result?.amountMismatch || false,
  });

  if (result?.becamePaid && result?.telegramUserId) {
    await sendMessage(result.telegramUserId, confirmationText(result)).catch((error) => {
      console.warn('[bayarcash] Telegram confirmation failed:', error?.message);
    });
  }

  return json(res, 200, { ok: true });
}
