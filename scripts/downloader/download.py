#!/usr/bin/env python3
"""
MIDWAVE yt-dlp media extraction and download worker.
Invoked via child_process.spawn() with an explicit argument array.
Emits throttled PROGRESS:<json> lines and a single final RESULT:<json> line on stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any


class SizeLimitExceededError(Exception):
    """Raised immediately when downloaded bytes exceed the configured max_bytes limit."""


class DurationLimitExceededError(Exception):
    """Raised when media duration exceeds the configured max_duration limit."""


class MissingDependencyError(Exception):
    """Raised when a required runtime dependency (yt-dlp / ffmpeg) is unavailable."""


def emit_json(prefix: str, payload: dict[str, Any]) -> None:
    """Writes a single line-delimited JSON event to stdout and flushes immediately."""
    sys.stdout.write(f"{prefix}{json.dumps(payload, ensure_ascii=False)}\n")
    sys.stdout.flush()


def sanitize_message(text: Any, max_len: int = 240) -> str:
    """Redacts URLs, tokens, and filesystem paths from diagnostic messages."""
    raw = str(text or "")
    raw = re.sub(r"https?://\S+", "[REDACTED_URL]", raw)
    raw = re.sub(r"(?:[A-Za-z]:\\|/(?:home|root|tmp|var|usr|opt|etc)/)\S+", "[REDACTED_PATH]", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw[:max_len]


def is_single_item_playlist_target(url: str) -> bool:
    """
    Returns True when a URL should be restricted to a single entry rather than expanding
    a multi-item feed/playlist (e.g. YouTube playlists/mixes).
    """
    lower = url.lower()
    single_host_hints = (
        "youtube.com",
        "youtu.be",
        "soundcloud.com",
        "vimeo.com",
        "dailymotion.com",
        "dai.ly",
        "twitch.tv",
        "bilibili.com",
        "b23.tv",
    )
    return any(host in lower for host in single_host_hints)


def classify_ytdlp_error(raw_message: str) -> tuple[str, str]:
    """Maps yt-dlp / FFmpeg error text into standardized MIDWAVE error codes and safe user messages."""
    msg = (raw_message or "").lower()

    if isinstance(raw_message, str) and (
        "no module named 'yt_dlp'" in msg or "yt_dlp" in msg and "not found" in msg
    ):
        return (
            "MISSING_DEPENDENCY",
            "Engine downloader (`yt-dlp`) belum terpasang di server.",
        )

    if "ffmpeg" in msg and ("not found" in msg or "is not installed" in msg or "unable to obtain" in msg):
        return (
            "MISSING_DEPENDENCY",
            "Dependensi `FFmpeg` tidak ditemukan untuk memproses atau menggabungkan media.",
        )

    if "requested format is not available" in msg or "no video formats found" in msg:
        return (
            "UNSUPPORTED_MEDIA",
            "Format media yang kompatibel (dalam batas ukuran Discord) tidak tersedia untuk tautan ini.",
        )

    if "unsupported url" in msg or "no suitable extractor" in msg:
        return (
            "UNSUPPORTED_PLATFORM",
            "Website atau format tautan ini belum didukung oleh yt-dlp.",
        )

    if any(
        hint in msg
        for hint in (
            "sign in to confirm your age",
            "age-restricted",
            "age restricted",
            "inappropriate for some users",
        )
    ):
        return (
            "PRIVATE_OR_RESTRICTED",
            "Konten dibatasi usia (age-restricted) dan memerlukan akun terverifikasi.",
        )

    if any(
        hint in msg
        for hint in (
            "not available in your country",
            "geo-restricted",
            "geo restricted",
            "blocked it in your country",
            "uploader has not made this video available in your country",
        )
    ):
        return (
            "PRIVATE_OR_RESTRICTED",
            "Konten dibatasi secara geografis (geo-restricted) pada wilayah server.",
        )

    if any(
        hint in msg
        for hint in (
            "private video",
            "this video is private",
            "account is private",
            "login required",
            "cookies",
            "sign in to confirm",
            "authentication",
            "members-only",
            "subscribers only",
            "http error 401",
            "http error 403",
            "forbidden",
        )
    ):
        return (
            "PRIVATE_OR_RESTRICTED",
            "Konten bersifat privat, memerlukan login/cookies, atau dibatasi oleh platform sumber.",
        )

    if any(
        hint in msg
        for hint in (
            "http error 404",
            "video unavailable",
            "this video has been removed",
            "has been deleted",
            "does not exist",
            "not found",
            "no video could be found",
            "status code 404",
        )
    ):
        return (
            "NOT_FOUND",
            "Media tidak ditemukan, bersifat privat, atau postingan sudah dihapus.",
        )

    if "http error 429" in msg or "too many requests" in msg or "rate limit" in msg:
        return (
            "RATE_LIMITED",
            "Platform sumber membatasi permintaan sementara (rate limit). Silakan coba lagi nanti.",
        )

    if any(
        hint in msg
        for hint in (
            "timed out",
            "timeout",
            "read timed out",
            "connection reset",
            "temporary failure in name resolution",
            "name or service not known",
            "getaddrinfo failed",
            "network is unreachable",
            "unable to download webpage",
        )
    ):
        return (
            "NETWORK_ERROR",
            "Terjadi gangguan jaringan atau timeout saat menghubungi server media. Silakan coba lagi.",
        )

    if "is live" in msg or "live event" in msg or "premieres in" in msg:
        return (
            "UNSUPPORTED_MEDIA",
            "Siaran langsung (live stream) atau premiere yang belum tayang tidak dapat diunduh.",
        )

    return (
        "EXTRACTION_FAILED",
        "Gagal mengekstrak atau mengunduh media dari tautan tersebut.",
    )


class QuietYtLogger:
    """Captures yt-dlp warnings/errors without polluting stdout JSON."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def debug(self, msg: str) -> None:
        return None

    def info(self, msg: str) -> None:
        return None

    def warning(self, msg: str) -> None:
        if msg:
            self.warnings.append(str(msg))

    def error(self, msg: str) -> None:
        if msg:
            self.errors.append(str(msg))


def assert_inside_dir(root_dir: str, target_path: str) -> str:
    real_root = os.path.realpath(root_dir)
    real_target = os.path.realpath(target_path)
    if real_target != real_root and not real_target.startswith(real_root + os.sep):
        raise ValueError("Resolved output path escapes temporary job directory.")
    return real_target


def collect_output_files(info: dict[str, Any], output_dir: str) -> list[dict[str, Any]]:
    """Extracts and validates unique downloaded media file paths from yt-dlp info dict."""
    candidates: list[str] = []

    def add_path(p: Any) -> None:
        if isinstance(p, str) and p.strip():
            candidates.append(p.strip())

    def visit_entry(entry: dict[str, Any]) -> None:
        for req in entry.get("requested_downloads") or []:
            if isinstance(req, dict):
                add_path(req.get("filepath") or req.get("_filename"))
        add_path(entry.get("filepath"))
        add_path(entry.get("_filename"))

    if "entries" in info and isinstance(info["entries"], list):
        for entry in info["entries"]:
            if isinstance(entry, dict):
                visit_entry(entry)
    else:
        visit_entry(info)

    # Fallback: scan output_dir for non-.part/.ytdl files if requested_downloads did not list postprocessed target
    if not candidates or not any(os.path.isfile(p) for p in candidates):
        for fname in sorted(os.listdir(output_dir)):
            if fname.endswith((".part", ".ytdl", ".temp", ".json")):
                continue
            full = os.path.join(output_dir, fname)
            if os.path.isfile(full):
                candidates.append(full)

    seen_real: set[str] = set()
    files: list[dict[str, Any]] = []
    for raw_path in candidates:
        try:
            real_path = assert_inside_dir(output_dir, raw_path)
        except ValueError:
            continue
        if real_path in seen_real or not os.path.isfile(real_path):
            continue
        size = os.path.getsize(real_path)
        if size <= 0:
            continue
        seen_real.add(real_path)
        ext = os.path.splitext(real_path)[1].lstrip(".").lower()
        files.append(
            {
                "path": real_path,
                "filename": os.path.basename(real_path),
                "size_bytes": size,
                "ext": ext,
            }
        )

    return files


def estimate_entry_size(entry: dict[str, Any]) -> int | None:
    """Returns known or approximate byte size if available on the selected format(s)."""
    requested = entry.get("requested_formats")
    if isinstance(requested, list) and requested:
        total = 0
        for fmt in requested:
            if not isinstance(fmt, dict):
                continue
            size = fmt.get("filesize") or fmt.get("filesize_approx")
            if isinstance(size, (int, float)) and size > 0:
                total += int(size)
        if total > 0:
            return total

    size = entry.get("filesize") or entry.get("filesize_approx")
    if isinstance(size, (int, float)) and size > 0:
        return int(size)
    return None


def build_format_selector(max_bytes: int, has_ffmpeg: bool) -> str:
    """
    Constructs a yt-dlp video format selector that:
    - Prefers H.264/MP4 + AAC/M4A for native Discord video playback
    - Avoids selecting streams known to exceed max_bytes when smaller formats exist
    - Falls back cleanly to single-stream MP4 when FFmpeg is unavailable
    """
    if has_ffmpeg:
        return (
            f"bv*[filesize<=?{max_bytes}][vcodec^=avc]+ba[acodec^=mp4a]/"
            f"bv*[filesize<=?{max_bytes}][ext=mp4]+ba[ext=m4a]/"
            f"bv*[filesize<=?{max_bytes}]+ba/"
            f"b[filesize<=?{max_bytes}][ext=mp4]/"
            f"b[filesize<=?{max_bytes}]/"
            f"bv*[vcodec^=avc]+ba[acodec^=mp4a]/bv*+ba/b"
        )

    return (
        f"b[filesize<=?{max_bytes}][ext=mp4]/"
        f"b[filesize<=?{max_bytes}]/"
        f"b[ext=mp4]/b"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="MIDWAVE yt-dlp video worker")
    parser.add_argument("--url", required=True, help="Validated HTTP/HTTPS target URL")
    parser.add_argument("--output-dir", required=True, help="Isolated temporary directory")
    parser.add_argument("--max-bytes", required=True, type=int, help="Max total/file byte limit")
    parser.add_argument("--max-duration", default=900, type=int, help="Max video duration in seconds (0=unlimited)")
    parser.add_argument("--max-items", default=10, type=int, help="Max carousel items")
    parser.add_argument("--timeout", default=60, type=int, help="Socket timeout in seconds")
    parser.add_argument("--ffmpeg-location", default="", help="Optional path to ffmpeg binary or dir")
    parser.add_argument("--deno-path", default="", help="Optional path to deno binary for YouTube EJS")
    parser.add_argument("--node-path", default="", help="Optional path to node binary for YouTube EJS")
    parser.add_argument("--ytdlp-path", default="", help="Optional path to standalone yt-dlp zipapp")
    args = parser.parse_args()

    url = args.url.strip()
    if not (url.startswith("https://") or url.startswith("http://")):
        emit_json(
            "RESULT:",
            {"ok": False, "code": "INVALID_URL", "message": "URL harus menggunakan protokol HTTP atau HTTPS."},
        )
        return 1

    output_dir = os.path.realpath(args.output_dir)
    if not os.path.isdir(output_dir):
        emit_json(
            "RESULT:",
            {"ok": False, "code": "EXTRACTION_FAILED", "message": "Direktori sementara unduhan tidak ditemukan."},
        )
        return 1

    yt_dlp = None
    try:
        import yt_dlp as _yt_dlp  # type: ignore

        yt_dlp = _yt_dlp
    except ImportError:
        ytdlp_zip = (args.ytdlp_path or "").strip()
        if ytdlp_zip and os.path.isfile(ytdlp_zip):
            sys.path.insert(0, ytdlp_zip)
            try:
                import yt_dlp as _yt_dlp  # type: ignore

                yt_dlp = _yt_dlp
            except ImportError:
                yt_dlp = None

    if yt_dlp is None:
        emit_json(
            "RESULT:",
            {
                "ok": False,
                "code": "MISSING_DEPENDENCY",
                "message": "Engine downloader (`yt-dlp`) belum terpasang di lingkungan Python server.",
            },
        )
        return 1

    ffmpeg_loc = args.ffmpeg_location.strip() or None
    has_ffmpeg = bool(ffmpeg_loc)
    if not has_ffmpeg:
        import shutil

        has_ffmpeg = bool(shutil.which("ffmpeg"))

    yt_logger = QuietYtLogger()
    last_progress_emit = 0.0

    def progress_hook(status: dict[str, Any]) -> None:
        nonlocal last_progress_emit
        state = status.get("status")
        downloaded = int(status.get("downloaded_bytes") or 0)
        total = int(status.get("total_bytes") or status.get("total_bytes_estimate") or 0)

        if downloaded > args.max_bytes:
            raise SizeLimitExceededError(
                f"Downloaded bytes ({downloaded}) exceeded limit ({args.max_bytes})."
            )
        if total > 0 and total > args.max_bytes and downloaded > int(args.max_bytes * 0.2):
            raise SizeLimitExceededError(
                f"Estimated total size ({total}) exceeded limit ({args.max_bytes})."
            )

        now = time.monotonic()
        if state == "downloading" and now - last_progress_emit >= 1.5:
            last_progress_emit = now
            pct = round((downloaded / total) * 100, 1) if total > 0 else None
            emit_json(
                "PROGRESS:",
                {
                    "type": "progress",
                    "status": "downloading",
                    "percent": pct,
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                },
            )
        elif state == "finished":
            emit_json(
                "PROGRESS:",
                {
                    "type": "progress",
                    "status": "processing",
                    "percent": 100.0,
                    "downloaded_bytes": downloaded,
                    "total_bytes": total or downloaded,
                },
            )

    single_target = is_single_item_playlist_target(url)
    max_items = 1 if single_target else max(1, min(args.max_items, 10))

    def match_filter(info_dict: dict[str, Any], *, incomplete: bool = False) -> str | None:
        if incomplete:
            return None
        if info_dict.get("is_live"):
            return "Siaran langsung (live stream) tidak dapat diunduh."
        duration = info_dict.get("duration")
        if args.max_duration > 0 and isinstance(duration, (int, float)) and duration > args.max_duration:
            raise DurationLimitExceededError(
                f"Durasi media ({int(duration)} detik) melebihi batas maksimal {args.max_duration} detik."
            )
        return None

    ydl_opts: dict[str, Any] = {
        "outtmpl": os.path.join(output_dir, "media_%(autonumber)s.%(ext)s"),
        "paths": {"home": output_dir, "temp": output_dir},
        "format": build_format_selector(args.max_bytes, has_ffmpeg),
        "noplaylist": True,
        "playlist_items": f"1-{max_items}",
        "socket_timeout": max(5, min(args.timeout, 30)),
        "retries": 1,
        "fragment_retries": 1,
        "concurrent_fragment_downloads": 1,
        "no_warnings": True,
        "quiet": True,
        "noprogress": True,
        "restrictfilenames": True,
        "nopart": False,
        "overwrites": True,
        "logger": yt_logger,
        "progress_hooks": [progress_hook],
        "match_filter": match_filter,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            )
        },
    }

    if ffmpeg_loc:
        ydl_opts["ffmpeg_location"] = ffmpeg_loc

    deno_path = args.deno_path.strip()
    node_path = args.node_path.strip()
    if deno_path:
        ydl_opts["js_runtimes"] = {"deno": {"path": deno_path}}
    elif node_path:
        ydl_opts["js_runtimes"] = {"node": {"path": node_path}}

    if has_ffmpeg:
        ydl_opts["merge_output_format"] = "mp4"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                emit_json(
                    "RESULT:",
                    {
                        "ok": False,
                        "code": "NOT_FOUND",
                        "message": "Tidak ada metadata media yang ditemukan untuk tautan tersebut.",
                    },
                )
                return 1

            entries = (
                [e for e in info.get("entries") or [] if isinstance(e, dict)]
                if "entries" in info
                else [info]
            )
            if not entries:
                emit_json(
                    "RESULT:",
                    {
                        "ok": False,
                        "code": "NOT_FOUND",
                        "message": "Media tidak ditemukan pada tautan tersebut.",
                    },
                )
                return 1

            # Pre-flight size check when size metadata is reliably available
            known_sizes = [estimate_entry_size(e) for e in entries[:max_items]]
            if len(entries) == 1 and known_sizes[0] is not None and known_sizes[0] > args.max_bytes:
                mb = round(args.max_bytes / (1024 * 1024), 2)
                actual_mb = round(known_sizes[0] / (1024 * 1024), 2)
                emit_json(
                    "RESULT:",
                    {
                        "ok": False,
                        "code": "FILE_TOO_LARGE",
                        "message": f"Ukuran media ({actual_mb} MB) melebihi batas unggahan {mb} MB Discord.",
                    },
                )
                return 1

            emit_json(
                "PROGRESS:",
                {
                    "type": "progress",
                    "status": "downloading",
                    "percent": 0.0,
                    "title": str(info.get("title") or entries[0].get("title") or "")[:120],
                },
            )

            downloaded_info = ydl.extract_info(url, download=True)
            if not downloaded_info:
                emit_json(
                    "RESULT:",
                    {
                        "ok": False,
                        "code": "EXTRACTION_FAILED",
                        "message": "Gagal mengunduh media dari tautan tersebut.",
                    },
                )
                return 1

            files = collect_output_files(downloaded_info, output_dir)
            if not files:
                emit_json(
                    "RESULT:",
                    {
                        "ok": False,
                        "code": "NOT_FOUND",
                        "message": "Tidak ada file media yang berhasil diunduh dari tautan tersebut.",
                    },
                )
                return 1

            total_downloaded = sum(f["size_bytes"] for f in files)
            if len(files) == 1 and total_downloaded > args.max_bytes:
                mb = round(args.max_bytes / (1024 * 1024), 2)
                actual_mb = round(total_downloaded / (1024 * 1024), 2)
                emit_json(
                    "RESULT:",
                    {
                        "ok": False,
                        "code": "FILE_TOO_LARGE",
                        "message": f"Ukuran media ({actual_mb} MB) melebihi batas unggahan {mb} MB Discord.",
                    },
                )
                return 1

            primary_entry = entries[0]
            extractor_key = str(
                downloaded_info.get("extractor_key")
                or downloaded_info.get("extractor")
                or primary_entry.get("extractor_key")
                or primary_entry.get("extractor")
                or ""
            )
            title = str(
                downloaded_info.get("title") or primary_entry.get("title") or ""
            ).strip()[:200]
            author = str(
                downloaded_info.get("uploader")
                or downloaded_info.get("channel")
                or downloaded_info.get("creator")
                or primary_entry.get("uploader")
                or primary_entry.get("channel")
                or ""
            ).strip()[:100]
            duration = downloaded_info.get("duration") or primary_entry.get("duration")

            total_entries = len(info.get("entries") or []) if "entries" in info else len(files)
            truncated_count = max(0, total_entries - len(files)) if total_entries > len(files) else 0

            emit_json(
                "RESULT:",
                {
                    "ok": True,
                    "extractor": extractor_key,
                    "title": title,
                    "author": author,
                    "duration": int(duration) if isinstance(duration, (int, float)) else None,
                    "files": files,
                    "truncated_count": truncated_count,
                },
            )
            return 0

    except SizeLimitExceededError:
        mb = round(args.max_bytes / (1024 * 1024), 2)
        emit_json(
            "RESULT:",
            {
                "ok": False,
                "code": "FILE_TOO_LARGE",
                "message": f"Ukuran media melebihi batas unggahan {mb} MB Discord.",
            },
        )
        return 1
    except DurationLimitExceededError as exc:
        emit_json(
            "RESULT:",
            {
                "ok": False,
                "code": "DURATION_EXCEEDED",
                "message": str(exc),
            },
        )
        return 1
    except yt_dlp.utils.MaxDownloadsReached:
        # Normal termination when max_downloads cap is hit on multi-entry results
        emit_json(
            "RESULT:",
            {
                "ok": False,
                "code": "EXTRACTION_FAILED",
                "message": "Batas jumlah item tercapai tanpa file yang valid.",
            },
        )
        return 1
    except Exception as exc:  # noqa: BLE001
        combined_err = " | ".join([*yt_logger.errors[-2:], str(exc)])
        code, user_msg = classify_ytdlp_error(combined_err)
        emit_json(
            "RESULT:",
            {
                "ok": False,
                "code": code,
                "message": user_msg,
                "details": sanitize_message(combined_err),
            },
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
