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
      premiumHqCompletedCount: 3,
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

  // Existing users restart from this rollout, even if an older gate had already been reached.
  await recordUsage(legacyUserId);
  const legacyCount = await getChannelUseCount(legacyUserId);
  const legacyGated = await hasChannelGateRequired(legacyUserId);
  const legacyPromptSent = await hasJoinPromptBeenSent(legacyUserId);
  if (legacyCount !== 0 || legacyGated || legacyPromptSent) {
    throw new Error(`Legacy reset failed: count=${legacyCount}, gated=${legacyGated}, prompt=${legacyPromptSent}`);
  }

  // Normal downloads, Status HQ accounting and Live Wallpaper must not trigger the channel gate.
  const events = ['download', 'status_hq', 'live_wallpaper', 'download', 'status_hq'];
  for (const event of events) {
    await recordUsage(newUserId, event);
    const count = await getChannelUseCount(newUserId);
    const gated = await hasChannelGateRequired(newUserId);
    if (count !== 0 || gated) {
      throw new Error(`Non-Premium event triggered gate: event=${event}, count=${count}, gated=${gated}`);
    }
  }

  // The first successful Premium + HQ completion activates the gate.
  await markPremiumHqCompleted(newUserId);
  const afterPremiumCount = await getChannelUseCount(newUserId);
  const afterPremiumGated = await hasChannelGateRequired(newUserId);
  if (afterPremiumCount !== 1 || !afterPremiumGated) {
    throw new Error(`Premium completion did not trigger gate: count=${afterPremiumCount}, gated=${afterPremiumGated}`);
  }

  // Repeated completion notifications stay idempotent for the gate counter.
  await markPremiumHqCompleted(newUserId);
  const afterDuplicateCompletion = await getChannelUseCount(newUserId);
  if (afterDuplicateCompletion !== 1) {
    throw new Error(`Duplicate completion changed gate counter: count=${afterDuplicateCompletion}`);
  }

  await recordUsage(newUserId);
  const afterPassiveUpdate = await getChannelUseCount(newUserId);
  if (afterPassiveUpdate !== 1) {
    throw new Error(`Passive webhook update changed count: ${afterPassiveUpdate}`);
  }

  const invalidAccepted = await recordUsage(newUserId, 'not-a-real-use');
  const afterInvalid = await getChannelUseCount(newUserId);
  if (invalidAccepted || afterInvalid !== 1) {
    throw new Error(`Invalid event changed count: accepted=${invalidAccepted}, count=${afterInvalid}`);
  }

  console.log('CHANNEL_GATE_THRESHOLD_SELFTEST_OK', JSON.stringify({
    threshold: CHANNEL_GATE_THRESHOLD,
    existingUsersRestartFromZero: true,
    normalFeaturesDoNotCount: true,
    premiumHqSuccessesBeforeGate: 1,
    duplicateCompletionIsIdempotent: true,
    passiveUpdatesDoNotCount: true,
  }));
} finally {
  await rm(statsFile, { force: true }).catch(() => {});
}
