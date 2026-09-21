import { rm, writeFile } from 'node:fs/promises';

const statsFile = `/tmp/channel-gate-threshold-${process.pid}.json`;
process.env.STATS_FILE_PATH = statsFile;

const legacyUserId = 900000001;
const newUserId = 900000002;

await writeFile(statsFile, JSON.stringify({
  version: 1,
  trackingSince: new Date().toISOString(),
  users: {
    [legacyUserId]: {
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      premiumHqCompleted: true,
    },
  },
  monthlyDownloads: {},
}), 'utf8');

const {
  PREMIUM_HQ_CHANNEL_GATE_THRESHOLD,
  getPremiumHqCompletedCount,
  hasPremiumHqCompleted,
  markPremiumHqCompleted,
  recordUsage,
} = await import('../src/bot/stats.js');

try {
  if (PREMIUM_HQ_CHANNEL_GATE_THRESHOLD !== 5) {
    throw new Error(`Expected threshold 5, got ${PREMIUM_HQ_CHANNEL_GATE_THRESHOLD}`);
  }

  // Legacy boolean=true represented one successful Premium+ HQ use before counters existed.
  await recordUsage(legacyUserId);
  const legacyCount = await getPremiumHqCompletedCount(legacyUserId);
  if (legacyCount !== 1 || await hasPremiumHqCompleted(legacyUserId)) {
    throw new Error(`Legacy migration failed: count=${legacyCount}`);
  }

  for (let use = 1; use <= 4; use += 1) {
    await markPremiumHqCompleted(newUserId);
    const count = await getPremiumHqCompletedCount(newUserId);
    const gated = await hasPremiumHqCompleted(newUserId);
    if (count !== use || gated) {
      throw new Error(`Gate triggered too early at use ${use}: count=${count}, gated=${gated}`);
    }
  }

  await markPremiumHqCompleted(newUserId);
  const fifthCount = await getPremiumHqCompletedCount(newUserId);
  const fifthGated = await hasPremiumHqCompleted(newUserId);
  if (fifthCount !== 5 || !fifthGated) {
    throw new Error(`Gate did not trigger on fifth use: count=${fifthCount}, gated=${fifthGated}`);
  }

  console.log('CHANNEL_GATE_THRESHOLD_SELFTEST_OK', JSON.stringify({
    threshold: PREMIUM_HQ_CHANNEL_GATE_THRESHOLD,
    firstFourUsesFree: true,
    gateOnUse: 5,
    legacyBooleanMigratesToCount: 1,
  }));
} finally {
  await rm(statsFile, { force: true }).catch(() => {});
}
