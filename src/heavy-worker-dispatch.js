const DEFAULT_OWNER = 'abangrenderofficial-oss';
const DEFAULT_REPO = 'Bot_tele_Tt-Reels-Thread-Yt';
const DEFAULT_WORKFLOW = 'heavy-status-hq.yml';

function githubToken() {
  return String(process.env.GITHUB_ACTIONS_TOKEN || process.env.GH_ACTIONS_TOKEN || '').trim();
}

export function heavyWorkerConfigured() {
  return Boolean(githubToken());
}

export function heavyVideoLimitBytes() {
  const configuredMb = Number(process.env.HEAVY_VIDEO_MAX_MB || 250);
  const mb = Number.isFinite(configuredMb) && configuredMb > 0 ? Math.min(configuredMb, 250) : 250;
  return Math.floor(mb * 1024 * 1024);
}

export function shouldUseHeavyWorker(video = {}) {
  const fileSize = Number(video?.file_size || 0);
  // Telegram cloud Bot API getFile is limited to 20 MB. Keep a small safety margin.
  return fileSize > (19 * 1024 * 1024);
}

export async function dispatchHeavyStatusJob({ chatId, messageId, fileSize = 0, progressMessageId = 0 }) {
  const token = githubToken();
  if (!token) {
    const error = new Error('GitHub heavy-media worker token is not configured.');
    error.code = 'HEAVY_WORKER_NOT_CONFIGURED';
    throw error;
  }

  if (!chatId || !messageId) {
    const error = new Error('Heavy-media worker requires chatId and messageId.');
    error.code = 'HEAVY_WORKER_BAD_INPUT';
    throw error;
  }

  const owner = String(process.env.GITHUB_WORKER_OWNER || DEFAULT_OWNER).trim();
  const repo = String(process.env.GITHUB_WORKER_REPO || DEFAULT_REPO).trim();
  const workflow = String(process.env.GITHUB_WORKER_WORKFLOW || DEFAULT_WORKFLOW).trim();
  const ref = String(process.env.GITHUB_WORKER_REF || 'main').trim();
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'AbangRender-Telegram-HeavyWorker/1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref,
      inputs: {
        chat_id: String(chatId),
        message_id: String(messageId),
        file_size: String(Math.max(0, Number(fileSize) || 0)),
        progress_message_id: String(Math.max(0, Number(progressMessageId) || 0)),
      },
    }),
    signal: AbortSignal.timeout(Number(process.env.GITHUB_WORKER_DISPATCH_TIMEOUT_MS || 12000)),
  });

  if (response.status !== 204) {
    const body = await response.text().catch(() => '');
    const error = new Error(`GitHub worker dispatch failed with HTTP ${response.status}${body ? `: ${body.slice(0, 400)}` : ''}`);
    error.code = 'HEAVY_WORKER_DISPATCH_FAILED';
    throw error;
  }

  return true;
}
