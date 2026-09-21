import { currentUserJobKey } from './user-job-queue.js';

const STATE_KEY = Symbol.for('abangrender.downloader.job-lanes.v1');

function state() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = new Map();
  return globalThis[STATE_KEY];
}

export async function withJobLane(name, task) {
  const lanes = state();
  const laneName = String(name || 'default');
  const lane = lanes.get(laneName) || { tail: Promise.resolve(), pending: 0 };
  const waitFor = lane.tail;
  let release;
  lane.pending += 1;
  lane.tail = new Promise((resolve) => { release = resolve; });
  lanes.set(laneName, lane);

  await waitFor;
  try {
    return await task();
  } finally {
    lane.pending -= 1;
    release();
    if (lane.pending <= 0 && lanes.get(laneName) === lane) lanes.delete(laneName);
  }
}

export function localMediaLane(task) {
  const userKey = currentUserJobKey();
  const lane = userKey
    ? `railway-local-media-heavy:user:${userKey}`
    : 'railway-local-media-heavy:shared';
  return withJobLane(lane, task);
}
