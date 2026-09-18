# Adapted from pudding0503/live-photo-batch (MIT License)
# Copyright (c) 2026 Haoning Wu
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from pathlib import Path
import struct


CONTAINER_TYPES = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf", b"udta"}
LIVE_PHOTO_INFO_KEY = b"com.apple.quicktime.live-photo-info"
STILL_IMAGE_TIME_KEY = b"com.apple.quicktime.still-image-time"


@dataclass(frozen=True)
class EmbeddedMetadataTrack:
    track: bytes
    sample: bytes
    is_live_photo_info: bool


def decode_template(value: str) -> bytes:
    return base64.b64decode(value)


# Metadata-only template extracted from the device-verified wallpaper MOV.
EMBEDDED_METADATA_TRACKS = (
    EmbeddedMetadataTrack(
        track=decode_template(
            "AAAEA3RyYWsAAABcdGtoZAAAAA/hE7Nc4ROzXAAAAAIAAAAAAAACdgAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAA"
            "AAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAADBlZHRzAAAAKGVsc3QAAAAAAAAAAgAAAB7/////"
            "AAEAAAAAAlgAAAAAAAEAAAAAA29tZGlhAAAAIG1kaGQAAAAA4ROzXOETs1wAAOpgAADqYFXEAAAAAAA0aGRscgAA"
            "AABtaGxybWV0YWFwcGwAAAABAAAAABNDb3JlIE1lZGlhIE1ldGFkYXRhAAADE21pbmYAAAAgZ21oZAAAABhnbWlu"
            "AAAAAABAgACAAIAAAAAAAAAAADhoZGxyAAAAAGRobHJhbGlzYXBwbAAAAAAAAAAAF0NvcmUgTWVkaWEgRGF0YSBI"
            "YW5kbGVyAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADGFsaXMAAAABAAACj3N0YmwAAAIrc3RzZAAAAAAAAAAB"
            "AAACG21lYngAAAAAAAAAAQAAAgtrZXlzAAACAwAAAAEAAAAva2V5ZG1kdGFjb20uYXBwbGUucXVpY2t0aW1lLmxp"
            "dmUtcGhvdG8taW5mbwAAAENkdHlwAAAAAWNvbS5hcHBsZS5xdWlja3RpbWUuY29tLmFwcGxlLnF1aWNrdGltZS5s"
            "aXZlLXBob3RvLWluZm8AAAFxc2V0dQAAAVljZmd2YnBsaXN0MDDTAQIDBAUMXxAhTGl2ZVBob3RvTWV0YWRhdGFT"
            "ZXR1cERhdGFWZXJzaW9uXVN5c3RlbVZlcnNpb25fEBFGcmFtZXdvcmtWZXJzaW9ucxAB0wYHCAkKC18QE1Byb2R1"
            "Y3RCdWlsZFZlcnNpb25bUHJvZHVjdE5hbWVeUHJvZHVjdFZlcnNpb25YMjFBNTI3N2hZaVBob25lIE9TVDE3LjDU"
            "DQ4PEBESExRaQ29yZU1vdGlvbl1DTUNhcHR1cmVDb3JlXkgxMElTUFNlcnZpY2VzWUNvcmVNZWRpYVgyODY4LjAu"
            "Mlc0NDYuNS4zVDIwLjJeMzA0NS42OS4yLjExLjQACAAPADMAQQBVAFcAXgB0AIAAjwCYAKIApwCwALsAyQDYAOIA"
            "6wDzAPgAAAAAAAACAQAAAAAAAAAVAAAAAAAAAAAAAAAAAAABBwAAABBkaW1zAAAHgAAABaAAAAAYY3RwcwAAABBk"
            "dHlwAAAAAAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAPAAAA+gAAAAcc3RzYwAAAAAAAAABAAAAAQAAADwAAAABAAAA"
            "FHN0c3oAAAAAAAAAkAAAADwAAAAUc3RjbwAAAAAAAAABAFJlNg=="
        ),
        sample=decode_template(
            "AAAAkAAAAAEDAAAAvcNtPOO1622AAAAAe4CtQlotZEEKCMs+f+6mvXnp9j8AAIBABAD/AAAAAAAAAAAAAAAAAAAA"
            "AAAAAAAABwAAAFJehz7mblK/GypqxNN4Yr92HtI93j+OwxP1Lzmy8EQ5/zCdvxoX8e0bBwAAIGeW7RsHAAAAAAAA"
            "AAAAAAAAAAAAAAAA"
        ),
        is_live_photo_info=True,
    ),
    EmbeddedMetadataTrack(
        track=decode_template(
            "AAACoHRyYWsAAABcdGtoZAAAAA/hE7Nc4ROzXAAAAAMAAAAAAAAA+wAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAA"
            "AAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAADBlZHRzAAAAKGVsc3QAAAAAAAAAAgAAAPr/////"
            "AAEAAAAAAAEAAAAAAAEAAAAAAgxtZGlhAAAAIG1kaGQAAAAA4ROzXOETs1wAAAJYAAAAAVXEAAAAAAA0aGRscgAA"
            "AABtaGxybWV0YWFwcGwAAAABAAAAABNDb3JlIE1lZGlhIE1ldGFkYXRhAAABsG1pbmYAAAAgZ21oZAAAABhnbWlu"
            "AAAAAABAgACAAIAAAAAAAAAAADhoZGxyAAAAAGRobHJhbGlzYXBwbAAAAAAAAAAAF0NvcmUgTWVkaWEgRGF0YSBI"
            "YW5kbGVyAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADGFsaXMAAAABAAABLHN0YmwAAADIc3RzZAAAAAAAAAAB"
            "AAAAuG1lYngAAAAAAAAAAQAAAKhrZXlzAAAASAAAAAEAAAAwa2V5ZG1kdGFjb20uYXBwbGUucXVpY2t0aW1lLnN0"
            "aWxsLWltYWdlLXRpbWUAAAAQZHR5cAAAAAAAAABBAAAAWAAAAAIAAABAa2V5ZG1kdGFjb20uYXBwbGUucXVpY2t0"
            "aW1lLmxpdmUtcGhvdG8tc3RpbGwtaW1hZ2UtdHJhbnNmb3JtAAAAEGR0eXAAAAAAAAAAUwAAABhzdHRzAAAAAAAA"
            "AAEAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAABZAAAAAQAAABRzdGNv"
            "AAAAAAAAAAEAUob2"
        ),
        sample=decode_template(
            "AAAACQAAAAH/AAAAUAAAAAI/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/wAAAAAAAAAAAAAAAAAAAA"
            "AAAAAAAAAAAAAAAAAAAAP/AAAAAAAAA="
        ),
        is_live_photo_info=False,
    ),
)


@dataclass(frozen=True)
class Box:
    kind: bytes
    offset: int
    size: int
    header_size: int

    @property
    def data_offset(self) -> int:
        return self.offset + self.header_size

    @property
    def end(self) -> int:
        return self.offset + self.size


class MovPreparationError(RuntimeError):
    pass


def parse_box(data: bytes | bytearray, offset: int, end: int) -> Box:
    if offset + 8 > end:
        raise MovPreparationError("Truncated MOV box header")

    size, kind = struct.unpack_from(">I4s", data, offset)
    header_size = 8
    if size == 1:
        if offset + 16 > end:
            raise MovPreparationError("Truncated extended MOV box header")
        size = struct.unpack_from(">Q", data, offset + 8)[0]
        header_size = 16
    elif size == 0:
        size = end - offset

    if size < header_size or offset + size > end:
        raise MovPreparationError(f"Invalid {kind.decode(errors='replace')} box size")

    return Box(kind=kind, offset=offset, size=size, header_size=header_size)


def child_boxes(data: bytes | bytearray, parent: Box) -> list[Box]:
    if parent.kind not in CONTAINER_TYPES:
        return []

    children = []
    offset = parent.data_offset
    while offset < parent.end:
        child = parse_box(data, offset, parent.end)
        children.append(child)
        offset = child.end
    return children


def find_child(data: bytes | bytearray, parent: Box, kind: bytes) -> Box:
    for child in child_boxes(data, parent):
        if child.kind == kind:
            return child
    raise MovPreparationError(
        f"Missing {kind.decode(errors='replace')} box in {parent.kind.decode(errors='replace')}"
    )


def find_descendant(data: bytes | bytearray, parent: Box, path: tuple[bytes, ...]) -> Box:
    current = parent
    for kind in path:
        current = find_child(data, current, kind)
    return current


def top_level_boxes(data: bytes | bytearray) -> list[Box]:
    root = Box(kind=b"root", offset=0, size=len(data), header_size=0)
    offset = root.data_offset
    boxes = []
    while offset < root.end:
        box = parse_box(data, offset, root.end)
        boxes.append(box)
        offset = box.end
    return boxes


def find_top_level(data: bytes | bytearray, kind: bytes) -> Box:
    for box in top_level_boxes(data):
        if box.kind == kind:
            return box
    raise MovPreparationError(f"Missing top-level {kind.decode(errors='replace')} box")


def track_id(data: bytes | bytearray, track: Box) -> int:
    tkhd = find_child(data, track, b"tkhd")
    version = data[tkhd.data_offset]
    offset = tkhd.data_offset + (20 if version == 1 else 12)
    return struct.unpack_from(">I", data, offset)[0]


def set_track_id(data: bytearray, track: Box, identifier: int) -> None:
    tkhd = find_child(data, track, b"tkhd")
    version = data[tkhd.data_offset]
    offset = tkhd.data_offset + (20 if version == 1 else 12)
    struct.pack_into(">I", data, offset, identifier)


def sample_count(data: bytes | bytearray, track: Box) -> int:
    stbl = find_descendant(data, track, (b"mdia", b"minf", b"stbl"))
    stsz = find_child(data, stbl, b"stsz")
    return struct.unpack_from(">I", data, stsz.data_offset + 8)[0]


def media_timescale(data: bytes | bytearray, track: Box) -> int:
    mdhd = find_descendant(data, track, (b"mdia", b"mdhd"))
    version = data[mdhd.data_offset]
    offset = mdhd.data_offset + (20 if version == 1 else 12)
    return struct.unpack_from(">I", data, offset)[0]


def media_duration(data: bytes | bytearray, track: Box) -> int:
    mdhd = find_descendant(data, track, (b"mdia", b"mdhd"))
    version = data[mdhd.data_offset]
    offset = mdhd.data_offset + (24 if version == 1 else 16)
    return struct.unpack_from(">Q" if version == 1 else ">I", data, offset)[0]


def set_media_duration(data: bytearray, track: Box, duration: int) -> None:
    mdhd = find_descendant(data, track, (b"mdia", b"mdhd"))
    version = data[mdhd.data_offset]
    offset = mdhd.data_offset + (24 if version == 1 else 16)
    struct.pack_into(">Q" if version == 1 else ">I", data, offset, duration)


def set_track_duration(data: bytearray, track: Box, duration: int) -> None:
    tkhd = find_child(data, track, b"tkhd")
    version = data[tkhd.data_offset]
    offset = tkhd.data_offset + (28 if version == 1 else 20)
    struct.pack_into(">Q" if version == 1 else ">I", data, offset, duration)


def presentation_duration(data: bytes | bytearray, track: Box) -> int:
    edts = next((box for box in child_boxes(data, track) if box.kind == b"edts"), None)
    if edts is None:
        raise MovPreparationError("Input video track is missing an edit list")

    elst = find_child(data, edts, b"elst")
    version = data[elst.data_offset]
    count = struct.unpack_from(">I", data, elst.data_offset + 4)[0]
    offset = elst.data_offset + 8
    duration = 0
    for _ in range(count):
        if version == 1:
            segment_duration, media_time = struct.unpack_from(">Qq", data, offset)
            offset += 20
        else:
            segment_duration, media_time = struct.unpack_from(">Ii", data, offset)
            offset += 12
        if media_time >= 0:
            duration += segment_duration
    return duration


def presentation_start_media_time(data: bytes | bytearray, track: Box) -> int:
    """Return the media time at which the track's presentation begins."""
    edts = next((box for box in child_boxes(data, track) if box.kind == b"edts"), None)
    if edts is None:
        raise MovPreparationError("Input video track is missing an edit list")

    elst = find_child(data, edts, b"elst")
    version = data[elst.data_offset]
    count = struct.unpack_from(">I", data, elst.data_offset + 4)[0]
    offset = elst.data_offset + 8
    for _ in range(count):
        if version == 1:
            _, media_time = struct.unpack_from(">Qq", data, offset)
            offset += 20
        else:
            _, media_time = struct.unpack_from(">Ii", data, offset)
            offset += 12
        if media_time >= 0:
            return media_time

    raise MovPreparationError("Input video track edit list has no media segment")


def movie_timescale(data: bytes | bytearray, moov: Box) -> int:
    mvhd = find_child(data, moov, b"mvhd")
    version = data[mvhd.data_offset]
    offset = mvhd.data_offset + (20 if version == 1 else 12)
    return struct.unpack_from(">I", data, offset)[0]


def set_metadata_edit_list(data: bytearray, track: Box, duration: int, leading_duration: int) -> None:
    edts = find_child(data, track, b"edts")
    elst = find_child(data, edts, b"elst")
    version = data[elst.data_offset]
    count = struct.unpack_from(">I", data, elst.data_offset + 4)[0]
    if count != 2:
        raise MovPreparationError("Template metadata track must contain a two-entry edit list")

    first_offset = elst.data_offset + 8
    second_offset = first_offset + (20 if version == 1 else 12)
    if version == 1:
        struct.pack_into(">Q", data, first_offset, leading_duration)
        struct.pack_into(">Q", data, second_offset, duration)
    else:
        struct.pack_into(">I", data, first_offset, leading_duration)
        struct.pack_into(">I", data, second_offset, duration)


def set_live_photo_info_timing(
    data: bytearray,
    track: Box,
    count: int,
    sample_duration: int,
    presentation_duration_value: int,
    leading_duration: int,
) -> None:
    stbl = find_descendant(data, track, (b"mdia", b"minf", b"stbl"))
    stts = find_child(data, stbl, b"stts")
    stsz = find_child(data, stbl, b"stsz")
    stsc = find_child(data, stbl, b"stsc")

    if stts.size != 24 or stsc.size != 28:
        raise MovPreparationError("Template live-photo-info sample tables must contain one entry")

    struct.pack_into(">I", data, stts.data_offset + 4, 1)
    struct.pack_into(">II", data, stts.data_offset + 8, count, sample_duration)
    struct.pack_into(">I", data, stsz.data_offset + 8, count)
    struct.pack_into(">I", data, stsc.data_offset + 4, 1)
    struct.pack_into(">III", data, stsc.data_offset + 8, 1, count, 1)
    set_media_duration(data, track, count * sample_duration)
    set_track_duration(data, track, leading_duration + presentation_duration_value)
    set_metadata_edit_list(data, track, presentation_duration_value, leading_duration)


def set_still_image_time_timing(
    data: bytearray,
    track: Box,
    still_time_seconds: float,
    movie_timescale_value: int,
) -> int:
    """Move the still-image-time event without changing the metadata payload."""
    if movie_timescale_value <= 0:
        raise MovPreparationError("Movie timescale must be positive")
    leading_duration = max(0, round(still_time_seconds * movie_timescale_value))
    event_duration = 1
    set_track_duration(data, track, leading_duration + event_duration)
    set_metadata_edit_list(data, track, event_duration, leading_duration)
    return leading_duration


def set_single_chunk_offset(data: bytearray, track: Box, offset: int) -> None:
    stbl = find_descendant(data, track, (b"mdia", b"minf", b"stbl"))
    stco = find_child(data, stbl, b"stco")
    count = struct.unpack_from(">I", data, stco.data_offset + 4)[0]
    if count != 1:
        raise MovPreparationError("Template metadata track must contain exactly one chunk")
    struct.pack_into(">I", data, stco.data_offset + 8, offset)


def shift_chunk_offsets(data: bytearray, track: Box, delta: int) -> None:
    stbl = find_descendant(data, track, (b"mdia", b"minf", b"stbl"))
    stco = find_child(data, stbl, b"stco")
    count = struct.unpack_from(">I", data, stco.data_offset + 4)[0]
    for index in range(count):
        entry_offset = stco.data_offset + 8 + index * 4
        original_offset = struct.unpack_from(">I", data, entry_offset)[0]
        updated_offset = original_offset + delta
        if not 0 <= updated_offset <= 0xFFFFFFFF:
            raise MovPreparationError("Chunk offset does not fit in stco")
        struct.pack_into(">I", data, entry_offset, updated_offset)


def set_metadata_video_reference(data: bytearray, track: Box, video_track_id: int) -> None:
    reference = struct.pack(">I4sI", 12, b"cdsc", video_track_id)
    tref = struct.pack(">I4s", 20, b"tref") + reference
    mdia = find_child(data, track, b"mdia")
    data[mdia.offset:mdia.offset] = tref
    struct.pack_into(">I", data, track.offset, len(data))


def clone_metadata_track(
    template: EmbeddedMetadataTrack,
    chunk_offset: int,
    identifier: int,
    video_track_id: int,
    video_samples: int,
    video_media_duration: int,
    video_timescale: int,
    video_presentation_duration: int,
    metadata_leading_duration: int,
    movie_timescale_value: int,
    still_time_seconds: float | None = None,
) -> tuple[bytearray, bytes]:
    clone = bytearray(template.track)
    clone_track = Box(kind=b"trak", offset=0, size=len(clone), header_size=8)
    set_track_id(clone, clone_track, identifier)
    sample_data = template.sample
    if template.is_live_photo_info:
        sample_data *= video_samples

    clone_track = Box(kind=b"trak", offset=0, size=len(clone), header_size=8)
    set_metadata_video_reference(clone, clone_track, video_track_id)
    clone_track = Box(kind=b"trak", offset=0, size=len(clone), header_size=8)
    set_single_chunk_offset(clone, clone_track, chunk_offset)
    if template.is_live_photo_info:
        metadata_timescale = media_timescale(clone, clone_track)
        total_duration = round(video_media_duration * metadata_timescale / video_timescale)
        if total_duration % video_samples != 0:
            raise MovPreparationError("Input video duration cannot be divided into metadata frame samples")
        set_live_photo_info_timing(
            clone,
            clone_track,
            video_samples,
            total_duration // video_samples,
            video_presentation_duration,
            metadata_leading_duration,
            input_movie_timescale,
            still_time_seconds,
        )
    elif still_time_seconds is not None:
        still_ticks = set_still_image_time_timing(
            clone,
            clone_track,
            still_time_seconds,
            movie_timescale_value,
        )
        print(
            f"WALLPAPER_STILL_TIME seconds={still_time_seconds:.6f} "
            f"ticks={still_ticks} movie_timescale={movie_timescale_value}"
        )
    return clone, sample_data


def update_next_track_id(moov: bytearray, identifier: int) -> None:
    moov_box = Box(kind=b"moov", offset=0, size=len(moov), header_size=8)
    mvhd = find_child(moov, moov_box, b"mvhd")
    struct.pack_into(">I", moov, mvhd.end - 4, identifier)


def strip_hvc1_prefix_sei(path: Path) -> bool:
    """Remove x265 Prefix SEI configuration data from an hvc1 MOV sample entry."""
    data = bytearray(path.read_bytes())
    moov = find_top_level(data, b"moov")
    mdat = find_top_level(data, b"mdat")
    if moov.offset < mdat.offset:
        raise MovPreparationError("HEVC cleanup requires an mdat-before-moov MOV")

    video_track = next(
        (
            track
            for track in child_boxes(data, moov)
            if track.kind == b"trak" and b"vide" in data[track.offset:track.end]
        ),
        None,
    )
    if video_track is None:
        raise MovPreparationError("MOV does not contain a video track")

    stbl = find_descendant(data, video_track, (b"mdia", b"minf", b"stbl"))
    stsd = find_child(data, stbl, b"stsd")
    entry_offset = stsd.data_offset + 8
    entry_size, entry_kind = struct.unpack_from(">I4s", data, entry_offset)
    if entry_kind != b"hvc1":
        raise MovPreparationError("HEVC cleanup requires an hvc1 video track")

    entry_end = entry_offset + entry_size
    type_offset = data.find(b"hvcC", entry_offset, entry_end)
    if type_offset < 4:
        raise MovPreparationError("hvc1 sample entry is missing hvcC")
    box_offset = type_offset - 4
    box_size = struct.unpack_from(">I", data, box_offset)[0]
    if box_size < 31 or box_offset + box_size > entry_end:
        raise MovPreparationError("Invalid hvcC box size")

    config = data[type_offset + 4:box_offset + box_size]
    array_count = config[22]
    cursor = 23
    retained_arrays = []
    removed = False
    for _ in range(array_count):
        array_start = cursor
        if cursor + 3 > len(config):
            raise MovPreparationError("Truncated hvcC array header")
        array_type = config[cursor] & 0x3F
        nal_count = struct.unpack_from(">H", config, cursor + 1)[0]
        cursor += 3
        for _ in range(nal_count):
            if cursor + 2 > len(config):
                raise MovPreparationError("Truncated hvcC NAL size")
            nal_size = struct.unpack_from(">H", config, cursor)[0]
            cursor += 2 + nal_size
            if cursor > len(config):
                raise MovPreparationError("Truncated hvcC NAL payload")
        if array_type == 39:
            removed = True
        else:
            retained_arrays.append(config[array_start:cursor])

    if cursor != len(config):
        raise MovPreparationError("Unexpected trailing hvcC data")
    if not removed:
        return False

    replacement_config = config[:22] + bytes([len(retained_arrays)]) + b"".join(retained_arrays)
    replacement_box = struct.pack(">I4s", len(replacement_config) + 8, b"hvcC") + replacement_config
    delta = len(replacement_box) - box_size
    struct.pack_into(">I", data, entry_offset, entry_size + delta)
    for box in (moov, video_track, find_child(data, video_track, b"mdia"), find_descendant(data, video_track, (b"mdia", b"minf")), stbl, stsd):
        if box.header_size != 8:
            raise MovPreparationError("Extended-size HEVC boxes are not supported")
        struct.pack_into(">I", data, box.offset, box.size + delta)
    data[box_offset:box_offset + box_size] = replacement_box
    path.write_bytes(data)
    return True


def add_hvc1_track_aperture(path: Path) -> bool:
    """Add the QuickTime clean, production, and encoded-pixel apertures."""
    data = bytearray(path.read_bytes())
    moov = find_top_level(data, b"moov")
    mdat = find_top_level(data, b"mdat")
    if moov.offset < mdat.offset:
        raise MovPreparationError("HEVC aperture cleanup requires an mdat-before-moov MOV")

    video_track = next(
        (
            track
            for track in child_boxes(data, moov)
            if track.kind == b"trak" and b"vide" in data[track.offset:track.end]
        ),
        None,
    )
    if video_track is None:
        raise MovPreparationError("MOV does not contain a video track")
    if any(child.kind == b"tapt" for child in child_boxes(data, video_track)):
        return False

    tkhd = find_child(data, video_track, b"tkhd")
    width, height = struct.unpack_from(">II", data, tkhd.end - 8)
    aperture_children = b"".join(
        struct.pack(">I4sIII", 20, kind, 0, width, height)
        for kind in (b"clef", b"prof", b"enof")
    )
    aperture = struct.pack(">I4s", len(aperture_children) + 8, b"tapt") + aperture_children
    data[tkhd.end:tkhd.end] = aperture
    struct.pack_into(">I", data, video_track.offset, video_track.size + len(aperture))
    struct.pack_into(">I", data, moov.offset, moov.size + len(aperture))
    path.write_bytes(data)
    return True


def remove_ffmpeg_encoder_tag(path: Path) -> bool:
    """Remove the non-native Lavf software tag added by FFmpeg's MOV muxer."""
    data = bytearray(path.read_bytes())
    moov = find_top_level(data, b"moov")
    mdat = find_top_level(data, b"mdat")
    if moov.offset < mdat.offset:
        raise MovPreparationError("HEVC metadata cleanup requires an mdat-before-moov MOV")

    encoder_tag = next(
        (
            box
            for box in child_boxes(data, moov)
            if box.kind == b"udta" and b"Lavf" in data[box.offset:box.end]
        ),
        None,
    )
    if encoder_tag is None:
        return False

    del data[encoder_tag.offset:encoder_tag.end]
    struct.pack_into(">I", data, moov.offset, moov.size - encoder_tag.size)
    path.write_bytes(data)
    return True


def prepare_wallpaper_video(
    input_path: Path,
    output_path: Path,
    still_time_seconds: float | None = None,
) -> None:
    """Add the fixed Live Photo metadata template to a prepared HEVC MOV."""
    input_data = input_path.read_bytes()
    input_mdat = find_top_level(input_data, b"mdat")
    input_moov = find_top_level(input_data, b"moov")

    input_moov_data = bytearray(input_data[input_moov.offset:input_moov.end])
    input_moov_box = Box(kind=b"moov", offset=0, size=len(input_moov_data), header_size=8)
    for track in reversed(child_boxes(input_moov_data, input_moov_box)):
        if track.kind != b"trak":
            continue
        payload = input_moov_data[track.offset:track.end]
        if LIVE_PHOTO_INFO_KEY in payload or STILL_IMAGE_TIME_KEY in payload:
            del input_moov_data[track.offset:track.end]
    struct.pack_into(">I", input_moov_data, 0, len(input_moov_data))
    input_moov_box = Box(kind=b"moov", offset=0, size=len(input_moov_data), header_size=8)
    input_tracks = [
        track for track in child_boxes(input_moov_data, input_moov_box) if track.kind == b"trak"
    ]
    input_video_track = next(
        (track for track in input_tracks if b"vide" in input_moov_data[track.offset:track.end]),
        None,
    )
    if input_video_track is None:
        raise MovPreparationError("Input MOV does not contain a video track")
    next_track_id = max(track_id(input_moov_data, track) for track in input_tracks) + 1
    video_track_id = track_id(input_moov_data, input_video_track)
    video_samples = sample_count(input_moov_data, input_video_track)
    video_media_duration = media_duration(input_moov_data, input_video_track)
    video_timescale = media_timescale(input_moov_data, input_video_track)
    video_presentation_duration = presentation_duration(input_moov_data, input_video_track)
    input_movie_timescale = movie_timescale(input_moov_data, input_moov_box)
    video_presentation_start = presentation_start_media_time(input_moov_data, input_video_track)
    metadata_leading_duration = round(
        video_presentation_start * input_movie_timescale / video_timescale
    )

    target_payload = input_data[input_mdat.data_offset:input_mdat.end]
    prefix = b"".join(
        input_data[box.offset:box.end]
        for box in top_level_boxes(input_data)
        if box.kind not in {b"mdat", b"moov"}
    )
    target_payload_offset = len(prefix) + 8
    offset_delta = target_payload_offset - input_mdat.data_offset
    for track in input_tracks:
        shift_chunk_offsets(input_moov_data, track, offset_delta)

    first_metadata_offset = target_payload_offset + len(target_payload)
    cloned_tracks = []
    metadata_payloads = []
    metadata_offset = first_metadata_offset
    for template_track in EMBEDDED_METADATA_TRACKS:
        clone, payload = clone_metadata_track(
            template_track,
            metadata_offset,
            next_track_id,
            video_track_id,
            video_samples,
            video_media_duration,
            video_timescale,
            video_presentation_duration,
            metadata_leading_duration,
            input_movie_timescale,
            still_time_seconds,
        )
        cloned_tracks.append(clone)
        metadata_payloads.append(payload)
        metadata_offset += len(payload)
        next_track_id += 1

    last_track_end = max(track.end for track in input_tracks)
    input_moov_data[last_track_end:last_track_end] = b"".join(cloned_tracks)
    struct.pack_into(">I", input_moov_data, 0, len(input_moov_data))
    update_next_track_id(input_moov_data, next_track_id)

    new_mdat_payload = target_payload + b"".join(metadata_payloads)
    new_mdat = struct.pack(">I4s", len(new_mdat_payload) + 8, b"mdat") + new_mdat_payload
    output_data = prefix + new_mdat + input_moov_data
    output_path.write_bytes(output_data)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inject the built-in Live Photo metadata template into a MOV without transcoding video."
    )
    parser.add_argument("input", type=Path, help="Source MOV to preserve without transcoding")
    parser.add_argument("output", type=Path, help="Prepared MOV output path")
    parser.add_argument(
        "--still-time-seconds",
        type=float,
        default=None,
        help="Optional still-image-time position used only by the Gallery Live Wallpaper lane",
    )
    arguments = parser.parse_args()

    try:
        if arguments.still_time_seconds is not None and arguments.still_time_seconds < 0:
            raise MovPreparationError("still-time-seconds must be zero or positive")
        prepare_wallpaper_video(
            arguments.input,
            arguments.output,
            still_time_seconds=arguments.still_time_seconds,
        )
    except (OSError, MovPreparationError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
