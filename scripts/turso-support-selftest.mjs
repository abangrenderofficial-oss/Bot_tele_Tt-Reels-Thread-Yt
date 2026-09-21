import { randomBytes } from 'node:crypto';

import {
  applyBayarcashTransaction,
  createPendingSupport,
  currentSupportEnvironment,
  getSupportDb,
  getSupportProfile,
  markSupportIntentCreated,
} from '../src/support/store.js';

const environment = currentSupportEnvironment();
const suffix = `${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
const userId = String(7000000000000 + (Date.now() % 1000000));
const order10 = `DBT10-${suffix}`.slice(0, 30);
const order20 = `DBT20-${suffix}`.slice(0, 30);
const tx10 = `DBTX10-${suffix}`.slice(0, 80);
const tx20 = `DBTX20-${suffix}`.slice(0, 80);

function payload(orderNumber, transactionId, amount) {
  return {
    order_number: orderNumber,
    transaction_id: transactionId,
    status: '3',
    amount: Number(amount).toFixed(2),
    status_description: 'Turso support self-test successful',
  };
}

async function cleanup() {
  const db = await getSupportDb();
  await db.batch([
    {
      sql: 'DELETE FROM support_transactions WHERE environment = ? AND order_number IN (?, ?)',
      args: [environment, order10, order20],
    },
    {
      sql: 'DELETE FROM support_orders WHERE environment = ? AND order_number IN (?, ?)',
      args: [environment, order10, order20],
    },
    {
      sql: 'DELETE FROM support_users WHERE environment = ? AND telegram_user_id = ?',
      args: [environment, userId],
    },
  ], 'write');
}

try {
  await cleanup().catch(() => {});

  await createPendingSupport({ orderNumber: order10, userId, username: 'turso_selftest', amount: 10 });
  await markSupportIntentCreated(order10, `pi-test-10-${suffix}`);
  const first = await applyBayarcashTransaction(payload(order10, tx10, 10));
  if (!first?.becamePaid || first?.tier?.key !== 'supporter' || first?.totalSupport !== '10.00') {
    throw new Error(`RM10 support step failed: ${JSON.stringify(first)}`);
  }

  await createPendingSupport({ orderNumber: order20, userId, username: 'turso_selftest', amount: 20 });
  await markSupportIntentCreated(order20, `pi-test-20-${suffix}`);
  const second = await applyBayarcashTransaction(payload(order20, tx20, 20));
  if (!second?.becamePaid || second?.tier?.key !== 'vip' || second?.totalSupport !== '30.00') {
    throw new Error(`RM20 cumulative step failed: ${JSON.stringify(second)}`);
  }

  const duplicate = await applyBayarcashTransaction(payload(order10, tx10, 10));
  if (!duplicate?.duplicate || duplicate?.becamePaid) {
    throw new Error(`Duplicate callback was not idempotent: ${JSON.stringify(duplicate)}`);
  }

  const profile = await getSupportProfile(userId);
  if (profile?.totalSupport !== '30.00' || profile?.tier?.key !== 'vip') {
    throw new Error(`Final profile mismatch: ${JSON.stringify(profile)}`);
  }

  console.log('TURSO_SUPPORT_SELFTEST_OK', JSON.stringify({
    environment,
    totalSupport: profile.totalSupport,
    tier: profile.tier,
    duplicateProtected: true,
  }));
} catch (error) {
  console.error('TURSO_SUPPORT_SELFTEST_FAILED', JSON.stringify({
    environment,
    message: error?.message || String(error),
    code: error?.code || null,
  }));
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    console.warn('TURSO_SUPPORT_SELFTEST_CLEANUP_FAILED', error?.message || String(error));
  });
}
