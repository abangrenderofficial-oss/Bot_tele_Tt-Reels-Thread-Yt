import { createSupportPayment, isBayarcashSandbox } from '../src/payments/bayarcash.js';

function safeDetails(error) {
  const details = error?.details;
  if (!details) return null;
  if (typeof details === 'string') return details.slice(0, 1000);
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return String(details).slice(0, 1000);
  }
}

try {
  if (!isBayarcashSandbox()) {
    console.log('BAYARCASH_SELFTEST_SKIPPED {"reason":"not_sandbox"}');
    process.exit(0);
  }

  const payment = await createSupportPayment({
    amount: 10,
    user: {
      first_name: 'Abang Render',
      username: 'abangrenderofficial',
    },
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
  });

  let checkoutHost = '';
  try { checkoutHost = new URL(payment.url).host; } catch {}

  console.log('BAYARCASH_SELFTEST_OK', JSON.stringify({
    sandbox: payment.sandbox,
    orderNumber: payment.orderNumber,
    amount: payment.amount,
    paymentChannel: payment.paymentChannel,
    paymentChannelLabel: payment.paymentChannelLabel,
    paymentIntentId: payment.paymentIntentId,
    checkoutHost,
  }));
} catch (error) {
  console.error('BAYARCASH_SELFTEST_FAILED', JSON.stringify({
    code: error?.code || null,
    status: error?.status || null,
    message: error?.message || String(error),
    details: safeDetails(error),
  }));
  process.exit(1);
}
