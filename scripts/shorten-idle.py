#!/usr/bin/env python3
"""
shorten-idle.py — Shorten frozen/static sections in a demo video.

Downsamples to `sample_fps` before running freezedetect so that minor
browser animations (cursor blinks, CSS transitions) are invisible to the
detector.  Only sections longer than `min_freeze_sec` are shortened —
i.e. only the big idle blocks that exceed a viewer's ingest wait time.

Usage:
  python3 scripts/shorten-idle.py <input> <output> [digest_sec] [min_freeze_sec] [sample_fps] [noise_db]

  input          Path to source video (webm, mp4, …)
  output         Path for trimmed output (mp4 recommended)
  digest_sec     Seconds to keep of each idle section      (default: 3.0)
  min_freeze_sec Minimum idle duration to shorten          (default: 8.0)
  sample_fps     Frames per second used for detection      (default: 0.5)
                 0.5 = one frame every 2 s — ignores sub-2s animations
  noise_db       Freeze noise floor in dB                  (default: -30)
                 Higher (e.g. -20) = more tolerant of minor pixel changes

Example:
  python3 scripts/shorten-idle.py docs/demo-videos/openwebui-socratic.webm \\
    docs/demo-videos/openwebui-socratic.mp4
"""

import re
import subprocess
import sys
from pathlib import Path


def detect_freezes(
    path: Path,
    noise_db: float,
    min_dur: float,
    sample_fps: float,
) -> list[tuple[float, float, float]]:
    # Downsample to sample_fps so transient browser animations don't break detection.
    # freezedetect timestamps are in the downsampled stream; they map 1-to-1 to real
    # seconds because setpts=PTS is not applied — we only change the frame rate seen
    # by the filter, not the pts values.
    vf = f"fps={sample_fps},freezedetect=n={noise_db}dB:d={min_dur}"
    cmd = ["ffmpeg", "-v", "info", "-i", str(path), "-vf", vf, "-f", "null", "-"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    text = result.stderr

    starts, ends = [], []
    for line in text.splitlines():
        if "freeze_start:" in line:
            m = re.search(r"freeze_start: ([\d.]+)", line)
            if m:
                starts.append(float(m.group(1)))
        elif "freeze_end:" in line:
            m = re.search(r"freeze_end: ([\d.]+)", line)
            if m:
                ends.append(float(m.group(1)))

    if len(starts) != len(ends):
        print(f"Warning: mismatched freeze_start/end counts ({len(starts)}/{len(ends)}), truncating")
        n = min(len(starts), len(ends))
        starts, ends = starts[:n], ends[:n]

    return [(s, e, e - s) for s, e in zip(starts, ends)]


def get_duration(path: Path) -> float:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return float(result.stdout.strip())


def build_keep_segments(
    freezes: list[tuple[float, float, float]],
    total: float,
    digest: float,
) -> list[tuple[float, float]]:
    segments: list[tuple[float, float]] = []
    pos = 0.0
    for freeze_start, freeze_end, _ in sorted(freezes):
        if freeze_start > pos:
            segments.append((pos, freeze_start))
        keep_end = min(freeze_start + digest, freeze_end)
        segments.append((freeze_start, keep_end))
        pos = freeze_end
    if pos < total:
        segments.append((pos, total))
    return [(s, e) for s, e in segments if e - s > 0.01]


def has_audio(path: Path) -> bool:
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=codec_type",
        "-of", "default=noprint_wrappers=1",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return bool(result.stdout.strip())


def build_ffmpeg_cmd(
    input_path: Path,
    output_path: Path,
    segments: list[tuple[float, float]],
) -> list[str]:
    n = len(segments)
    parts: list[str] = []
    audio = has_audio(input_path)

    # concat filter requires interleaved [v0][a0][v1][a1]..., not grouped
    concat_inputs: list[str] = []
    for i, (start, end) in enumerate(segments):
        parts.append(f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[v{i}]")
        concat_inputs.append(f"[v{i}]")
        if audio:
            parts.append(f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS[a{i}]")
            concat_inputs.append(f"[a{i}]")

    if audio:
        parts.append(f"{''.join(concat_inputs)}concat=n={n}:v=1:a=1[outv][outa]")
        map_args = ["-map", "[outv]", "-map", "[outa]"]
        audio_args = ["-c:a", "aac", "-b:a", "128k"]
    else:
        parts.append(f"{''.join(concat_inputs)}concat=n={n}:v=1:a=0[outv]")
        map_args = ["-map", "[outv]"]
        audio_args = []

    ext = output_path.suffix.lower()
    if ext == ".webm":
        video_args = ["-c:v", "libvpx", "-b:v", "1M", "-deadline", "good", "-cpu-used", "4"]
        if audio:
            audio_args = ["-c:a", "libvorbis", "-b:a", "128k"]
    else:
        video_args = ["-c:v", "libx264", "-crf", "18", "-preset", "fast",
                      "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]

    return [
        "ffmpeg", "-y",
        "-i", str(input_path),
        "-filter_complex", "; ".join(parts),
        *map_args,
        *video_args,
        *audio_args,
        str(output_path),
    ]


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)

    input_path  = Path(args[0])
    output_path = Path(args[1])
    digest_sec  = float(args[2]) if len(args) > 2 else 3.0
    min_freeze  = float(args[3]) if len(args) > 3 else 8.0
    sample_fps  = float(args[4]) if len(args) > 4 else 0.5
    noise_db    = float(args[5]) if len(args) > 5 else -30.0

    if not input_path.exists():
        print(f"Error: {input_path} not found")
        sys.exit(1)

    print(f"Input:    {input_path}")
    total_dur = get_duration(input_path)
    print(f"Duration: {total_dur:.1f}s")
    print(f"Detecting idle blocks  (sample={sample_fps}fps, noise={noise_db}dB, min={min_freeze}s) …")

    freezes = detect_freezes(input_path, noise_db, min_freeze, sample_fps)

    if not freezes:
        print("No idle blocks detected — nothing to shorten.")
        sys.exit(0)

    saved = 0.0
    print(f"\nFound {len(freezes)} idle block(s):")
    for start, end, dur in freezes:
        save = max(0.0, dur - digest_sec)
        saved += save
        print(f"  {start:6.1f}s – {end:6.1f}s  ({dur:.1f}s)  shorten by {save:.1f}s")

    print(f"\nTime saved: {saved:.1f}s  ({saved / total_dur * 100:.0f}%)")
    print(f"Output duration: ~{total_dur - saved:.1f}s")

    segments = build_keep_segments(freezes, total_dur, digest_sec)
    print(f"Segments to keep: {len(segments)}")

    cmd = build_ffmpeg_cmd(input_path, output_path, segments)
    print(f"\nRunning ffmpeg …")
    result = subprocess.run(cmd)

    if result.returncode == 0:
        size_mb = output_path.stat().st_size / 1024 / 1024
        print(f"\nDone: {output_path}  ({size_mb:.1f} MB)")
    else:
        print(f"\nffmpeg exited with code {result.returncode}")
        sys.exit(result.returncode)


if __name__ == "__main__":
    main()
