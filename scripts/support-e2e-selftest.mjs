import { createHmac, randomBytes } from 'node:crypto';

import bayarcashHandler from '../api/bayarcash.js';
import {
  createSupportOrderNumber,
  createSupportPayment,
  isBayarcashSandbox,
  verifyTransactionCallback,
} from '../src/payments/bayarcash.js';
import {
  createPendingSupport,
  getSupportProfile,
  markSupportIntentCreated,
} from '../src/support/store.js';
import { sendMessage } from '../src/telegram.js';

const CALLBACK_FIELDS = [
  'record_type',
  'transaction_id',
  'exchange_reference_number',
  'exchange_transaction_id',
  'order_number',
  'currency',
  'amount',
  'payer_name',
  'payer_email',
  'payer_bank_name',
  'status',
  'status_description',
  'datetime',
];

function callbackChecksum(secret, payload) {
  const signed = {};
  for (const field of CALLBACK_FIELDS) signed[field] = String(payload?.[field] ?? '');
  const values = Object.keys(signed).sort().map((key) => signed[key]);
  return createHmac('sha256', secret).update(values.join('|')).digest('hex');
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = Number(code); return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

function payerEmail() {
  return String(process.env.BAYARCASH_SANDBOX_PAYER_EMAIL || process.env.BAYARCASH_PAYER_EMAIL || '').trim();
}

async function createAndCompleteSandboxSupport(ownerId, amount) {
  const orderNumber = createSupportOrderNumber();
  await createPendingSupport({
    orderNumber,
    userId: ownerId,
    username: 'abangrenderofficial',
    amount,
  });

  const payment = await createSupportPayment({
    amount,
    user: {
      id: ownerId,
      first_name: 'Abang Render',
      username: 'abangrenderofficial',
    },
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    orderNumber,
  });

  await markSupportIntentCreated(orderNumber, payment.paymentIntentId);

  await sendMessage(
    ownerId,
    `🧪 SANDBOX E2E\n\nPayment link RM${payment.amount} berjaya dibuat.\nSupport ID: ${orderNumber}\n\nCallback selepas ini disimulasikan secara signed untuk test flow bot tanpa duit sebenar.`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: `🧪 Buka Sandbox RM${amount}`, url: payment.url }]],
      },
    },
  );

  const transactionId = `TSTTX-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const payload = {
    record_type: 'transaction',
    transaction_id: transactionId,
    exchange_reference_number: `SANDBOX-${transactionId}`,
    exchange_transaction_id: transactionId,
    order_number: orderNumber,
    currency: 'MYR',
    amount: Number(amount).toFixed(2),
    payer_name: 'Abang Render',
    payer_email: payerEmail(),
    payer_bank_name: 'SANDBOX SELFTEST',
    status: '3',
    status_description: 'Successful',
    datetime: new Date().toISOString(),
  };

  const secret = String(process.env.BAYARCASH_SANDBOX_API_SECRET_KEY || '').trim();
  if (!secret) throw new Error('BAYARCASH_SANDBOX_API_SECRET_KEY missing for E2E self-test.');
  payload.checksum = callbackChecksum(secret, payload);

  if (!verifyTransactionCallback(payload)) {
    throw new Error(`Synthetic callback checksum verification failed for ${orderNumber}.`);
  }

  const res = mockResponse();
  await bayarcashHandler({ method: 'POST', body: payload }, res);
  if (res.statusCode !== 200 || !res.body?.ok) {
    throw new Error(`Bayarcash callback handler failed for ${orderNumber}: HTTP ${res.statusCode}`);
  }

  return payment;
}

try {
  if (!isBayarcashSandbox()) {
    console.log('SUPPORT_E2E_SELFTEST_SKIPPED {"reason":"not_sandbox"}');
    process.exit(0);
  }

  const ownerId = Number(process.env.BOT_OWNER_ID || 0);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error('BOT_OWNER_ID is missing or invalid.');
  }

  await sendMessage(ownerId, '🧪 SANDBOX SUPPORT E2E TEST\n\nAku tengah test RM10 + RM20 sampai cumulative tier jadi VIP. Tiada duit sebenar digunakan.');

  await createAndCompleteSandboxSupport(ownerId, 10);
  await createAndCompleteSandboxSupport(ownerId, 20);

  const profile = await getSupportProfile(ownerId);
  if (profile?.tier?.key !== 'vip' || Number(profile.totalSupport) < 30) {
    throw new Error(`Expected VIP tier after sandbox E2E test, got ${profile?.tier?.key || 'none'} / RM${profile?.totalSupport || '0.00'}.`);
  }

  await sendMessage(
    ownerId,
    `✅ SANDBOX E2E COMPLETE\n\nJumlah sandbox support: RM${profile.totalSupport}\nStatus: ${profile.tier.label}\n\nPayment intent ✅\nSigned callback verification ✅\nPersistent cumulative support ✅\nTelegram confirmation ✅`,
  );

  console.log('SUPPORT_E2E_SELFTEST_OK', JSON.stringify({
    ownerId,
    totalSupport: profile.totalSupport,
    tier: profile.tier,
  }));
} catch (error) {
  console.error('SUPPORT_E2E_SELFTEST_FAILED', JSON.stringify({
    message: error?.message || String(error),
    code: error?.code || null,
    status: error?.status || null,
  }));
  process.exit(1);
}
