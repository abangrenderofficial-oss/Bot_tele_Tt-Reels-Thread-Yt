import { AsyncLocalStorage } from 'node:async_hooks';

const STATE_KEY = Symbol.for('abangrender.downloader.user-job-queue.v1');
const jobContext = new AsyncLocalStorage();

function numericEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || 0);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function globalConcurrency() {
  return numericEnv('HEAVY_GLOBAL_CONCURRENCY', 3, 1, 8);
}

function perUserLimit() {
  return numericEnv('HEAVY_USER_QUEUE_LIMIT', 5, 1, 10);
}

function state() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      active: 0,
      users: new Map(),
    };
  }
  return globalThis[STATE_KEY];
}

function userKey(userId) {
  const id = Number(userId || 0);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

function laneFor(key) {
  const s = state();
  let lane = s.users.get(key);
  if (!lane) {
    lane = { active: false, queue: [] };
    s.users.set(key, lane);
  }
  return lane;
}

function cleanupLane(key, lane) {
  const s = state();
  if (!lane.active && lane.queue.length === 0 && s.users.get(key) === lane) {
    s.users.delete(key);
  }
}

function pump() {
  const s = state();
  const limit = globalConcurrency();

  while (s.active < limit) {
    let picked = null;
    for (const [key, lane] of s.users) {
      if (!lane.active && lane.queue.length) {
        picked = { key, lane, item: lane.queue.shift() };
        break;
      }
    }
    if (!picked) return;

    const { key, lane, item } = picked;
    lane.active = true;
    s.active += 1;

    Promise.resolve()
      .then(async () => {
        if (item.shouldRun && !item.shouldRun()) return { skipped: true };
        return jobContext.run({ userKey: key }, () => item.task());
      })
      .then(item.resolve, item.reject)
      .finally(() => {
        lane.active = false;
        s.active = Math.max(0, s.active - 1);
        cleanupLane(key, lane);
        queueMicrotask(pump);
      });
  }
}

export function currentUserJobKey() {
  return String(jobContext.getStore()?.userKey || '');
}

export function enqueueUserHeavyJob(userId, task, options = {}) {
  const key = userKey(userId);
  if (!key || typeof task !== 'function') {
    return { accepted: false, queued: false, position: 0, reason: 'invalid_job', done: null };
  }

  const lane = laneFor(key);
  const alreadyForUser = (lane.active ? 1 : 0) + lane.queue.length;
  const maxForUser = perUserLimit();
  if (alreadyForUser >= maxForUser) {
    return {
      accepted: false,
      queued: true,
      position: lane.queue.length,
      reason: 'user_queue_full',
      done: null,
      limit: maxForUser,
    };
  }

  const s = state();
  const queued = lane.active || s.active >= globalConcurrency();
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  lane.queue.push({
    task,
    shouldRun: typeof options.shouldRun === 'function' ? options.shouldRun : null,
    resolve: resolveDone,
    reject: rejectDone,
  });

  const position = queued ? lane.queue.length : 0;
  pump();

  return {
    accepted: true,
    queued,
    position,
    reason: queued ? 'queued' : 'started',
    done,
    limit: maxForUser,
  };
}

export function userHeavyQueueInfo(userId) {
  const key = userKey(userId);
  const lane = key ? state().users.get(key) : null;
  return {
    active: Boolean(lane?.active),
    waiting: lane?.queue?.length || 0,
    globalActive: state().active,
    globalLimit: globalConcurrency(),
    userLimit: perUserLimit(),
  };
}
