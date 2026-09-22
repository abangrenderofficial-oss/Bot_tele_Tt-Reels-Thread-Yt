import { currentSupportEnvironment, getSupportDb } from './store.js';

let submissionSchemaPromise = null;

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

function cleanText(value, maxLength) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function rowToSubmission(row) {
  if (!row) return null;
  return {
    environment: String(row.environment || ''),
    orderNumber: String(row.order_number || ''),
    telegramUserId: String(row.telegram_user_id || ''),
    telegramUsername: String(row.telegram_username || ''),
    amount: moneyFromCents(row.amount_cents),
    tierKey: String(row.tier_key || ''),
    tierLabel: String(row.tier_label || ''),
    supportMessage: String(row.support_message || ''),
    displayName: String(row.display_name || ''),
    state: String(row.state || ''),
    paymentUrl: String(row.payment_url || ''),
    paymentIntentId: String(row.payment_intent_id || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    announcedAt: row.announced_at ? String(row.announced_at) : null,
  };
}

async function ensureSubmissionSchema() {
  if (!submissionSchemaPromise) {
    submissionSchemaPromise = (async () => {
      const db = await getSupportDb();
      await db.batch([
        `CREATE TABLE IF NOT EXISTS support_submissions (
          environment TEXT NOT NULL,
          order_number TEXT NOT NULL,
          telegram_user_id TEXT NOT NULL,
          telegram_username TEXT NOT NULL DEFAULT '',
          amount_cents INTEGER NOT NULL,
          tier_key TEXT NOT NULL,
          tier_label TEXT NOT NULL,
          support_message TEXT NOT NULL DEFAULT '',
          display_name TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL,
          payment_url TEXT NOT NULL DEFAULT '',
          payment_intent_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          announced_at TEXT,
          PRIMARY KEY (environment, order_number)
        )`,
        'CREATE INDEX IF NOT EXISTS idx_support_submissions_user_state ON support_submissions(environment, telegram_user_id, state, updated_at)',
      ], 'write');
      return true;
    })().catch((error) => {
      submissionSchemaPromise = null;
      throw error;
    });
  }
  return submissionSchemaPromise;
}

async function selectSubmission(db, environment, orderNumber) {
  const result = await db.execute({
    sql: `SELECT environment, order_number, telegram_user_id, telegram_username,
                 amount_cents, tier_key, tier_label, support_message, display_name,
                 state, payment_url, payment_intent_id, created_at, updated_at, announced_at
          FROM support_submissions
          WHERE environment = ? AND order_number = ?
          LIMIT 1`,
    args: [environment, String(orderNumber || '')],
  });
  return rowToSubmission(result.rows?.[0] || null);
}

export async function createSupportSubmission({
  orderNumber,
  userId,
  username = '',
  amount,
  tierKey,
  tierLabel,
}) {
  await ensureSubmissionSchema();
  const db = await getSupportDb();
  const environment = currentSupportEnvironment();
  const telegramUserId = validUserId(userId);
  const cents = amountCents(amount);
  if (!orderNumber || !telegramUserId || !cents || !tierKey || !tierLabel) {
    throw new Error('Invalid support submission.');
  }

  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `UPDATE support_submissions
            SET state = 'CANCELLED', updated_at = ?
            WHERE environment = ? AND telegram_user_id = ?
              AND state IN ('AWAITING_MESSAGE', 'AWAITING_NAME', 'READY')`,
      args: [now, environment, telegramUserId],
    },
    {
      sql: `INSERT INTO support_submissions (
              environment, order_number, telegram_user_id, telegram_username,
              amount_cents, tier_key, tier_label, state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'AWAITING_MESSAGE', ?, ?)`,
      args: [
        environment,
        String(orderNumber),
        telegramUserId,
        cleanUsername(username),
        cents,
        String(tierKey).slice(0, 32),
        String(tierLabel).slice(0, 80),
        now,
        now,
      ],
    },
  ], 'write');

  return selectSubmission(db, environment, orderNumber);
}

export async function getActiveSupportSubmission(userId) {
  await ensureSubmissionSchema();
  const telegramUserId = validUserId(userId);
  if (!telegramUserId) return null;
  const db = await getSupportDb();
  const environment = currentSupportEnvironment();
  const result = await db.execute({
    sql: `SELECT environment, order_number, telegram_user_id, telegram_username,
                 amount_cents, tier_key, tier_label, support_message, display_name,
                 state, payment_url, payment_intent_id, created_at, updated_at, announced_at
          FROM support_submissions
          WHERE environment = ? AND telegram_user_id = ?
            AND state IN ('AWAITING_MESSAGE', 'AWAITING_NAME')
          ORDER BY updated_at DESC
          LIMIT 1`,
    args: [environment, telegramUserId],
  });
  return rowToSubmission(result.rows?.[0] || null);
}

export async function getSupportSubmission(orderNumber) {
  await ensureSubmissionSchema();
  const db = await getSupportDb();
  return selectSubmission(db, currentSupportEnvironment(), orderNumber);
}

export async function setSupportSubmissionMessage(orderNumber, userId, message) {
  await ensureSubmissionSchema();
  const telegramUserId = validUserId(userId);
  if (!telegramUserId) return null;
  const db = await getSupportDb();
  const environment = currentSupportEnvironment();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE support_submissions
          SET support_message = ?, state = 'AWAITING_NAME', updated_at = ?
          WHERE environment = ? AND order_number = ? AND telegram_user_id = ?
            AND state = 'AWAITING_MESSAGE'`,
    args: [cleanText(message, 300), now, environment, String(orderNumber || ''), telegramUserId],
  });
  return selectSubmission(db, environment, orderNumber);
}

export async function setSupportSubmissionName(orderNumber, userId, displayName) {
  await ensureSubmissionSchema();
  const telegramUserId = validUserId(userId);
  if (!telegramUserId) return null;
  const db = await getSupportDb();
  const environment = currentSupportEnvironment();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE support_submissions
          SET display_name = ?, state = 'READY', updated_at = ?
          WHERE environment = ? AND order_number = ? AND telegram_user_id = ?
            AND state = 'AWAITING_NAME'`,
    args: [cleanText(displayName, 60), now, environment, String(orderNumber || ''), telegramUserId],
  });
  return selectSubmission(db, environment, orderNumber);
}

export async function markSupportSubmissionCheckout(orderNumber, paymentUrl = '', paymentIntentId = '') {
  await ensureSubmissionSchema();
  const db = await getSupportDb();
  const environment = currentSupportEnvironment();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE support_submissions
          SET state = 'CHECKOUT', payment_url = ?, payment_intent_id = ?, updated_at = ?
          WHERE environment = ? AND order_number = ?`,
    args: [
      cleanText(paymentUrl, 1000),
      cleanText(paymentIntentId, 200),
      now,
      environment,
      String(orderNumber || ''),
    ],
  });
  return selectSubmission(db, environment, orderNumber);
}

export async function cancelSupportSubmission(orderNumber, userId) {
  await ensureSubmissionSchema();
  const telegramUserId = validUserId(userId);
  if (!telegramUserId) return null;
  const db = await getSupportDb();
  const environment = currentSupportEnvironment();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE support_submissions
          SET state = 'CANCELLED', updated_at = ?
          WHERE environment = ? AND order_number = ? AND telegram_user_id = ?
            AND announced_at IS NULL`,
    args: [now, environment, String(orderNumber || ''), telegramUserId],
  });
  return selectSubmission(db, environment, orderNumber);
}

export async function markSupportSubmissionAnnounced(orderNumber) {
  await ensureSubmissionSchema();
  const db = await getSupportDb();
  const environment = currentSupportEnvironment();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE support_submissions
          SET state = 'PAID', announced_at = COALESCE(announced_at, ?), updated_at = ?
          WHERE environment = ? AND order_number = ?`,
    args: [now, now, environment, String(orderNumber || '')],
  });
  return selectSubmission(db, environment, orderNumber);
}
