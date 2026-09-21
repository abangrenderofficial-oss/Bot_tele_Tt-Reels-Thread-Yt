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

const CHANNEL_PREFERENCE = [1, 5, 6, 12, 4, 7, 8, 16, 17, 18, 21, 9, 10, 11, 13, 14, 15, 19, 20, 23, 2, 3];

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
  return isBayarcashSandbox()
    ? `BAYARCASH_SANDBOX_${suffix}`
    : `BAYARCASH_${suffix}`;
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

function paymentIntentChecksum(secret, data) {
  return checksum(secret, {
    payment_channel: String(data.payment_channel ?? ''),
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

function channelId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  if (!value || typeof value !== 'object') return null;

  const direct = [
    value.id,
    value.payment_channel,
    value.payment_channel_id,
    value.channel,
    value.channel_id,
    value.paymentChannel,
    value.paymentChannelId,
    value.channelId,
  ];
  for (const item of direct) {
    const parsed = channelId(item);
    if (parsed) return parsed;
  }
  return null;
}

function sortChannels(ids) {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  return unique.sort((a, b) => {
    const ai = CHANNEL_PREFERENCE.indexOf(a);
    const bi = CHANNEL_PREFERENCE.indexOf(b);
    if (ai === -1 && bi === -1) return a - b;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

async function availablePortalChannels(apiToken, portalKey) {
  const response = await fetch(`${baseUrl()}portals`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(Number(process.env.BAYARCASH_TIMEOUT_MS || 30000)),
  });

  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }

  if (!response.ok) {
    const error = new Error(body?.message || body?.error || raw || `Bayarcash portals HTTP ${response.status}`);
    error.code = 'BAYARCASH_PORTAL_LOOKUP_FAILED';
    error.status = response.status;
    error.details = body || raw;
    throw error;
  }

  const portals = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const portal = portals.find((item) => String(item?.portal_key ?? item?.portalKey ?? '').trim() === portalKey);
  if (!portal) {
    const error = new Error('Bayarcash portal key was not found in this environment.');
    error.code = 'BAYARCASH_PORTAL_NOT_FOUND';
    throw error;
  }

  const rawChannels = portal?.payment_channels ?? portal?.paymentChannels ?? [];
  const ids = Array.isArray(rawChannels) ? rawChannels.map(channelId).filter(Boolean) : [];
  const sorted = sortChannels(ids);

  if (!sorted.length) {
    const error = new Error('No payment channel is enabled for this Bayarcash portal.');
    error.code = 'BAYARCASH_NO_PAYMENT_CHANNEL';
    throw error;
  }

  return sorted;
}

function gatewayUnavailable(error) {
  const message = String(error?.message || '').toLowerCase();
  return Number(error?.status || 0) === 422 && message.includes('payment gateway not available');
}

async function postPaymentIntent({ apiToken, apiSecret, portalKey, channel, orderNumber, normalizedAmount, user, callbackUrl, returnUrl }) {
  const data = {
    portal_key: portalKey,
    payment_channel: String(channel),
    order_number: orderNumber,
    amount: normalizedAmount,
    payer_name: payerName(user),
    payer_email: payerEmail(),
    callback_url: callbackUrl,
    return_url: returnUrl,
  };

  const phone = payerPhone();
  if (phone) data.payer_telephone_number = phone;

  data.checksum = paymentIntentChecksum(apiSecret, data);

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue;
    form.set(key, String(value));
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
    error.paymentChannel = channel;
    throw error;
  }

  const paymentUrl = body?.url || body?.data?.url;
  if (!paymentUrl) {
    const error = new Error('Bayarcash did not return a payment URL.');
    error.code = 'BAYARCASH_PAYMENT_URL_MISSING';
    error.details = body;
    error.paymentChannel = channel;
    throw error;
  }

  return { data, body, paymentUrl };
}

export function isBayarcashConfigured() {
  return Boolean(
    String(process.env[credentialEnvName('API_TOKEN')] || '').trim()
    && String(process.env[credentialEnvName('API_SECRET_KEY')] || '').trim()
    && String(process.env[credentialEnvName('PORTAL_KEY')] || '').trim(),
  );
}

export async function createSupportPayment({ amount, user, publicBaseUrl, orderNumber = '' }) {
  const apiToken = requiredCredential('API_TOKEN');
  const apiSecret = requiredCredential('API_SECRET_KEY');
  const portalKey = requiredCredential('PORTAL_KEY');
  const { callbackUrl, returnUrl } = publicUrls(publicBaseUrl);
  const normalizedAmount = normalizeAmount(amount);
  const finalOrderNumber = String(orderNumber || createSupportOrderNumber()).slice(0, 30);

  const forcedChannel = explicitPaymentChannel();
  const candidates = forcedChannel
    ? [forcedChannel]
    : await availablePortalChannels(apiToken, portalKey);

  let lastError = null;
  for (const channel of candidates) {
    try {
      const result = await postPaymentIntent({
        apiToken,
        apiSecret,
        portalKey,
        channel,
        orderNumber: finalOrderNumber,
        normalizedAmount,
        user,
        callbackUrl,
        returnUrl,
      });

      return {
        orderNumber: finalOrderNumber,
        amount: normalizedAmount,
        url: result.paymentUrl,
        paymentIntentId: result.body?.id || result.body?.data?.id || null,
        paymentChannel: channel,
        paymentChannelLabel: PAYMENT_CHANNEL_LABELS[channel] || `Channel ${channel}`,
        availablePaymentChannels: candidates,
        sandbox: isBayarcashSandbox(),
        raw: result.body,
      };
    } catch (error) {
      lastError = error;
      if (!forcedChannel && gatewayUnavailable(error)) {
        console.warn('[bayarcash] channel unavailable, trying next portal channel', {
          sandbox: isBayarcashSandbox(),
          payment_channel: channel,
        });
        continue;
      }
      throw error;
    }
  }

  if (lastError) {
    lastError.availablePaymentChannels = candidates;
    throw lastError;
  }

  const error = new Error('No usable Bayarcash payment channel was found.');
  error.code = 'BAYARCASH_NO_USABLE_PAYMENT_CHANNEL';
  throw error;
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
