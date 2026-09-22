import { rm, writeFile } from 'node:fs/promises';

const statsFile = `/tmp/channel-gate-threshold-${process.pid}.json`;
process.env.STATS_FILE_PATH = statsFile;

const legacyUserId = 900000001;
const newUserId = 900000002;

await writeFile(statsFile, JSON.stringify({
  version: 2,
  trackingSince: new Date().toISOString(),
  users: {
    [legacyUserId]: {
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      premiumHqCompletedCount: 8,
      premiumHqCompleted: true,
      completedUse: true,
      channelGateCounterVersion: 2,
      channelUseCount: 5,
      joinPromptSent: true,
    },
  },
  monthlyDownloads: {},
}), 'utf8');

const {
  CHANNEL_GATE_THRESHOLD,
  getChannelUseCount,
  hasChannelGateRequired,
  hasJoinPromptBeenSent,
  markPremiumHqCompleted,
  recordUsage,
} = await import('../src/bot/stats.js');

try {
  if (CHANNEL_GATE_THRESHOLD !== 1) {
    throw new Error(`Expected threshold 1, got ${CHANNEL_GATE_THRESHOLD}`);
  }

  // Existing users start fresh from this rollout, regardless of old counters.
  await recordUsage(legacyUserId);
  const legacyCount = await getChannelUseCount(legacyUserId);
  const legacyGated = await hasChannelGateRequired(legacyUserId);
  const legacyPromptSent = await hasJoinPromptBeenSent(legacyUserId);
  if (legacyCount !== 0 || legacyGated || legacyPromptSent) {
    throw new Error(`Legacy reset failed: count=${legacyCount}, gated=${legacyGated}, prompt=${legacyPromptSent}`);
  }

  // Ordinary downloads, Android HQ and Live Wallpaper do not trigger this gate.
  for (const event of ['download', 'status_hq', 'live_wallpaper', 'download']) {
    await recordUsage(newUserId, event);
  }
  const beforePremiumCount = await getChannelUseCount(newUserId);
  const beforePremiumGate = await hasChannelGateRequired(newUserId);
  if (beforePremiumCount !== 0 || beforePremiumGate) {
    throw new Error(`Non-Premium events triggered gate: count=${beforePremiumCount}, gated=${beforePremiumGate}`);
  }

  const firstMark = await markPremiumHqCompleted(newUserId, 'test-completion-1');
  const afterPremiumCount = await getChannelUseCount(newUserId);
  const afterPremiumGate = await hasChannelGateRequired(newUserId);
  if (!firstMark || afterPremiumCount !== 1 || !afterPremiumGate) {
    throw new Error(`Premium+ gate failed: marked=${firstMark}, count=${afterPremiumCount}, gated=${afterPremiumGate}`);
  }

  const duplicateMark = await markPremiumHqCompleted(newUserId, 'test-completion-1');
  const afterDuplicateCount = await getChannelUseCount(newUserId);
  if (duplicateMark || afterDuplicateCount !== 1) {
    throw new Error(`Completion idempotency failed: duplicate=${duplicateMark}, count=${afterDuplicateCount}`);
  }

  console.log('CHANNEL_GATE_THRESHOLD_SELFTEST_OK', JSON.stringify({
    threshold: CHANNEL_GATE_THRESHOLD,
    existingUsersRestartFromZero: true,
    ordinaryUsesDoNotGate: true,
    gateAfterFirstPremiumPlusHq: true,
    completionIdempotent: true,
  }));
} finally {
  await rm(statsFile, { force: true }).catch(() => {});
}
