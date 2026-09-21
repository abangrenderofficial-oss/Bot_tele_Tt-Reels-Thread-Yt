import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const LIVE_BASE_URL = 'https://api.console.bayar.cash/v3/';
const SANDBOX_BASE_URL = 'https://api.console.bayarcash-sandbox.com/v3/';

const PAYMENT_CHANNEL_LABELS = {
  1: 'FPX Online Banking',
  2: 'Manual Transfer',
  3: 'FPX Direct Debit',
  4: 'FPX Line of Credit',
  5: 'DuitNow Online Banking/Wallets',
  6: 'DuitNow QR',
  7: 'SPayLater',
  8: 'Boost PayFlex',
  9: 'QRIS Online Banking',
  10: 'QRIS Wallet',
  11: 'NETS',
  12: 'Credit Card',
  13: 'Alipay',
  14: 'WeChat Pay',
  15: 'PromptPay',
  16: 'Touch n Go',
  17: 'Boost Wallet',
  18: 'GrabPay',
  19: 'Grab PayLater',
  20: 'ShopBack BNPL',
  21: 'ShopeePay',
  23: 'FPX B2B',
};

const TRANSACTION_CALLBACK_FIELDS = [
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

export function isBayarcashSandbox() {
  return String(process.env.BAYARCASH_SANDBOX || '').trim().toLowerCase() === 'true';
}

function credentialEnvName(suffix) {
  return isBayarcashSandbox() ? `BAYARCASH_SANDBOX_${suffix}` : `BAYARCASH_${suffix}`;
}

function requiredCredential(suffix) {
  const name = credentialEnvName(suffix);
  const value = String(process.env[name] || '').trim();
  if (!value) {
    const error = new Error(`${name} is not configured.`);
    error.code = 'BAYARCASH_NOT_CONFIGURED';
    throw error;
  }
  return value;
}

function baseUrl() {
  return isBayarcashSandbox() ? SANDBOX_BASE_URL : LIVE_BASE_URL;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('Invalid support amount.');
    error.code = 'BAYARCASH_INVALID_AMOUNT';
    throw error;
  }
  return amount.toFixed(2);
}

function checksum(secret, payload) {
  const values = Object.keys(payload)
    .sort()
    .map((key) => String(payload[key] ?? ''));
  return createHmac('sha256', secret).update(values.join('|')).digest('hex');
}

function normalizeChannelForChecksum(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(',');
  if (value === undefined || value === null || value === '') return '';
  return String(value);
}

function paymentIntentChecksum(secret, data) {
  return checksum(secret, {
    payment_channel: normalizeChannelForChecksum(data.payment_channel),
    order_number: data.order_number,
    amount: data.amount,
    payer_name: data.payer_name,
    payer_email: data.payer_email,
  });
}

export function createSupportOrderNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = randomBytes(5).toString('hex').toUpperCase();
  const prefix = isBayarcashSandbox() ? 'TST' : 'SUP';
  return `${prefix}-${stamp}-${random}`.slice(0, 30);
}

function payerName(user = {}) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || 'Telegram Supporter';
}

function payerEmail() {
  const sandboxEmail = isBayarcashSandbox()
    ? String(process.env.BAYARCASH_SANDBOX_PAYER_EMAIL || '').trim()
    : '';
  const configured = sandboxEmail || String(process.env.BAYARCASH_PAYER_EMAIL || '').trim();
  if (configured) return configured;
  const error = new Error('BAYARCASH_PAYER_EMAIL is required for Bayarcash payment intent.');
  error.code = 'BAYARCASH_PAYER_EMAIL_REQUIRED';
  throw error;
}

function explicitPaymentChannel() {
  const sandboxChannel = isBayarcashSandbox()
    ? String(process.env.BAYARCASH_SANDBOX_PAYMENT_CHANNEL || '').trim()
    : '';
  const raw = sandboxChannel || String(process.env.BAYARCASH_PAYMENT_CHANNEL || '').trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

function payerPhone() {
  const sandboxPhone = isBayarcashSandbox()
    ? String(process.env.BAYARCASH_SANDBOX_PAYER_PHONE || '').trim()
    : '';
  return sandboxPhone || String(process.env.BAYARCASH_PAYER_PHONE || '').trim();
}

function publicUrls(publicBaseUrl) {
  const base = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) {
    const error = new Error('PUBLIC_BASE_URL is required for Bayarcash callback.');
    error.code = 'BAYARCASH_PUBLIC_URL_MISSING';
    throw error;
  }
  return {
    callbackUrl: `${base}/api/bayarcash`,
    returnUrl: `${base}/api/support-return`,
  };
}

export function isBayarcashConfigured() {
  return Boolean(
    String(process.env[credentialEnvName('API_TOKEN')] || '').trim()
    && String(process.env[credentialEnvName('API_SECRET_KEY')] || '').trim()
    && String(process.env[credentialEnvName('PORTAL_KEY')] || '').trim(),
  );
}

async function postPaymentIntent({ apiToken, data }) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) form.append(`${key}[]`, String(item));
    } else {
      form.set(key, String(value));
    }
  }

  const response = await fetch(`${baseUrl()}payment-intents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(Number(process.env.BAYARCASH_TIMEOUT_MS || 30000)),
  });

  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }

  if (!response.ok) {
    const message = body?.message || body?.error || raw || `Bayarcash HTTP ${response.status}`;
    const error = new Error(String(message));
    error.code = 'BAYARCASH_PAYMENT_INTENT_FAILED';
    error.status = response.status;
    error.details = body || raw;
    throw error;
  }

  const paymentUrl = body?.url || body?.data?.url;
  if (!paymentUrl) {
    const error = new Error('Bayarcash did not return a payment URL.');
    error.code = 'BAYARCASH_PAYMENT_URL_MISSING';
    error.details = body;
    throw error;
  }

  return { body, paymentUrl };
}

export async function createSupportPayment({ amount, user, publicBaseUrl, orderNumber = '' }) {
  const apiToken = requiredCredential('API_TOKEN');
  const apiSecret = requiredCredential('API_SECRET_KEY');
  const portalKey = requiredCredential('PORTAL_KEY');
  const { callbackUrl, returnUrl } = publicUrls(publicBaseUrl);
  const normalizedAmount = normalizeAmount(amount);
  const finalOrderNumber = String(orderNumber || createSupportOrderNumber()).slice(0, 30);
  const forcedChannel = explicitPaymentChannel();

  // Bayarcash v3 allows payment_channel to be omitted. In that mode the hosted
  // checkout page lets the payer choose from the channels actually available
  // on the portal. This is the safest default for both Sandbox and Production.
  const data = {
    portal_key: portalKey,
    order_number: finalOrderNumber,
    amount: normalizedAmount,
    payer_name: payerName(user),
    payer_email: payerEmail(),
    callback_url: callbackUrl,
    return_url: returnUrl,
  };

  if (forcedChannel) data.payment_channel = forcedChannel;

  const phone = payerPhone();
  if (phone) data.payer_telephone_number = phone;

  data.checksum = paymentIntentChecksum(apiSecret, data);
  const result = await postPaymentIntent({ apiToken, data });

  return {
    orderNumber: finalOrderNumber,
    amount: normalizedAmount,
    url: result.paymentUrl,
    paymentIntentId: result.body?.id || result.body?.data?.id || null,
    paymentChannel: forcedChannel,
    paymentChannelLabel: forcedChannel
      ? (PAYMENT_CHANNEL_LABELS[forcedChannel] || `Channel ${forcedChannel}`)
      : 'Choose at Bayarcash checkout',
    sandbox: isBayarcashSandbox(),
    raw: result.body,
  };
}

export function verifyTransactionCallback(payload = {}) {
  const secret = String(process.env[credentialEnvName('API_SECRET_KEY')] || '').trim();
  const provided = String(payload?.checksum || '').trim();
  if (!secret || !provided) return false;

  const signed = {};
  for (const field of TRANSACTION_CALLBACK_FIELDS) signed[field] = String(payload?.[field] ?? '');
  const expected = checksum(secret, signed);

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
