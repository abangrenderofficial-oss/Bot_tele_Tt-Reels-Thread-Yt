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
      premiumHqCompletedCount: 3,
      premiumHqCompleted: false,
      completedUse: true,
      channelGateCounterVersion: 1,
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
  recordUsage,
} = await import('../src/bot/stats.js');

try {
  if (CHANNEL_GATE_THRESHOLD !== 5) {
    throw new Error(`Expected threshold 5, got ${CHANNEL_GATE_THRESHOLD}`);
  }

  // Existing users restart their channel allowance from this rollout.
  await recordUsage(legacyUserId);
  const legacyCount = await getChannelUseCount(legacyUserId);
  const legacyGated = await hasChannelGateRequired(legacyUserId);
  const legacyPromptSent = await hasJoinPromptBeenSent(legacyUserId);
  if (legacyCount !== 0 || legacyGated || legacyPromptSent) {
    throw new Error(`Legacy reset failed: count=${legacyCount}, gated=${legacyGated}, prompt=${legacyPromptSent}`);
  }

  const events = ['download', 'status_hq', 'live_wallpaper', 'download', 'status_hq'];
  for (let index = 0; index < events.length; index += 1) {
    const use = index + 1;
    await recordUsage(newUserId, events[index]);
    const count = await getChannelUseCount(newUserId);
    const gated = await hasChannelGateRequired(newUserId);
    const shouldGateNextUse = use >= CHANNEL_GATE_THRESHOLD;
    if (count !== use || gated !== shouldGateNextUse) {
      throw new Error(`Unexpected gate state after use ${use}: count=${count}, gated=${gated}`);
    }
  }

  await recordUsage(newUserId);
  const afterPassiveUpdate = await getChannelUseCount(newUserId);
  if (afterPassiveUpdate !== 5) {
    throw new Error(`Passive webhook update changed count: ${afterPassiveUpdate}`);
  }

  const invalidAccepted = await recordUsage(newUserId, 'not-a-real-use');
  const afterInvalid = await getChannelUseCount(newUserId);
  if (invalidAccepted || afterInvalid !== 5) {
    throw new Error(`Invalid event changed count: accepted=${invalidAccepted}, count=${afterInvalid}`);
  }

  console.log('CHANNEL_GATE_THRESHOLD_SELFTEST_OK', JSON.stringify({
    threshold: CHANNEL_GATE_THRESHOLD,
    existingUsersRestartFromZero: true,
    freeCompletedUses: 5,
    blocksBeforeUse: 6,
    counts: ['download', 'status_hq', 'live_wallpaper'],
    passiveUpdatesDoNotCount: true,
  }));
} finally {
  await rm(statsFile, { force: true }).catch(() => {});
}
