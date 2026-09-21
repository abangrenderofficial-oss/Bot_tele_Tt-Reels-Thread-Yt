import { readFile } from 'node:fs/promises';

import { getSupportDb } from '../src/support/store.js';

const SOURCES = [
  { path: '/data/bot-support.json', environment: 'production' },
  { path: '/data/bot-support-sandbox.json', environment: 'sandbox' },
];

function cents(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function text(value, max = 255) {
  return String(value || '').slice(0, max);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function statementsForState(state, environment) {
  const statements = [];
  const orders = state?.orders && typeof state.orders === 'object' ? state.orders : {};
  const transactions = state?.transactions && typeof state.transactions === 'object' ? state.transactions : {};
  const users = state?.users && typeof state.users === 'object' ? state.users : {};

  for (const order of Object.values(orders)) {
    const orderNumber = text(order?.orderNumber, 120);
    const userId = text(order?.telegramUserId, 32);
    const amountCents = cents(order?.amount);
    if (!orderNumber || !userId || amountCents <= 0) continue;
    const createdAt = text(order?.createdAt || new Date().toISOString(), 64);
    const updatedAt = text(order?.updatedAt || createdAt, 64);

    statements.push({
      sql: `INSERT OR IGNORE INTO support_orders (
              environment, order_number, telegram_user_id, telegram_username,
              amount_cents, status, payment_intent_id, error_code,
              last_gateway_status, status_description, gateway_transaction_id,
              created_at, updated_at, paid_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        environment,
        orderNumber,
        userId,
        text(order?.telegramUsername, 64).replace(/^@+/, ''),
        amountCents,
        text(order?.status || 'PENDING', 40),
        order?.paymentIntentId ? text(order.paymentIntentId, 120) : null,
        order?.errorCode ? text(order.errorCode, 80) : null,
        order?.lastGatewayStatus ? text(order.lastGatewayStatus, 40) : null,
        text(order?.statusDescription, 200),
        order?.gatewayTransactionId ? text(order.gatewayTransactionId, 160) : null,
        createdAt,
        updatedAt,
        order?.paidAt ? text(order.paidAt, 64) : null,
      ],
    });
  }

  for (const [legacyKey, tx] of Object.entries(transactions)) {
    const orderNumber = text(tx?.orderNumber, 120);
    if (!orderNumber) continue;
    const transactionId = tx?.transactionId ? text(tx.transactionId, 160) : null;
    const txKey = transactionId || text(legacyKey || `order:${orderNumber}`, 180);
    const amountCents = cents(tx?.amount);
    const receivedAt = text(tx?.receivedAt || tx?.updatedAt || new Date().toISOString(), 64);
    const updatedAt = text(tx?.updatedAt || receivedAt, 64);

    statements.push({
      sql: `INSERT OR IGNORE INTO support_transactions (
              environment, tx_key, transaction_id, order_number,
              gateway_status, amount_cents, received_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        environment,
        txKey,
        transactionId,
        orderNumber,
        text(tx?.status, 40),
        amountCents,
        receivedAt,
        updatedAt,
      ],
    });
  }

  for (const [legacyUserId, user] of Object.entries(users)) {
    const userId = text(legacyUserId, 32);
    const totalCents = cents(user?.totalSupport);
    if (!userId || totalCents < 0) continue;
    const firstSupportAt = user?.firstSupportAt ? text(user.firstSupportAt, 64) : null;
    const lastSupportAt = user?.lastSupportAt ? text(user.lastSupportAt, 64) : null;

    statements.push({
      sql: `INSERT INTO support_users (
              environment, telegram_user_id, telegram_username,
              total_support_cents, first_support_at, last_support_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(environment, telegram_user_id) DO UPDATE SET
              telegram_username = CASE
                WHEN excluded.telegram_username <> '' THEN excluded.telegram_username
                ELSE support_users.telegram_username
              END,
              total_support_cents = MAX(support_users.total_support_cents, excluded.total_support_cents),
              first_support_at = COALESCE(support_users.first_support_at, excluded.first_support_at),
              last_support_at = CASE
                WHEN excluded.last_support_at IS NOT NULL THEN excluded.last_support_at
                ELSE support_users.last_support_at
              END`,
      args: [
        environment,
        userId,
        text(user?.telegramUsername, 64).replace(/^@+/, ''),
        totalCents,
        firstSupportAt,
        lastSupportAt,
      ],
    });
  }

  return statements;
}

async function runBatches(db, statements, chunkSize = 100) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize), 'write');
  }
}

const db = await getSupportDb();
let importedStatements = 0;
let foundFiles = 0;

for (const source of SOURCES) {
  const state = await readJson(source.path);
  if (!state) continue;
  foundFiles += 1;
  const statements = statementsForState(state, source.environment);
  await runBatches(db, statements);
  importedStatements += statements.length;
  console.log('TURSO_SUPPORT_MIGRATION_SOURCE_OK', JSON.stringify({
    environment: source.environment,
    statements: statements.length,
  }));
}

console.log('TURSO_SUPPORT_MIGRATION_OK', JSON.stringify({
  foundFiles,
  importedStatements,
}));
