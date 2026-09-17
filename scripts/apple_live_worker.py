import json
import math
import os
import re
import subprocess
import tempfile
from pathlib import Path

import requests
from pyrogram import Client

MB = 1024 * 1024
BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '').strip()
API_ID = int(os.environ.get('TELEGRAM_API_ID', '0') or 0)
API_HASH = os.environ.get('TELEGRAM_API_HASH', '').strip()
CHAT_ID = int(os.environ.get('HEAVY_CHAT_ID', '0') or 0)
VIDEO_FILE_ID = os.environ.get('HEAVY_VIDEO_FILE_ID', '').strip()
FILE_SIZE = int(os.environ.get('HEAVY_FILE_SIZE', '0') or 0)
PROGRESS_MESSAGE_ID = int(os.environ.get('HEAVY_PROGRESS_MESSAGE_ID', '0') or 0)
SOURCE_MESSAGE_ID = int(os.environ.get('HEAVY_SOURCE_MESSAGE_ID', '0') or 0)
MAX_INPUT_MB = int(os.environ.get('HEAVY_VIDEO_MAX_MB', '500') or 500)
MAX_INPUT_BYTES = MAX_INPUT_MB * MB
BOT_API_BASE = os.environ.get('TELEGRAM_API_BASE_URL', 'https://api.telegram.org').rstrip('/')

# This worker is intentionally isolated from Status HQ and the normal downloader.
# It targets iOS Lock Screen compatibility rather than Telegram's generic 10-second
# Live Photo allowance. Keep the motion short and predictable.
WALLPAPER_DURATION = max(1.0, min(2.0, float(os.environ.get('APPLE_WALLPAPER_DURATION', '1.5') or 1.5)))
SCENE_ANALYZE_SECONDS = max(
    WALLPAPER_DURATION,
    min(10.0, float(os.environ.get('APPLE_WALLPAPER_ANALYZE_SECONDS', '6') or 6)),
)
SCENE_THRESHOLD = max(0.15, min(0.80, float(os.environ.get('APPLE_WALLPAPER_SCENE_THRESHOLD', '0.35') or 0.35)))
MIN_WALLPAPER_SOURCE_SECONDS = 1.0


def require_config():
    missing = []
    if not BOT_TOKEN:
        missing.append('TELEGRAM_BOT_TOKEN')
    if not API_ID:
        missing.append('TELEGRAM_API_ID')
    if not API_HASH:
        missing.append('TELEGRAM_API_HASH')
    if not CHAT_ID:
        missing.append('HEAVY_CHAT_ID')
    if not VIDEO_FILE_ID:
        missing.append('HEAVY_VIDEO_FILE_ID')
    if missing:
        raise RuntimeError('Missing required configuration: ' + ', '.join(missing))
    if FILE_SIZE > MAX_INPUT_BYTES:
        raise RuntimeError(f'Video exceeds {MAX_INPUT_MB}MB Live Photo limit.')


def telegram_call(method, data=None, files=None, timeout=180):
    response = requests.post(
        f'{BOT_API_BASE}/bot{BOT_TOKEN}/{method}',
        data=data or {},
        files=files,
        timeout=timeout,
    )
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f'Telegram {method} returned HTTP {response.status_code}') from exc
    if not response.ok or not payload.get('ok'):
        raise RuntimeError(payload.get('description') or f'Telegram {method} failed ({response.status_code})')
    return payload.get('result')


def progress_text(percent):
    value = max(1, min(100, int(round(percent))))
    filled = 10 if value >= 100 else min(9, value // 10)
    bar = '▰' * filled + '▱' * (10 - filled)
    return f'🍎 Live Wallpaper iPhone sedang diproses...\n{bar} {value}%'


def set_progress(percent):
    if not PROGRESS_MESSAGE_ID:
        return
    try:
        telegram_call(
            'editMessageText',
            {
                'chat_id': str(CHAT_ID),
                'message_id': str(PROGRESS_MESSAGE_ID),
                'text': progress_text(percent),
            },
            timeout=30,
        )
    except Exception as exc:
        print(f'progress update failed: {exc}', flush=True)


def finish_progress():
    if not PROGRESS_MESSAGE_ID:
        return
    try:
        telegram_call(
            'deleteMessage',
            {'chat_id': str(CHAT_ID), 'message_id': str(PROGRESS_MESSAGE_ID)},
            timeout=30,
        )
    except Exception as exc:
        print(f'progress delete failed: {exc}', flush=True)


def fail_progress(message):
    text = f'❌ {message}'[:4096]
    if PROGRESS_MESSAGE_ID:
        try:
            telegram_call(
                'editMessageText',
                {'chat_id': str(CHAT_ID), 'message_id': str(PROGRESS_MESSAGE_ID), 'text': text},
                timeout=30,
            )
            return
        except Exception:
            pass
    try:
        telegram_call('sendMessage', {'chat_id': str(CHAT_ID), 'text': text}, timeout=30)
    except Exception:
        pass


def run(cmd, timeout=900):
    print('$ ' + ' '.join(str(x) for x in cmd), flush=True)
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    if result.stdout:
        print(result.stdout[-4000:], flush=True)
    if result.returncode != 0:
        if result.stderr:
            print(result.stderr[-8000:], flush=True)
        raise RuntimeError(f'Command failed ({result.returncode}): {cmd[0]}')
    return result


def probe_video(path):
    result = run(
        [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height:format=duration',
            '-of', 'json', str(path),
        ],
        timeout=60,
    )
    payload = json.loads(result.stdout or '{}')
    streams = payload.get('streams') or []
    stream = streams[0] if streams else {}
    duration = float((payload.get('format') or {}).get('duration') or 0)
    width = int(stream.get('width') or 0)
    height = int(stream.get('height') or 0)
    if duration <= 0 or width <= 0 or height <= 0:
        raise RuntimeError('Tak dapat baca metadata video untuk Live Wallpaper iPhone.')
    if duration < MIN_WALLPAPER_SOURCE_SECONDS:
        raise RuntimeError('Video terlalu pendek. Live Wallpaper perlukan sekurang-kurangnya 1 saat video.')
    return {'duration': duration, 'width': width, 'height': height}


def even_floor(value):
    return max(2, int(math.floor(value / 2.0) * 2))


def target_dimensions(width, height):
    # Native portrait clips keep their original aspect ratio. Landscape / nearly
    # square clips are converted into a 9:16 portrait canvas because otherwise
    # iOS has to perform an aggressive wallpaper crop itself.
    ratio = width / max(1, height)
    if ratio > 0.78:
        return 1080, 1920, True

    max_w, max_h = 1080, 1920
    scale = min(1.0, max_w / width, max_h / height)
    return even_floor(width * scale), even_floor(height * scale), False


def detect_scene_cuts(source, probe):
    scan_seconds = min(probe['duration'], SCENE_ANALYZE_SECONDS)
    if scan_seconds <= WALLPAPER_DURATION + 0.15:
        return []

    filter_value = f'select=gt(scene\\,{SCENE_THRESHOLD:.3f}),showinfo'
    cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'info',
        '-t', f'{scan_seconds:.3f}', '-i', str(source),
        '-an', '-vf', filter_value, '-f', 'null', '-',
    ]
    print('$ ' + ' '.join(str(x) for x in cmd), flush=True)
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
    except Exception as exc:
        print(f'scene scan skipped: {exc}', flush=True)
        return []

    if result.returncode != 0:
        print(f'scene scan returned {result.returncode}; using fallback clip window', flush=True)
        return []

    values = []
    for match in re.finditer(r'pts_time:([0-9]+(?:\.[0-9]+)?)', result.stderr or ''):
        value = float(match.group(1))
        if 0.05 < value < scan_seconds - 0.05:
            values.append(value)
    return sorted(set(values))


def choose_motion_window(source, probe):
    duration = min(WALLPAPER_DURATION, probe['duration'])
    max_start = max(0.0, probe['duration'] - duration)
    if max_start <= 0.001:
        return 0.0, duration

    scan_end = min(probe['duration'], SCENE_ANALYZE_SECONDS)
    cuts = detect_scene_cuts(source, probe)
    boundaries = [0.0] + [cut for cut in cuts if cut < scan_end] + [scan_end]
    margin = 0.08

    for left, right in zip(boundaries, boundaries[1:]):
        safe_left = left + (margin if left > 0 else min(0.12, margin))
        safe_right = right - margin
        if safe_right - safe_left >= duration:
            start = min(max_start, max(0.0, safe_left))
            print(
                f'wallpaper clip selected start={start:.3f}s duration={duration:.3f}s '
                f'cuts={cuts[:12]}',
                flush=True,
            )
            return start, duration

    # Fallback: avoid a potentially blank/fade first frame while staying near the
    # beginning so the result still resembles what the user selected.
    start = min(max_start, 0.12)
    print(
        f'wallpaper clip fallback start={start:.3f}s duration={duration:.3f}s cuts={cuts[:12]}',
        flush=True,
    )
    return start, duration


def wallpaper_filter(probe):
    width, height, needs_portrait_crop = target_dimensions(probe['width'], probe['height'])
    if needs_portrait_crop:
        return (
            'scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,'
            'crop=1080:1920,setsar=1,fps=30,setpts=PTS-STARTPTS'
        )
    return f'scale={width}:{height}:flags=lanczos,setsar=1,fps=30,setpts=PTS-STARTPTS'


def encode_motion_and_cover(source, raw_movie, raw_cover, probe):
    clip_start, duration = choose_motion_window(source, probe)
    target_bytes = 6.5 * MB
    total_kbps = int((target_bytes * 8 / duration / 1000) * 0.85)
    video_kbps = max(1800, min(6500, total_kbps - 120))
    maxrate = max(video_kbps, int(video_kbps * 1.10))
    bufsize = max(3000, maxrate * 2)

    # Deliberately video-only. Apple Live Wallpaper does not need audio, and
    # keeping this stream simple makes the native AVFoundation pairing safer.
    run(
        [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', f'{clip_start:.3f}', '-i', str(source),
            '-t', f'{duration:.3f}', '-map', '0:v:0', '-an',
            '-vf', wallpaper_filter(probe),
            '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p',
            '-profile:v', 'high', '-level:v', '4.0',
            '-b:v', f'{video_kbps}k', '-maxrate', f'{maxrate}k', '-bufsize', f'{bufsize}k',
            '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
            '-movflags', '+faststart', '-map_metadata', '-1',
            '-video_track_timescale', '60000', '-f', 'mov', str(raw_movie),
        ],
        timeout=600,
    )
    if not raw_movie.exists() or raw_movie.stat().st_size <= 0:
        raise RuntimeError('Live Wallpaper motion file tidak terhasil.')
    if raw_movie.stat().st_size > 9 * MB:
        raise RuntimeError(f'Live Wallpaper motion terlalu besar: {raw_movie.stat().st_size / MB:.2f}MB.')

    still_at = max(0.0, duration * 0.5)
    run(
        [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', f'{still_at:.3f}', '-i', str(raw_movie),
            '-frames:v', '1', '-q:v', '2', str(raw_cover),
        ],
        timeout=120,
    )
    if not raw_cover.exists() or raw_cover.stat().st_size <= 0:
        raise RuntimeError('Live Wallpaper cover tidak terhasil.')

    return {'clip_start': clip_start, 'duration': duration}


def pair_apple_live_photo(raw_cover, raw_movie, paired_cover, paired_movie):
    run(
        [
            'swift', 'scripts/apple_live_photo_pair.swift',
            str(raw_cover), str(raw_movie), str(paired_cover), str(paired_movie),
        ],
        timeout=600,
    )
    if not paired_cover.exists() or not paired_movie.exists():
        raise RuntimeError('Native Apple Live Photo pairing tidak menghasilkan fail lengkap.')
    if paired_movie.stat().st_size > 10 * MB:
        raise RuntimeError(f'Paired Apple Live Photo MOV melebihi 10MB: {paired_movie.stat().st_size / MB:.2f}MB.')


def send_live_photo(movie_path, photo_path):
    with movie_path.open('rb') as movie, photo_path.open('rb') as photo:
        telegram_call(
            'sendLivePhoto',
            {
                'chat_id': str(CHAT_ID),
                'caption': 'Live Wallpaper iPhone dah siap 🍎\nSimpan ke Photos, kemudian cuba Use as Wallpaper.',
            },
            {
                'live_photo': ('live-wallpaper.mov', movie, 'video/quicktime'),
                'photo': ('live-wallpaper.jpg', photo, 'image/jpeg'),
            },
            timeout=300,
        )


def download_source(path):
    set_progress(5)
    app = Client('apple_live_worker', api_id=API_ID, api_hash=API_HASH, bot_token=BOT_TOKEN, in_memory=True)
    with app:
        downloaded = app.download_media(VIDEO_FILE_ID, file_name=str(path))
        if not downloaded and SOURCE_MESSAGE_ID:
            try:
                message = app.get_messages(CHAT_ID, SOURCE_MESSAGE_ID)
                downloaded = app.download_media(message, file_name=str(path))
            except Exception as exc:
                print(f'message fallback failed: {exc}', flush=True)
        if not downloaded:
            raise RuntimeError('MTProto tak dapat download video Telegram ini.')
    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError('Video download kosong.')
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise RuntimeError(f'Video melebihi limit {MAX_INPUT_MB}MB.')
    set_progress(30)


def main():
    require_config()
    print(
        f'apple live worker input={FILE_SIZE} chat={CHAT_ID} '
        f'wallpaper_duration={WALLPAPER_DURATION:.3f}s scene_threshold={SCENE_THRESHOLD:.3f}',
        flush=True,
    )
    with tempfile.TemporaryDirectory(prefix='abangrender-apple-live-') as temp_dir:
        temp = Path(temp_dir)
        source = temp / 'source-video.bin'
        raw_movie = temp / 'motion-raw.mov'
        raw_cover = temp / 'cover-raw.jpg'
        paired_movie = temp / 'live-wallpaper.mov'
        paired_cover = temp / 'live-wallpaper.jpg'

        download_source(source)
        probe = probe_video(source)
        print(f'probe={probe}', flush=True)

        set_progress(42)
        clip = encode_motion_and_cover(source, raw_movie, raw_cover, probe)
        print(f'wallpaper_profile={clip}', flush=True)
        set_progress(68)
        pair_apple_live_photo(raw_cover, raw_movie, paired_cover, paired_movie)
        print(
            f'paired sizes movie={paired_movie.stat().st_size} photo={paired_cover.stat().st_size}',
            flush=True,
        )
        set_progress(88)
        send_live_photo(paired_movie, paired_cover)
        set_progress(100)
        finish_progress()
        print('apple live wallpaper worker complete', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'apple live worker failed: {type(exc).__name__}: {exc}', flush=True)
        fail_progress('Live Wallpaper iPhone tak berjaya diproses. Cuba hantar video semula.')
        raise
