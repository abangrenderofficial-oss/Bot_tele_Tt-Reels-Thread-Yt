import json
import math
import os
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
# For the current iPhone Live Wallpaper experiment we keep the source video's
# original duration when Telegram can carry it. Telegram's Live Photo video
# transport rejects clips above 10 seconds, so we cap at 9.8s for headroom.
MIN_WALLPAPER_SOURCE_SECONDS = 1.0
MAX_TELEGRAM_LIVE_SECONDS = 9.8
TARGET_MOTION_BYTES = 6.5 * MB
MAX_RAW_MOTION_BYTES = 9 * MB
MAX_PAIRED_MOTION_BYTES = 10 * MB


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
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
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


def wallpaper_filter(probe):
    width, height, needs_portrait_crop = target_dimensions(probe['width'], probe['height'])
    if needs_portrait_crop:
        return (
            'scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,'
            'crop=1080:1920,setsar=1,fps=60,setpts=PTS-STARTPTS'
        )
    return f'scale={width}:{height}:flags=lanczos,setsar=1,fps=60,setpts=PTS-STARTPTS'


def encode_motion_and_cover(source, raw_movie, raw_cover, probe):
    # Preserve the source timeline from the beginning, but respect Telegram's
    # Live Photo transport limit. Source clips up to 9.8s keep their full length;
    # longer clips are capped to 9.8s instead of being rejected as VIDEO_INVALID.
    clip_start = 0.0
    source_duration = probe['duration']
    duration = min(source_duration, MAX_TELEGRAM_LIVE_SECONDS)
    duration_mode = 'original' if source_duration <= MAX_TELEGRAM_LIVE_SECONDS else 'telegram_cap'

    # Adapt bitrate to the actual output duration so the paired motion still has a
    # chance to fit Telegram's Live Photo payload size limit. Short clips can use
    # up to 6.5 Mbps; longer clips progressively use a lower bitrate.
    total_kbps = int((TARGET_MOTION_BYTES * 8 / duration / 1000) * 0.90)
    video_kbps = max(350, min(6500, total_kbps))
    run(
        [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-i', str(source),
            '-t', f'{duration:.6f}', '-map', '0:v:0', '-an',
            '-vf', wallpaper_filter(probe),
            '-c:v', 'hevc_videotoolbox', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
            '-tag:v', 'hvc1', '-b:v', f'{video_kbps}k',
            '-g', '60',
            '-map_metadata', '-1',
            '-video_track_timescale', '600', '-f', 'mov', str(raw_movie),
        ],
        timeout=900,
    )
    if not raw_movie.exists() or raw_movie.stat().st_size <= 0:
        raise RuntimeError('Live Wallpaper motion file tidak terhasil.')
    if raw_movie.stat().st_size > MAX_RAW_MOTION_BYTES:
        raise RuntimeError(
            f'Live Wallpaper motion terlalu besar selepas duration diproses: '
            f'{raw_movie.stat().st_size / MB:.2f}MB.'
        )

    # Device-verified wallpaper pipelines use a cover continuous with the
    # opening motion frame. Midpoint covers can make the Lock Screen animation
    # control unavailable even when the Live Photo pair itself is valid.
    still_at = 0.0
    run(
        [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', f'{still_at:.6f}', '-i', str(raw_movie),
            '-frames:v', '1', '-q:v', '2', str(raw_cover),
        ],
        timeout=120,
    )
    if not raw_cover.exists() or raw_cover.stat().st_size <= 0:
        raise RuntimeError('Live Wallpaper cover tidak terhasil.')

    return {
        'clip_start': clip_start,
        'duration': duration,
        'source_duration': source_duration,
        'duration_mode': duration_mode,
        'video_kbps': video_kbps,
    }



def prepare_wallpaper_metadata(raw_movie, prepared_movie):
    # Inject the device-verified timed metadata template:
    # live-photo-info + still-image-time/transform tracks with cdsc references
    # back to the video track. This is the structure iOS Lock Screen uses beyond
    # ordinary Live Photo recognition.
    run(
        [
            'python3', 'scripts/prepare_wallpaper_video.py',
            str(raw_movie), str(prepared_movie),
        ],
        timeout=180,
    )
    if not prepared_movie.exists() or prepared_movie.stat().st_size <= 0:
        raise RuntimeError('Wallpaper metadata MOV tidak terhasil.')
    if prepared_movie.stat().st_size > MAX_RAW_MOTION_BYTES:
        raise RuntimeError(
            f'Wallpaper metadata MOV terlalu besar: '
            f'{prepared_movie.stat().st_size / MB:.2f}MB.'
        )


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
    if paired_movie.stat().st_size > MAX_PAIRED_MOTION_BYTES:
        raise RuntimeError(
            f'Paired Apple Live Photo MOV melebihi 10MB: '
            f'{paired_movie.stat().st_size / MB:.2f}MB.'
        )


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
    app = Client(
        'apple_live_worker',
        api_id=API_ID,
        api_hash=API_HASH,
        bot_token=BOT_TOKEN,
        in_memory=True,
    )
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
        f'apple live worker input={FILE_SIZE} chat={CHAT_ID} duration_policy=original_up_to_9.8s',
        flush=True,
    )

    with tempfile.TemporaryDirectory(prefix='abangrender-apple-live-') as temp_dir:
        temp = Path(temp_dir)
        source = temp / 'source-video.bin'
        raw_movie = temp / 'motion-raw.mov'
        raw_cover = temp / 'cover-raw.jpg'
        prepared_movie = temp / 'motion-wallpaper-metadata.mov'
        paired_movie = temp / 'live-wallpaper.mov'
        paired_cover = temp / 'live-wallpaper.jpg'

        download_source(source)
        probe = probe_video(source)
        print(f'probe={probe}', flush=True)

        set_progress(42)
        clip = encode_motion_and_cover(source, raw_movie, raw_cover, probe)
        print(f'wallpaper_profile={clip}', flush=True)

        set_progress(60)
        prepare_wallpaper_metadata(raw_movie, prepared_movie)
        print(
            f'wallpaper metadata movie={prepared_movie.stat().st_size}',
            flush=True,
        )

        set_progress(74)
        pair_apple_live_photo(raw_cover, prepared_movie, paired_cover, paired_movie)
        print(
            f'paired sizes movie={paired_movie.stat().st_size} '
            f'photo={paired_cover.stat().st_size}',
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
