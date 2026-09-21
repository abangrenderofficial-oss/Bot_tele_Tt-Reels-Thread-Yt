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
const steps = [
  { amount: 10, expectedTotal: '10.00', expectedTier: 'supporter' },
  { amount: 20, expectedTotal: '30.00', expectedTier: 'vip' },
  { amount: 20, expectedTotal: '50.00', expectedTier: 'diamond' },
  { amount: 50, expectedTotal: '100.00', expectedTier: 'ultimate' },
].map((step, index) => ({
  ...step,
  orderNumber: `DBT${index + 1}-${suffix}`.slice(0, 30),
  transactionId: `DBTX${index + 1}-${suffix}`.slice(0, 80),
}));

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
  const placeholders = steps.map(() => '?').join(', ');
  const orders = steps.map((step) => step.orderNumber);
  await db.batch([
    {
      sql: `DELETE FROM support_transactions WHERE environment = ? AND order_number IN (${placeholders})`,
      args: [environment, ...orders],
    },
    {
      sql: `DELETE FROM support_orders WHERE environment = ? AND order_number IN (${placeholders})`,
      args: [environment, ...orders],
    },
    {
      sql: 'DELETE FROM support_users WHERE environment = ? AND telegram_user_id = ?',
      args: [environment, userId],
    },
  ], 'write');
}

try {
  await cleanup().catch(() => {});

  for (const [index, step] of steps.entries()) {
    await createPendingSupport({
      orderNumber: step.orderNumber,
      userId,
      username: 'turso_selftest',
      amount: step.amount,
    });
    await markSupportIntentCreated(step.orderNumber, `pi-test-${index + 1}-${suffix}`);
    const result = await applyBayarcashTransaction(
      payload(step.orderNumber, step.transactionId, step.amount),
    );
    if (
      !result?.becamePaid
      || result?.tier?.key !== step.expectedTier
      || result?.totalSupport !== step.expectedTotal
    ) {
      throw new Error(`Support step ${index + 1} failed: ${JSON.stringify(result)}`);
    }
  }

  const first = steps[0];
  const duplicate = await applyBayarcashTransaction(
    payload(first.orderNumber, first.transactionId, first.amount),
  );
  if (!duplicate?.duplicate || duplicate?.becamePaid) {
    throw new Error(`Duplicate callback was not idempotent: ${JSON.stringify(duplicate)}`);
  }

  const profile = await getSupportProfile(userId);
  if (profile?.totalSupport !== '100.00' || profile?.tier?.key !== 'ultimate') {
    throw new Error(`Final profile mismatch: ${JSON.stringify(profile)}`);
  }

  console.log('TURSO_SUPPORT_SELFTEST_OK', JSON.stringify({
    environment,
    totalSupport: profile.totalSupport,
    tier: profile.tier,
    thresholdsChecked: ['supporter', 'vip', 'diamond', 'ultimate'],
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
