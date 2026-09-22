import { createHash } from 'node:crypto';

const DEFAULT_OWNER = 'abangrenderofficial-oss';
const DEFAULT_REPO = 'mdab-129';
const DEFAULT_WORKFLOW = 'heavy-status-hq.yml';
const MB = 1024 * 1024;

function githubToken() {
  return String(process.env.GITHUB_ACTIONS_TOKEN || process.env.GH_ACTIONS_TOKEN || '').trim();
}

function completionIdFor({ chatId, videoFileId, action, sourceMessageId }) {
  return createHash('sha256')
    .update(`${chatId}|${videoFileId}|${action}|${sourceMessageId}`)
    .digest('hex')
    .slice(0, 40);
}

export function heavyWorkerConfigured() {
  return Boolean(githubToken());
}

export function heavyVideoLimitBytes() {
  const configuredMb = Number(process.env.HEAVY_VIDEO_MAX_MB || 150);
  const mb = Number.isFinite(configuredMb) && configuredMb > 0 ? Math.min(configuredMb, 500) : 150;
  return Math.floor(mb * MB);
}

export function shouldUseHeavyWorker(video = {}) {
  const fileSize = Number(video?.file_size || video?.fileSize || 0);
  const thresholdMb = Number(process.env.HEAVY_VIDEO_THRESHOLD_MB || 18);
  const threshold = (Number.isFinite(thresholdMb) && thresholdMb > 0 ? thresholdMb : 18) * MB;
  return fileSize > threshold;
}

export async function dispatchHeavyMediaJob({
  chatId,
  videoFileId,
  fileSize = 0,
  action = 'status_hq',
  sourceKind = 'link',
  progressMessageId = 0,
  sourceMessageId = 0,
  completionUrl = '',
}) {
  const token = githubToken();
  if (!token) {
    const error = new Error('GitHub heavy-media worker token is not configured.');
    error.code = 'HEAVY_WORKER_NOT_CONFIGURED';
    throw error;
  }

  if (!chatId || !videoFileId) {
    const error = new Error('Heavy-media worker requires chatId and videoFileId.');
    error.code = 'HEAVY_WORKER_BAD_INPUT';
    throw error;
  }

  const size = Math.max(0, Number(fileSize) || 0);
  if (size > heavyVideoLimitBytes()) {
    const error = new Error(`Video exceeds heavy-worker limit (${size} bytes).`);
    error.code = 'HEAVY_MEDIA_TOO_LARGE';
    throw error;
  }

  const owner = String(process.env.GITHUB_WORKER_OWNER || DEFAULT_OWNER).trim();
  const repo = String(process.env.GITHUB_WORKER_REPO || DEFAULT_REPO).trim();
  const workflow = String(process.env.GITHUB_WORKER_WORKFLOW || DEFAULT_WORKFLOW).trim();
  const ref = String(process.env.GITHUB_WORKER_REF || 'main').trim();
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const completionId = completionIdFor({ chatId, videoFileId, action, sourceMessageId });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mdab-129/2.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref,
      inputs: {
        chat_id: String(chatId),
        video_file_id: String(videoFileId),
        file_size: String(size),
        action: String(action || 'status_hq'),
        source_kind: String(sourceKind === 'gallery' ? 'gallery' : 'link'),
        progress_message_id: String(Math.max(0, Number(progressMessageId) || 0)),
        source_message_id: String(Math.max(0, Number(sourceMessageId) || 0)),
        completion_url: String(completionUrl || ''),
        completion_id: completionId,
      },
    }),
    signal: AbortSignal.timeout(Number(process.env.GITHUB_WORKER_DISPATCH_TIMEOUT_MS || 12000)),
  });

  if (response.status !== 204) {
    const body = await response.text().catch(() => '');
    const error = new Error(`GitHub worker dispatch failed with HTTP ${response.status}${body ? `: ${body.slice(0, 400)}` : ''}`);
    error.code = 'HEAVY_WORKER_DISPATCH_FAILED';
    error.status = response.status;
    throw error;
  }

  return { completionId };
}
