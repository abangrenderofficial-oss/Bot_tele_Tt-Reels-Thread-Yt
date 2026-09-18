import json
import math
import os
import subprocess
import tempfile
import time
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
SOURCE_KIND = os.environ.get('HEAVY_SOURCE_KIND', 'link').strip().lower()
IS_GALLERY_UPLOAD = SOURCE_KIND == 'gallery'
MAX_INPUT_MB = int(os.environ.get('HEAVY_VIDEO_MAX_MB', '500') or 500)
MAX_INPUT_BYTES = MAX_INPUT_MB * MB
BOT_API_BASE = os.environ.get('TELEGRAM_API_BASE_URL', 'https://api.telegram.org').rstrip('/')

# This worker is intentionally isolated from Status HQ and the normal downloader.
# For the current iPhone Live Wallpaper experiment we keep the source video's
# original duration when Telegram can carry it. Telegram's Live Photo video
# transport rejects clips above 10 seconds, so we cap at 9.8s for headroom.
MIN_WALLPAPER_SOURCE_SECONDS = 0.5
MIN_WALLPAPER_OUTPUT_SECONDS = 1.5
MAX_TELEGRAM_LIVE_SECONDS = 9.8
GALLERY_STILL_TIME_MAX_SECONDS = 1.8
GALLERY_STILL_TIME_END_MARGIN = 0.05
TARGET_MOTION_BYTES = 6.5 * MB
MAX_RAW_MOTION_BYTES = 9 * MB
MAX_PAIRED_MOTION_BYTES = 10 * MB
SAFE_RAW_MOTION_BYTES = int(8.7 * MB)
OUTPUT_FPS = 60
OUTPUT_TIMEBASE = '1/600'
OUTPUT_TIMESCALE = 600
OUTPUT_CODEC = 'hevc'
OUTPUT_CODEC_TAG = 'hvc1'
ENCODE_MAX_ATTEMPTS = 3
SEND_MAX_ATTEMPTS = 3


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
        raise RuntimeError('Video terlalu pendek. Live Wallpaper perlukan sekurang-kurangnya 0.5 saat video.')
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
            f'crop=1080:1920,setsar=1,fps={OUTPUT_FPS},setpts=PTS-STARTPTS'
        )
    return f'scale={width}:{height}:flags=lanczos,setsar=1,fps={OUTPUT_FPS},setpts=PTS-STARTPTS'



def parse_fraction(value):
    text = str(value or '').strip()
    if not text:
        return 0.0
    if '/' in text:
        numerator, denominator = text.split('/', 1)
        denominator_value = float(denominator or 0)
        return float(numerator or 0) / denominator_value if denominator_value else 0.0
    return float(text)


def validate_wallpaper_video(path, expected_duration=None):
    result = run(
        [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries',
            'stream=codec_name,codec_tag_string,width,height,r_frame_rate,time_base:format=duration',
            '-of', 'json', str(path),
        ],
        timeout=60,
    )
    payload = json.loads(result.stdout or '{}')
    streams = payload.get('streams') or []
    if not streams:
        raise RuntimeError('Wallpaper output tak mempunyai video stream.')
    stream = streams[0]
    duration = float((payload.get('format') or {}).get('duration') or 0)
    fps = parse_fraction(stream.get('r_frame_rate'))
    width = int(stream.get('width') or 0)
    height = int(stream.get('height') or 0)

    if stream.get('codec_name') != OUTPUT_CODEC:
        raise RuntimeError(f'Wallpaper codec lari daripada profile: {stream.get("codec_name")}.')
    if stream.get('codec_tag_string') != OUTPUT_CODEC_TAG:
        raise RuntimeError(f'Wallpaper codec tag bukan {OUTPUT_CODEC_TAG}.')
    if abs(fps - OUTPUT_FPS) > 0.01:
        raise RuntimeError(f'Wallpaper FPS bukan {OUTPUT_FPS}: {fps:.3f}.')
    if stream.get('time_base') != OUTPUT_TIMEBASE:
        raise RuntimeError(f'Wallpaper timebase bukan {OUTPUT_TIMEBASE}: {stream.get("time_base")}.')
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise RuntimeError(f'Wallpaper dimensions tak valid: {width}x{height}.')
    if width > 1080 or height > 1920:
        raise RuntimeError(f'Wallpaper dimensions melebihi profile: {width}x{height}.')
    if duration < MIN_WALLPAPER_SOURCE_SECONDS - 0.05:
        raise RuntimeError(f'Wallpaper output terlalu pendek: {duration:.3f}s.')
    if duration > MAX_TELEGRAM_LIVE_SECONDS + 0.10:
        raise RuntimeError(f'Wallpaper output terlalu panjang: {duration:.3f}s.')
    if expected_duration is not None and abs(duration - expected_duration) > 0.15:
        raise RuntimeError(
            f'Wallpaper duration berubah luar jangka: expected={expected_duration:.3f}s actual={duration:.3f}s.'
        )

    profile = {
        'codec': stream.get('codec_name'),
        'tag': stream.get('codec_tag_string'),
        'fps': fps,
        'time_base': stream.get('time_base'),
        'width': width,
        'height': height,
        'duration': duration,
        'bytes': path.stat().st_size,
    }
    print(f'wallpaper_video_validated={profile}', flush=True)
    return profile


def encode_wallpaper_attempt(source, output, probe, duration, video_kbps, pad_seconds=0.0):
    if output.exists():
        output.unlink()
    video_filter = wallpaper_filter(probe)
    if pad_seconds > 0:
        video_filter += f',tpad=stop_mode=clone:stop_duration={pad_seconds:.6f}'
    run(
        [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-i', str(source),
            '-t', f'{duration:.6f}', '-map', '0:v:0', '-an',
            '-vf', video_filter,
            '-c:v', 'hevc_videotoolbox', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
            '-tag:v', OUTPUT_CODEC_TAG, '-b:v', f'{video_kbps}k',
            '-g', str(OUTPUT_FPS),
            '-map_metadata', '-1',
            '-video_track_timescale', str(OUTPUT_TIMESCALE), '-f', 'mov', str(output),
        ],
        timeout=900,
    )
    if not output.exists() or output.stat().st_size <= 0:
        raise RuntimeError('Live Wallpaper motion file tidak terhasil.')
    return validate_wallpaper_video(output, expected_duration=duration)


def verify_prepared_wallpaper_structure(path):
    data = path.read_bytes()
    required = [
        b'com.apple.quicktime.live-photo-info',
        b'com.apple.quicktime.live-photo-still-image-transform',
        b'com.apple.quicktime.still-image-time',
    ]
    missing = [key.decode('ascii') for key in required if key not in data]
    if missing:
        raise RuntimeError('Wallpaper metadata track hilang: ' + ', '.join(missing))
    cdsc_count = data.count(b'cdsc')
    if cdsc_count < 2:
        raise RuntimeError(f'Wallpaper cdsc/tref association tak lengkap: {cdsc_count}.')
    print(f'wallpaper_structure_validated cdsc={cdsc_count}', flush=True)


def encode_motion_and_cover(source, raw_movie, raw_cover, probe):
    # Preserve the source timeline from the beginning, but respect Telegram's
    # Live Photo transport limit. Source clips up to 9.8s keep their full length;
    # longer clips are capped to 9.8s instead of being rejected as VIDEO_INVALID.
    clip_start = 0.0
    source_duration = probe['duration']
    if source_duration < MIN_WALLPAPER_OUTPUT_SECONDS:
        duration = MIN_WALLPAPER_OUTPUT_SECONDS
        pad_seconds = duration - source_duration
        duration_mode = 'short_clip_tail_pad'
    else:
        duration = min(source_duration, MAX_TELEGRAM_LIVE_SECONDS)
        pad_seconds = 0.0
        duration_mode = 'original' if source_duration <= MAX_TELEGRAM_LIVE_SECONDS else 'telegram_cap'

    # Keep one deterministic output profile on every run. VideoToolbox bitrate can
    # vary a little between runners, so retry the exact same profile at a lower
    # bitrate only when the payload is too large for Telegram.
    total_kbps = int((TARGET_MOTION_BYTES * 8 / duration / 1000) * 0.90)
    video_kbps = max(450, min(6500, total_kbps))
    last_size = 0
    for attempt in range(1, ENCODE_MAX_ATTEMPTS + 1):
        print(
            f'wallpaper_encode attempt={attempt}/{ENCODE_MAX_ATTEMPTS} bitrate={video_kbps}k',
            flush=True,
        )
        try:
            profile = encode_wallpaper_attempt(
                source, raw_movie, probe, duration, video_kbps, pad_seconds
            )
        except Exception:
            if attempt >= ENCODE_MAX_ATTEMPTS:
                raise
            time.sleep(1.5 * attempt)
            continue

        last_size = raw_movie.stat().st_size
        if last_size <= SAFE_RAW_MOTION_BYTES:
            break

        if attempt >= ENCODE_MAX_ATTEMPTS:
            raise RuntimeError(
                f'Live Wallpaper motion masih terlalu besar selepas retry: '
                f'{last_size / MB:.2f}MB.'
            )

        shrink = max(0.55, min(0.88, SAFE_RAW_MOTION_BYTES / max(1, last_size) * 0.92))
        video_kbps = max(450, int(video_kbps * shrink))
        print(
            f'wallpaper payload {last_size / MB:.2f}MB; retry bitrate={video_kbps}k',
            flush=True,
        )

    if raw_movie.stat().st_size > MAX_RAW_MOTION_BYTES:
        raise RuntimeError(
            f'Live Wallpaper motion terlalu besar selepas duration diproses: '
            f'{raw_movie.stat().st_size / MB:.2f}MB.'
        )

    # Keep the proven link-downloader lane untouched. Only Gallery uploads
    # move photoTime deeper into the clip so iOS does not stop the wallpaper
    # motion around the template's original ~0.4s still-image-time.
    if IS_GALLERY_UPLOAD:
        real_motion_end = min(source_duration, duration)
        still_at = max(
            0.0,
            min(
                GALLERY_STILL_TIME_MAX_SECONDS,
                real_motion_end - GALLERY_STILL_TIME_END_MARGIN,
            ),
        )
    else:
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
        'pad_seconds': pad_seconds,
        'still_time': still_at,
        'source_kind': SOURCE_KIND,
        'video_kbps': video_kbps,
    }



def prepare_wallpaper_metadata(raw_movie, prepared_movie, still_time_seconds=None):
    # Inject the device-verified timed metadata template:
    # live-photo-info + still-image-time/transform tracks with cdsc references
    # back to the video track. Gallery uploads may retime only the still-image
    # event; link-downloader Live Wallpaper jobs keep the proven template timing.
    command = [
        'python3', 'scripts/prepare_wallpaper_video.py',
        str(raw_movie), str(prepared_movie),
    ]
    if IS_GALLERY_UPLOAD and still_time_seconds is not None:
        command.extend(['--still-time-seconds', f'{still_time_seconds:.6f}'])
    run(
        command,
        timeout=180,
    )
    if not prepared_movie.exists() or prepared_movie.stat().st_size <= 0:
        raise RuntimeError('Wallpaper metadata MOV tidak terhasil.')
    if prepared_movie.stat().st_size > MAX_RAW_MOTION_BYTES:
        raise RuntimeError(
            f'Wallpaper metadata MOV terlalu besar: '
            f'{prepared_movie.stat().st_size / MB:.2f}MB.'
        )
    validate_wallpaper_video(prepared_movie)
    verify_prepared_wallpaper_structure(prepared_movie)


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
    url = f'{BOT_API_BASE}/bot{BOT_TOKEN}/sendLivePhoto'
    last_error = None
    for attempt in range(1, SEND_MAX_ATTEMPTS + 1):
        try:
            with movie_path.open('rb') as movie, photo_path.open('rb') as photo:
                response = requests.post(
                    url,
                    data={
                        'chat_id': str(CHAT_ID),
                        'caption': (
                            'Live Wallpaper iPhone dah siap 🍎\n'
                            'Simpan ke Photos, kemudian cuba Use as Wallpaper.'
                        ),
                    },
                    files={
                        'live_photo': ('live-wallpaper.mov', movie, 'video/quicktime'),
                        'photo': ('live-wallpaper.jpg', photo, 'image/jpeg'),
                    },
                    timeout=300,
                )
            try:
                payload = response.json()
            except Exception:
                payload = {}

            if response.ok and payload.get('ok'):
                print(f'telegram_live_photo_sent attempt={attempt}', flush=True)
                return payload.get('result')

            description = str(payload.get('description') or f'HTTP {response.status_code}')
            last_error = RuntimeError(description)

            # Permanent payload errors will not improve on retry.
            upper = description.upper()
            if 'VIDEO_INVALID' in upper or 400 <= response.status_code < 500 and response.status_code != 429:
                raise last_error

            retry_after = int(((payload.get('parameters') or {}).get('retry_after') or 0))
            delay = retry_after if retry_after > 0 else min(8, 2 ** attempt)
            print(
                f'telegram sendLivePhoto transient failure attempt={attempt}: '
                f'{description}; retry_in={delay}s',
                flush=True,
            )
            if attempt < SEND_MAX_ATTEMPTS:
                time.sleep(delay)
        except requests.RequestException as exc:
            last_error = exc
            if attempt >= SEND_MAX_ATTEMPTS:
                break
            delay = min(8, 2 ** attempt)
            print(
                f'telegram sendLivePhoto network failure attempt={attempt}: {exc}; '
                f'retry_in={delay}s',
                flush=True,
            )
            time.sleep(delay)

    raise RuntimeError(f'Telegram sendLivePhoto gagal selepas retry: {last_error}')


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
        downloaded = None
        last_error = None

        # Gallery uploads must use the user's original Telegram message first.
        # The bot-generated preview can be recompressed by Telegram (for example
        # 720x1280 becoming 464x824), which was making the Live Photo look soft.
        if IS_GALLERY_UPLOAD and SOURCE_MESSAGE_ID:
            try:
                if path.exists():
                    path.unlink()
                message = app.get_messages(CHAT_ID, SOURCE_MESSAGE_ID)
                downloaded = app.download_media(message, file_name=str(path))
                if downloaded:
                    print('mtproto_gallery_original_ok', flush=True)
            except Exception as exc:
                last_error = exc
                print(f'gallery original download failed: {exc}', flush=True)

        if not downloaded:
            for attempt in range(1, 3):
                try:
                    if path.exists():
                        path.unlink()
                    downloaded = app.download_media(VIDEO_FILE_ID, file_name=str(path))
                    if downloaded:
                        print(f'mtproto_file_id_ok attempt={attempt}', flush=True)
                        break
                except Exception as exc:
                    last_error = exc
                    print(f'mtproto file_id download failed attempt={attempt}: {exc}', flush=True)
                if attempt < 2:
                    time.sleep(1.5)

        if not downloaded and SOURCE_MESSAGE_ID and not IS_GALLERY_UPLOAD:
            try:
                if path.exists():
                    path.unlink()
                message = app.get_messages(CHAT_ID, SOURCE_MESSAGE_ID)
                downloaded = app.download_media(message, file_name=str(path))
                if downloaded:
                    print('mtproto_message_fallback_ok', flush=True)
            except Exception as exc:
                last_error = exc
                print(f'message fallback failed: {exc}', flush=True)

        if not downloaded:
            raise RuntimeError(
                f'MTProto tak dapat download video Telegram ini. last_error={last_error}'
            )
    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError('Video download kosong.')
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise RuntimeError(f'Video melebihi limit {MAX_INPUT_MB}MB.')
    set_progress(30)


def main():
    require_config()
    print(
        f'apple live worker input={FILE_SIZE} chat={CHAT_ID} source_kind={SOURCE_KIND} '
        'duration_policy=original_up_to_9.8s',
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
        prepare_wallpaper_metadata(
            raw_movie,
            prepared_movie,
            still_time_seconds=clip.get('still_time'),
        )
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
        validate_wallpaper_video(paired_movie)
        verify_prepared_wallpaper_structure(paired_movie)

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
