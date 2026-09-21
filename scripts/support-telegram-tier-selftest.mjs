import { createHmac, randomBytes } from 'node:crypto';

import bayarcashHandler from '../api/bayarcash.js';
import { handleSupportTestCommand } from '../src/features/support-test.js';
import {
  currentSupportEnvironment,
  getSupportDb,
  getSupportProfile,
} from '../src/support/store.js';
import {
  isBayarcashSandbox,
  verifyTransactionCallback,
} from '../src/payments/bayarcash.js';
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

async function snapshotSupportUser(db, environment, ownerId) {
  const result = await db.execute({
    sql: `SELECT environment, telegram_user_id, telegram_username, total_support_cents,
                 first_support_at, last_support_at
          FROM support_users
          WHERE environment = ? AND telegram_user_id = ?
          LIMIT 1`,
    args: [environment, String(ownerId)],
  });
  return result.rows?.[0] || null;
}

async function clearSupportUser(db, environment, ownerId) {
  await db.execute({
    sql: 'DELETE FROM support_users WHERE environment = ? AND telegram_user_id = ?',
    args: [environment, String(ownerId)],
  });
}

async function restoreSupportUser(db, snapshot, environment, ownerId) {
  await clearSupportUser(db, environment, ownerId);
  if (!snapshot) return;
  await db.execute({
    sql: `INSERT INTO support_users (
            environment, telegram_user_id, telegram_username,
            total_support_cents, first_support_at, last_support_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      String(snapshot.environment),
      String(snapshot.telegram_user_id),
      String(snapshot.telegram_username || ''),
      Number(snapshot.total_support_cents || 0),
      snapshot.first_support_at ? String(snapshot.first_support_at) : null,
      snapshot.last_support_at ? String(snapshot.last_support_at) : null,
    ],
  });
}

async function findCreatedOrder(db, environment, ownerId, amountCents, startedAt) {
  const result = await db.execute({
    sql: `SELECT order_number, payment_intent_id, status, amount_cents, created_at
          FROM support_orders
          WHERE environment = ?
            AND telegram_user_id = ?
            AND amount_cents = ?
            AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 1`,
    args: [environment, String(ownerId), amountCents, startedAt],
  });
  return result.rows?.[0] || null;
}

async function completeSignedCallback(orderNumber, amount) {
  const transactionId = `TGTEST-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const payload = {
    record_type: 'transaction',
    transaction_id: transactionId,
    exchange_reference_number: `SANDBOX-${transactionId}`,
    exchange_transaction_id: transactionId,
    order_number: String(orderNumber),
    currency: 'MYR',
    amount: Number(amount).toFixed(2),
    payer_name: 'Abang Render',
    payer_email: payerEmail(),
    payer_bank_name: 'SANDBOX TELEGRAM SELFTEST',
    status: '3',
    status_description: 'Successful',
    datetime: new Date().toISOString(),
  };

  const secret = String(process.env.BAYARCASH_SANDBOX_API_SECRET_KEY || '').trim();
  if (!secret) throw new Error('BAYARCASH_SANDBOX_API_SECRET_KEY missing.');
  payload.checksum = callbackChecksum(secret, payload);

  if (!verifyTransactionCallback(payload)) {
    throw new Error(`Signed callback verification failed for ${orderNumber}.`);
  }

  const res = mockResponse();
  await bayarcashHandler({ method: 'POST', body: payload }, res);
  if (res.statusCode !== 200 || !res.body?.ok) {
    throw new Error(`Callback handler failed for ${orderNumber}: HTTP ${res.statusCode}`);
  }

  return transactionId;
}

async function runCommandTierTest({ db, environment, ownerId, amount, expectedTier }) {
  const startedAt = new Date(Date.now() - 2000).toISOString();
  const message = {
    text: `/supporttest ${amount}`,
    chat: { id: ownerId },
    from: {
      id: ownerId,
      first_name: 'Abang Render',
      username: 'abangrenderofficial',
    },
  };

  await handleSupportTestCommand(message, { baseUrl: process.env.PUBLIC_BASE_URL });

  const order = await findCreatedOrder(db, environment, ownerId, amount * 100, startedAt);
  if (!order) throw new Error(`/supporttest ${amount} did not create a Turso order.`);
  if (String(order.status) !== 'PENDING') {
    throw new Error(`/supporttest ${amount} order status is ${order.status}, expected PENDING.`);
  }
  if (!order.payment_intent_id) {
    throw new Error(`/supporttest ${amount} did not store a Bayarcash payment intent id.`);
  }

  await completeSignedCallback(String(order.order_number), amount);

  const profile = await getSupportProfile(ownerId);
  if (profile?.totalSupport !== Number(amount).toFixed(2) || profile?.tier?.key !== expectedTier) {
    throw new Error(
      `/supporttest ${amount} tier mismatch: ${JSON.stringify(profile)} expected ${expectedTier}/${Number(amount).toFixed(2)}`,
    );
  }

  return {
    orderNumber: String(order.order_number),
    tier: profile.tier,
    totalSupport: profile.totalSupport,
  };
}

const testOrders = [];
let db;
let originalSupportUser = null;
let environment = '';
let ownerId = 0;

try {
  if (!isBayarcashSandbox()) {
    throw new Error('Telegram tier self-test must only run in Bayarcash Sandbox mode.');
  }

  ownerId = Number(process.env.BOT_OWNER_ID || 0);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error('BOT_OWNER_ID is missing or invalid.');
  }

  environment = currentSupportEnvironment();
  db = await getSupportDb();
  originalSupportUser = await snapshotSupportUser(db, environment, ownerId);

  await sendMessage(
    ownerId,
    '🧪 TELEGRAM SUPPORT TIER TEST\n\nAku tengah test command sebenar /supporttest 50 dan /supporttest 100 melalui Bayarcash Sandbox + Turso. Tiada duit sebenar digunakan.',
  );

  await clearSupportUser(db, environment, ownerId);
  const rm50 = await runCommandTierTest({ db, environment, ownerId, amount: 50, expectedTier: 'diamond' });
  testOrders.push(rm50.orderNumber);

  await clearSupportUser(db, environment, ownerId);
  const rm100 = await runCommandTierTest({ db, environment, ownerId, amount: 100, expectedTier: 'ultimate' });
  testOrders.push(rm100.orderNumber);

  await sendMessage(
    ownerId,
    `✅ TELEGRAM SUPPORT TIER TEST COMPLETE\n\nRM50 → ${rm50.tier.label} ✅\nRM100 → ${rm100.tier.label} ✅\n\n/supporttest handler ✅\nBayarcash Sandbox payment intent ✅\nTurso order + cumulative tier ✅\nSigned callback handler ✅\nTelegram confirmation ✅\n\nData test akan dibersihkan dan jumlah sandbox asal dipulihkan.`,
  );

  console.log('TELEGRAM_SUPPORT_TIER_SELFTEST_OK', JSON.stringify({
    environment,
    rm50: { totalSupport: rm50.totalSupport, tier: rm50.tier },
    rm100: { totalSupport: rm100.totalSupport, tier: rm100.tier },
    telegram: true,
    sandboxPaymentIntents: true,
  }));
} catch (error) {
  console.error('TELEGRAM_SUPPORT_TIER_SELFTEST_FAILED', JSON.stringify({
    message: error?.message || String(error),
    code: error?.code || null,
    status: error?.status || null,
  }));
  process.exitCode = 1;
} finally {
  if (db && environment && ownerId) {
    try {
      if (testOrders.length) {
        const placeholders = testOrders.map(() => '?').join(', ');
        await db.execute({
          sql: `DELETE FROM support_transactions WHERE environment = ? AND order_number IN (${placeholders})`,
          args: [environment, ...testOrders],
        });
        await db.execute({
          sql: `DELETE FROM support_orders WHERE environment = ? AND order_number IN (${placeholders})`,
          args: [environment, ...testOrders],
        });
      }
      await restoreSupportUser(db, originalSupportUser, environment, ownerId);
      console.log('TELEGRAM_SUPPORT_TIER_SELFTEST_CLEANUP_OK');
    } catch (cleanupError) {
      console.error('TELEGRAM_SUPPORT_TIER_SELFTEST_CLEANUP_FAILED', cleanupError?.message || String(cleanupError));
      process.exitCode = 1;
    }
  }
}
