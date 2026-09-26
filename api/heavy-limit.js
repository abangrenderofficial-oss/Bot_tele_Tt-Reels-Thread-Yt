import { heavyVideoLimitBytes } from '../src/heavy-worker-dispatch.js';

export default async function handler(req, res) {
  const bytes = heavyVideoLimitBytes();
  const mb = Math.round(bytes / 1024 / 1024);
  res.status(200).json({
    ok: mb === 200,
    heavy_video_limit_mb: mb,
    heavy_video_limit_bytes: bytes,
    gallery_premium_hq_codec: 'hevc',
    gallery_premium_hq_pixel_format: 'yuv420p',
    gallery_premium_hq_bit_depth: 8,
    social_premium_hq_preset: 'unchanged',
  });
}
