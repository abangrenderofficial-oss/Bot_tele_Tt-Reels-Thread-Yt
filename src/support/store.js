import { createClient } from '@libsql/client';

let client = null;
let schemaPromise = null;
let writeQueue = Promise.resolve();

export function currentSupportEnvironment() {
  return String(process.env.BAYARCASH_SANDBOX || '').trim().toLowerCase() === 'true'
    ? 'sandbox'
    : 'production';
}

export function isTursoSupportConfigured() {
  return Boolean(
    String(process.env.TURSO_DATABASE_URL || '').trim()
    && String(process.env.TURSO_AUTH_TOKEN || '').trim(),
  );
}

function requiredTursoConfig() {
  const url = String(process.env.TURSO_DATABASE_URL || '').trim();
  const authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  if (!url || !authToken) {
    const error = new Error('Turso support database is not configured.');
    error.code = 'TURSO_NOT_CONFIGURED';
    throw error;
  }
  return { url, authToken };
}

function databaseClient() {
  if (!client) {
    const { url, authToken } = requiredTursoConfig();
    client = createClient({ url, authToken });
  }
  return client;
}

export async function ensureSupportSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = databaseClient();
      await db.batch([
        `CREATE TABLE IF NOT EXISTS support_orders (
          environment TEXT NOT NULL,
          order_number TEXT NOT NULL,
          telegram_user_id TEXT NOT NULL,
          telegram_username TEXT NOT NULL DEFAULT '',
          amount_cents INTEGER NOT NULL,
          status TEXT NOT NULL,
          payment_intent_id TEXT,
          error_code TEXT,
          last_gateway_status TEXT,
          status_description TEXT,
          gateway_transaction_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          paid_at TEXT,
          PRIMARY KEY (environment, order_number)
        )`,
        `CREATE TABLE IF NOT EXISTS support_transactions (
          environment TEXT NOT NULL,
          tx_key TEXT NOT NULL,
          transaction_id TEXT,
          order_number TEXT NOT NULL,
          gateway_status TEXT NOT NULL,
          amount_cents INTEGER NOT NULL,
          received_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (environment, tx_key)
        )`,
        `CREATE TABLE IF NOT EXISTS support_users (
          environment TEXT NOT NULL,
          telegram_user_id TEXT NOT NULL,
          telegram_username TEXT NOT NULL DEFAULT '',
          total_support_cents INTEGER NOT NULL DEFAULT 0,
          first_support_at TEXT,
          last_support_at TEXT,
          PRIMARY KEY (environment, telegram_user_id)
        )`,
        'CREATE INDEX IF NOT EXISTS idx_support_orders_user ON support_orders(environment, telegram_user_id)',
        'CREATE INDEX IF NOT EXISTS idx_support_orders_status ON support_orders(environment, status)',
        'CREATE INDEX IF NOT EXISTS idx_support_transactions_order ON support_transactions(environment, order_number)',
      ], 'write');
      return true;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export async function getSupportDb() {
  await ensureSupportSchema();
  return databaseClient();
}

function validUserId(value) {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

function amountCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

function moneyFromCents(value) {
  const cents = Number(value || 0);
  return (Number.isFinite(cents) ? cents / 100 : 0).toFixed(2);
}

function cleanUsername(value) {
  return String(value || '').replace(/^@+/, '').slice(0, 64);
}

export function supportTier(totalValue) {
  const total = Number(totalValue || 0);
  if (total >= 30) return { key: 'vip', label: '👑 VIP Supporter' };
  if (total >= 20) return { key: 'premium', label: '❤️ Premium Supporter' };
  if (total >= 10) return { key: 'supporter', label: '☕ Supporter' };
  return { key: 'none', label: '' };
}

function rowToOrder(row) {
  if (!row) return null;
  return {
    orderNumber: String(row.order_number || ''),
    telegramUserId: String(row.telegram_user_id || ''),
    telegramUsername: String(row.telegram_username || ''),
    amount: moneyFromCents(row.amount_cents),
    status: String(row.status || ''),
    environment: String(row.environment || ''),
    paymentIntentId: row.payment_intent_id ? String(row.payment_intent_id) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    lastGatewayStatus: row.last_gateway_status ? String(row.last_gateway_status) : null,
    statusDescription: row.status_description ? String(row.status_description) : '',
    gatewayTransactionId: row.gateway_transaction_id ? String(row.gateway_transaction_id) : null,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    paidAt: row.paid_at ? String(row.paid_at) : null,
  };
}

async function selectOrder(executor, environment, orderNumber) {
  const result = await executor.execute({
    sql: `SELECT environment, order_number, telegram_user_id, telegram_username,
                 amount_cents, status, payment_intent_id, error_code,
                 last_gateway_status, status_description, gateway_transaction_id,
                 created_at, updated_at, paid_at
          FROM support_orders
          WHERE environment = ? AND order_number = ?
          LIMIT 1`,
    args: [environment, orderNumber],
  });
  return result.rows?.[0] || null;
}

function serializedWrite(worker) {
  let result;
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      const db = await getSupportDb();
      const tx = await db.transaction('write');
      try {
        result = await worker(tx);
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw error;
      }
    });

  return writeQueue.then(() => result).catch((error) => {
    console.error('[support/turso] write failed:', error?.message);
    throw error;
  });
}

export async function createPendingSupport({ orderNumber, userId, username = '', amount }) {
  const environment = currentSupportEnvironment();
  const key = validUserId(userId);
  const cents = amountCents(amount);
  if (!orderNumber || !key || !cents) throw new Error('Invalid pending support record.');

  return serializedWrite(async (tx) => {
    const now = new Date().toISOString();
    await tx.execute({
      sql: `INSERT OR IGNORE INTO support_orders (
              environment, order_number, telegram_user_id, telegram_username,
              amount_cents, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'CREATING', ?, ?)`,
      args: [environment, orderNumber, key, cleanUsername(username), cents, now, now],
    });
    return rowToOrder(await selectOrder(tx, environment, orderNumber));
  });
}

export async function markSupportIntentCreated(orderNumber, paymentIntentId = null) {
  if (!orderNumber) return null;
  const environment = currentSupportEnvironment();
  return serializedWrite(async (tx) => {
    const now = new Date().toISOString();
    await tx.execute({
      sql: `UPDATE support_orders
            SET status = 'PENDING', payment_intent_id = ?, error_code = NULL, updated_at = ?
            WHERE environment = ? AND order_number = ?`,
      args: [paymentIntentId ? String(paymentIntentId) : null, now, environment, orderNumber],
    });
    return rowToOrder(await selectOrder(tx, environment, orderNumber));
  });
}

export async function markSupportIntentFailed(orderNumber, code = '') {
  if (!orderNumber) return null;
  const environment = currentSupportEnvironment();
  return serializedWrite(async (tx) => {
    const now = new Date().toISOString();
    await tx.execute({
      sql: `UPDATE support_orders
            SET status = 'INTENT_FAILED', error_code = ?, updated_at = ?
            WHERE environment = ? AND order_number = ? AND paid_at IS NULL`,
      args: [String(code || '').slice(0, 80), now, environment, orderNumber],
    });
    return rowToOrder(await selectOrder(tx, environment, orderNumber));
  });
}

function callbackStatus(status) {
  const value = String(status ?? '');
  if (value === '3') return 'PAID';
  if (value === '2') return 'FAILED';
  if (value === '4') return 'CANCELLED';
  if (value === '5') return 'EXPIRED';
  if (value === '1') return 'PENDING';
  return 'NEW';
}

async function upsertTransaction(tx, {
  environment,
  txKey,
  transactionId,
  orderNumber,
  gatewayStatus,
  amountCentsValue,
  now,
}) {
  await tx.execute({
    sql: `INSERT INTO support_transactions (
            environment, tx_key, transaction_id, order_number,
            gateway_status, amount_cents, received_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(environment, tx_key) DO UPDATE SET
            transaction_id = excluded.transaction_id,
            order_number = excluded.order_number,
            gateway_status = excluded.gateway_status,
            amount_cents = excluded.amount_cents,
            updated_at = excluded.updated_at`,
    args: [
      environment,
      txKey,
      transactionId || null,
      orderNumber,
      gatewayStatus,
      amountCentsValue,
      now,
      now,
    ],
  });
}

export async function applyBayarcashTransaction(payload = {}) {
  const environment = currentSupportEnvironment();
  const orderNumber = String(payload?.order_number || '').trim();
  const transactionId = String(payload?.transaction_id || '').trim();
  const gatewayStatus = String(payload?.status ?? '').trim();
  const callbackCents = amountCents(payload?.amount);

  return serializedWrite(async (tx) => {
    const order = await selectOrder(tx, environment, orderNumber);
    if (!order) {
      return { knownOrder: false, becamePaid: false, orderNumber, transactionId };
    }

    const expectedCents = Number(order.amount_cents || 0);
    const now = new Date().toISOString();
    const txKey = transactionId || `order:${orderNumber}`;

    const previousTxResult = await tx.execute({
      sql: `SELECT gateway_status, amount_cents
            FROM support_transactions
            WHERE environment = ? AND tx_key = ?
            LIMIT 1`,
      args: [environment, txKey],
    });
    const previousTx = previousTxResult.rows?.[0] || null;
    const sameCallback = previousTx
      && String(previousTx.gateway_status || '') === gatewayStatus
      && Number(previousTx.amount_cents || 0) === callbackCents;

    await upsertTransaction(tx, {
      environment,
      txKey,
      transactionId,
      orderNumber,
      gatewayStatus,
      amountCentsValue: callbackCents,
      now,
    });

    if (!callbackCents || callbackCents !== expectedCents) {
      await tx.execute({
        sql: `UPDATE support_orders
              SET last_gateway_status = ?, status = 'AMOUNT_MISMATCH',
                  status_description = ?, updated_at = ?
              WHERE environment = ? AND order_number = ?`,
        args: [
          gatewayStatus,
          String(payload?.status_description || '').slice(0, 200),
          now,
          environment,
          orderNumber,
        ],
      });
      return {
        knownOrder: true,
        becamePaid: false,
        amountMismatch: true,
        orderNumber,
        transactionId,
      };
    }

    const alreadyPaid = Boolean(order.paid_at);
    const nextStatus = alreadyPaid ? 'PAID' : callbackStatus(gatewayStatus);
    await tx.execute({
      sql: `UPDATE support_orders
            SET last_gateway_status = ?, status_description = ?,
                gateway_transaction_id = COALESCE(NULLIF(?, ''), gateway_transaction_id),
                status = ?, updated_at = ?
            WHERE environment = ? AND order_number = ?`,
      args: [
        gatewayStatus,
        String(payload?.status_description || '').slice(0, 200),
        transactionId,
        nextStatus,
        now,
        environment,
        orderNumber,
      ],
    });

    if (gatewayStatus !== '3') {
      return {
        knownOrder: true,
        becamePaid: false,
        duplicate: Boolean(sameCallback),
        paid: alreadyPaid,
        orderNumber,
        transactionId,
        telegramUserId: String(order.telegram_user_id || ''),
        amount: moneyFromCents(expectedCents),
      };
    }

    if (alreadyPaid) {
      const userResult = await tx.execute({
        sql: `SELECT total_support_cents
              FROM support_users
              WHERE environment = ? AND telegram_user_id = ?
              LIMIT 1`,
        args: [environment, String(order.telegram_user_id || '')],
      });
      const totalCents = Number(userResult.rows?.[0]?.total_support_cents || 0);
      const total = Number(moneyFromCents(totalCents));
      return {
        knownOrder: true,
        becamePaid: false,
        duplicate: true,
        paid: true,
        orderNumber,
        transactionId,
        telegramUserId: String(order.telegram_user_id || ''),
        amount: moneyFromCents(expectedCents),
        totalSupport: total.toFixed(2),
        tier: supportTier(total),
      };
    }

    await tx.execute({
      sql: `UPDATE support_orders
            SET status = 'PAID', paid_at = ?, updated_at = ?
            WHERE environment = ? AND order_number = ? AND paid_at IS NULL`,
      args: [now, now, environment, orderNumber],
    });

    await tx.execute({
      sql: `INSERT INTO support_users (
              environment, telegram_user_id, telegram_username,
              total_support_cents, first_support_at, last_support_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(environment, telegram_user_id) DO UPDATE SET
              telegram_username = CASE
                WHEN excluded.telegram_username <> '' THEN excluded.telegram_username
                ELSE support_users.telegram_username
              END,
              total_support_cents = support_users.total_support_cents + excluded.total_support_cents,
              first_support_at = COALESCE(support_users.first_support_at, excluded.first_support_at),
              last_support_at = excluded.last_support_at`,
      args: [
        environment,
        String(order.telegram_user_id || ''),
        cleanUsername(order.telegram_username || ''),
        expectedCents,
        now,
        now,
      ],
    });

    const userResult = await tx.execute({
      sql: `SELECT total_support_cents
            FROM support_users
            WHERE environment = ? AND telegram_user_id = ?
            LIMIT 1`,
      args: [environment, String(order.telegram_user_id || '')],
    });
    const totalCents = Number(userResult.rows?.[0]?.total_support_cents || 0);
    const total = Number(moneyFromCents(totalCents));

    return {
      knownOrder: true,
      becamePaid: true,
      paid: true,
      orderNumber,
      transactionId,
      telegramUserId: String(order.telegram_user_id || ''),
      amount: moneyFromCents(expectedCents),
      totalSupport: total.toFixed(2),
      tier: supportTier(total),
    };
  });
}

export async function getSupportProfile(userId) {
  const key = validUserId(userId);
  if (!key) return { totalSupport: '0.00', tier: supportTier(0) };
  await writeQueue.catch(() => {});
  const db = await getSupportDb();
  const environment = currentSupportEnvironment();
  const result = await db.execute({
    sql: `SELECT total_support_cents
          FROM support_users
          WHERE environment = ? AND telegram_user_id = ?
          LIMIT 1`,
    args: [environment, key],
  });
  const totalCents = Number(result.rows?.[0]?.total_support_cents || 0);
  const total = Number(moneyFromCents(totalCents));
  return {
    totalSupport: total.toFixed(2),
    tier: supportTier(total),
  };
}
