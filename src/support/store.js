import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SUPPORT_FILE = String(process.env.SUPPORT_FILE_PATH || '/data/bot-support.json');
const VERSION = 1;

let statePromise = null;
let writeQueue = Promise.resolve();

function emptyState() {
  return {
    version: VERSION,
    orders: {},
    transactions: {},
    users: {},
  };
}

function normalizeState(raw) {
  const fallback = emptyState();
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    version: VERSION,
    orders: raw.orders && typeof raw.orders === 'object' ? raw.orders : {},
    transactions: raw.transactions && typeof raw.transactions === 'object' ? raw.transactions : {},
    users: raw.users && typeof raw.users === 'object' ? raw.users : {},
  };
}

async function loadState() {
  if (!statePromise) {
    statePromise = (async () => {
      try {
        const text = await readFile(SUPPORT_FILE, 'utf8');
        return normalizeState(JSON.parse(text));
      } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('[support/store] load failed:', error?.message);
        return emptyState();
      }
    })();
  }
  return statePromise;
}

async function persistState(state) {
  await mkdir(path.dirname(SUPPORT_FILE), { recursive: true });
  const temp = `${SUPPORT_FILE}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state)}\n`, 'utf8');
  await rename(temp, SUPPORT_FILE);
}

function mutate(mutator) {
  let result;
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      const state = await loadState();
      result = mutator(state);
      await persistState(state);
    });
  return writeQueue.then(() => result).catch((error) => {
    console.error('[support/store] write failed:', error?.message);
    throw error;
  });
}

function validUserId(value) {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

function amountNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

export function supportTier(totalValue) {
  const total = amountNumber(totalValue);
  if (total >= 30) return { key: 'vip', label: '👑 VIP Supporter' };
  if (total >= 20) return { key: 'premium', label: '❤️ Premium Supporter' };
  if (total >= 10) return { key: 'supporter', label: '☕ Supporter' };
  return { key: 'none', label: '' };
}

export async function createPendingSupport({ orderNumber, userId, username = '', amount }) {
  const key = validUserId(userId);
  const normalized = amountNumber(amount);
  if (!orderNumber || !key || !normalized) throw new Error('Invalid pending support record.');

  return mutate((state) => {
    const now = new Date().toISOString();
    if (!state.orders[orderNumber]) {
      state.orders[orderNumber] = {
        orderNumber,
        telegramUserId: key,
        telegramUsername: String(username || '').replace(/^@+/, '').slice(0, 64),
        amount: normalized.toFixed(2),
        status: 'CREATING',
        createdAt: now,
        updatedAt: now,
      };
    }
    return { ...state.orders[orderNumber] };
  });
}

export async function markSupportIntentCreated(orderNumber, paymentIntentId = null) {
  if (!orderNumber) return null;
  return mutate((state) => {
    const order = state.orders[orderNumber];
    if (!order) return null;
    order.status = 'PENDING';
    order.paymentIntentId = paymentIntentId ? String(paymentIntentId) : null;
    order.updatedAt = new Date().toISOString();
    return { ...order };
  });
}

export async function markSupportIntentFailed(orderNumber, code = '') {
  if (!orderNumber) return null;
  return mutate((state) => {
    const order = state.orders[orderNumber];
    if (!order || order.paidAt) return null;
    order.status = 'INTENT_FAILED';
    order.errorCode = String(code || '').slice(0, 80);
    order.updatedAt = new Date().toISOString();
    return { ...order };
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

export async function applyBayarcashTransaction(payload = {}) {
  const orderNumber = String(payload?.order_number || '').trim();
  const transactionId = String(payload?.transaction_id || '').trim();
  const gatewayStatus = String(payload?.status ?? '').trim();
  const callbackAmount = amountNumber(payload?.amount);

  return mutate((state) => {
    const order = state.orders[orderNumber];
    if (!order) {
      return { knownOrder: false, becamePaid: false, orderNumber, transactionId };
    }

    const expectedAmount = amountNumber(order.amount);
    if (!callbackAmount || Math.abs(callbackAmount - expectedAmount) > 0.001) {
      order.lastGatewayStatus = gatewayStatus;
      order.status = 'AMOUNT_MISMATCH';
      order.updatedAt = new Date().toISOString();
      return {
        knownOrder: true,
        becamePaid: false,
        amountMismatch: true,
        orderNumber,
        transactionId,
      };
    }

    const now = new Date().toISOString();
    const txKey = transactionId || `order:${orderNumber}`;
    const previousTx = state.transactions[txKey];
    const sameCallback = previousTx
      && String(previousTx.status) === gatewayStatus
      && String(previousTx.amount) === callbackAmount.toFixed(2);

    order.lastGatewayStatus = gatewayStatus;
    order.statusDescription = String(payload?.status_description || '').slice(0, 200);
    order.gatewayTransactionId = transactionId || order.gatewayTransactionId || null;
    order.updatedAt = now;

    state.transactions[txKey] = {
      transactionId: transactionId || null,
      orderNumber,
      status: gatewayStatus,
      amount: callbackAmount.toFixed(2),
      receivedAt: previousTx?.receivedAt || now,
      updatedAt: now,
    };

    if (gatewayStatus !== '3') {
      order.status = callbackStatus(gatewayStatus);
      return {
        knownOrder: true,
        becamePaid: false,
        duplicate: Boolean(sameCallback),
        paid: Boolean(order.paidAt),
        orderNumber,
        transactionId,
        telegramUserId: order.telegramUserId,
        amount: expectedAmount.toFixed(2),
      };
    }

    if (order.paidAt) {
      const user = state.users[order.telegramUserId] || { totalSupport: '0.00' };
      const total = amountNumber(user.totalSupport);
      return {
        knownOrder: true,
        becamePaid: false,
        duplicate: true,
        paid: true,
        orderNumber,
        transactionId,
        telegramUserId: order.telegramUserId,
        amount: expectedAmount.toFixed(2),
        totalSupport: total.toFixed(2),
        tier: supportTier(total),
      };
    }

    order.status = 'PAID';
    order.paidAt = now;

    const user = state.users[order.telegramUserId] && typeof state.users[order.telegramUserId] === 'object'
      ? state.users[order.telegramUserId]
      : { totalSupport: '0.00', firstSupportAt: now };
    const total = amountNumber(user.totalSupport) + expectedAmount;
    user.totalSupport = total.toFixed(2);
    user.lastSupportAt = now;
    user.telegramUsername = order.telegramUsername || user.telegramUsername || '';
    state.users[order.telegramUserId] = user;

    return {
      knownOrder: true,
      becamePaid: true,
      paid: true,
      orderNumber,
      transactionId,
      telegramUserId: order.telegramUserId,
      amount: expectedAmount.toFixed(2),
      totalSupport: total.toFixed(2),
      tier: supportTier(total),
    };
  });
}

export async function getSupportProfile(userId) {
  const key = validUserId(userId);
  if (!key) return { totalSupport: '0.00', tier: supportTier(0) };
  await writeQueue.catch(() => {});
  const state = await loadState();
  const user = state.users?.[key] || {};
  const total = amountNumber(user.totalSupport);
  return {
    totalSupport: total.toFixed(2),
    tier: supportTier(total),
  };
}
