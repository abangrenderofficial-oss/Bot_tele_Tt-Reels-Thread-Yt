const MB = 1024 * 1024;
const DEFAULT_REPO = 'abangrenderofficial-oss/Bot_tele_Tt-Reels-Thread-Yt';
const DEFAULT_WORKFLOW = 'heavy-media.yml';

export function heavyMediaMaxBytes() {
  const mb = Number(process.env.HEAVY_MEDIA_MAX_MB || 250);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : 250;
  return Math.floor(safeMb * MB);
}

export function heavyMediaThresholdBytes() {
  const mb = Number(process.env.HEAVY_MEDIA_THRESHOLD_MB || 18);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : 18;
  return Math.floor(safeMb * MB);
}

export function shouldUseHeavyMedia(fileSize = 0) {
  const size = Number(fileSize || 0);
  return Number.isFinite(size) && size > heavyMediaThresholdBytes();
}

function githubRepo() {
  return String(process.env.GITHUB_ACTIONS_REPO || DEFAULT_REPO).trim() || DEFAULT_REPO;
}

function workflowName() {
  return String(process.env.GITHUB_HEAVY_MEDIA_WORKFLOW || DEFAULT_WORKFLOW).trim() || DEFAULT_WORKFLOW;
}

function githubToken() {
  const token = String(process.env.GITHUB_ACTIONS_TOKEN || '').trim();
  if (!token) {
    const err = new Error('GitHub Actions token is not configured.');
    err.code = 'HEAVY_WORKER_NOT_CONFIGURED';
    throw err;
  }
  return token;
}

export async function dispatchHeavyMediaJob({
  chatId,
  videoFileId,
  fileSize = 0,
  action = 'status_hq',
  progressMessageId = 0,
  sourceMessageId = 0,
}) {
  if (!chatId || !videoFileId) {
    const err = new Error('Heavy-media dispatch requires chat_id and video file_id.');
    err.code = 'HEAVY_WORKER_INPUT_MISSING';
    throw err;
  }

  const size = Number(fileSize || 0);
  if (size > heavyMediaMaxBytes()) {
    const err = new Error(`Video exceeds heavy-media limit (${size} bytes).`);
    err.code = 'HEAVY_MEDIA_TOO_LARGE';
    throw err;
  }

  const repo = githubRepo();
  const endpoint = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowName())}/dispatches`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AbangRender-Telegram-Heavy-Media',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: String(process.env.GITHUB_HEAVY_MEDIA_REF || 'main'),
      inputs: {
        chat_id: String(chatId),
        video_file_id: String(videoFileId),
        file_size: String(Math.max(0, Math.floor(size))),
        action: String(action || 'status_hq'),
        progress_message_id: String(Math.max(0, Number(progressMessageId || 0))),
        source_message_id: String(Math.max(0, Number(sourceMessageId || 0))),
      },
    }),
    signal: AbortSignal.timeout(Number(process.env.GITHUB_ACTIONS_DISPATCH_TIMEOUT_MS || 12000)),
  });

  if (response.status !== 204) {
    const body = await response.text().catch(() => '');
    const err = new Error(`GitHub heavy-media dispatch failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ''}`);
    err.code = 'HEAVY_WORKER_DISPATCH_FAILED';
    err.status = response.status;
    throw err;
  }

  return { ok: true, repo, workflow: workflowName() };
}
