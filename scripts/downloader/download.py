#!/usr/bin/env python3
"""
MIDWAVE yt-dlp media extraction and download worker.
Invoked via child_process.spawn() with an explicit argument array.
Emits throttled PROGRESS:<json> lines and a single final RESULT:<json> line on stdout.
"""

from __future__ import annotations

import argparse
import copy
import io
import ipaddress
import json
import os
import re
import signal
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from typing import Any


class SizeLimitExceededError(Exception):
    """Raised immediately when downloaded bytes exceed the configured max_bytes limit."""


class DurationLimitExceededError(Exception):
    """Raised when media duration exceeds the configured max_duration limit."""


class MissingDependencyError(Exception):
    """Raised when a required runtime dependency (yt-dlp / ffmpeg) is unavailable."""


class UnsafeTargetError(Exception):
    """Raised when a URL, DNS answer, redirect, or socket target points to a forbidden network."""


BLOCKED_HOSTNAMES = frozenset({
    "localhost",
    "metadata.google.internal",
    "metadata.goog",
})

INTERNAL_HOST_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".arpa",
    ".lan",
    ".home",
    ".corp",
    ".localdomain",
)

ALLOWED_NETWORK_PORTS = frozenset({80, 443})
EXTRA_BLOCKED_IPV4_NETS = (
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("192.88.99.0/24"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("240.0.0.0/4"),
    ipaddress.ip_network("255.255.255.255/32"),
)
EXTRA_BLOCKED_IPV6_NETS = (
    ipaddress.ip_network("0100::/64"),
    ipaddress.ip_network("2001::/32"),
    ipaddress.ip_network("2001:2::/48"),
    ipaddress.ip_network("2001:20::/28"),
    ipaddress.ip_network("2001:db8::/32"),
    ipaddress.ip_network("2002::/16"),
    ipaddress.ip_network("3fff::/20"),
    ipaddress.ip_network("5f00::/16"),
    ipaddress.ip_network("fec0::/10"),
)

_NETWORK_GUARD_STATE: dict[str, Any] = {
    "installed": False,
    "lock": threading.Lock(),
    "pinned_ips": {},
    "orig_getaddrinfo": socket.getaddrinfo,
    "orig_connect": socket.socket.connect,
    "orig_connect_ex": socket.socket.connect_ex,
}


def is_private_or_reserved_ip(raw_ip: Any) -> bool:
    """Returns True for loopback, private, link-local, metadata, reserved, multicast, or tunneled IPs."""
    cleaned = str(raw_ip or "").strip().strip("[]").split("%", 1)[0].lower()
    if not cleaned:
        return True
    try:
        ip_obj = ipaddress.ip_address(cleaned)
    except ValueError:
        return True

    if isinstance(ip_obj, ipaddress.IPv6Address):
        val = int(ip_obj)
        # IPv4-mapped (::ffff:0:0/96)
        if ip_obj.ipv4_mapped is not None and is_private_or_reserved_ip(str(ip_obj.ipv4_mapped)):
            return True
        # IPv4-translated (::ffff:0:0:0/96)
        if (val >> 32) == 0xFFFF0000:
            embedded = ipaddress.IPv4Address(val & 0xFFFFFFFF)
            return is_private_or_reserved_ip(str(embedded))
        # IPv4-compatible (::/96)
        if (val >> 32) == 0:
            if val <= 1 or is_private_or_reserved_ip(str(ipaddress.IPv4Address(val & 0xFFFFFFFF))):
                return True
        # NAT64 (64:ff9b::/96 & 64:ff9b:1::/48)
        if (val >> 32) == 0x0064FF9B or (val >> 80) == 0x0064FF9B0001:
            return True
        # 6to4 & Teredo
        if ip_obj.sixtofour is not None or ip_obj.teredo is not None:
            return True
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
            or ip_obj.is_site_local
            or not ip_obj.is_global
        ):
            return True
        return any(ip_obj in net for net in EXTRA_BLOCKED_IPV6_NETS)

    if (
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
        or not ip_obj.is_global
    ):
        return True
    return any(ip_obj in net for net in EXTRA_BLOCKED_IPV4_NETS)


def is_internal_hostname(hostname: str) -> bool:
    clean = str(hostname or "").strip().strip("[]").rstrip(".").lower()
    if not clean:
        return True
    if clean in BLOCKED_HOSTNAMES or "." not in clean:
        return True
    return any(clean.endswith(suffix) for suffix in INTERNAL_HOST_SUFFIXES)


def _is_obfuscated_ipv4_literal(hostname: str) -> bool:
    """Rejects integer, hex, octal, or partial IPv4 forms such as 0177.0.0.1 or 0x7f000001."""
    clean = str(hostname or "").strip().lower().rstrip(".")
    if not clean:
        return True
    parts = clean.split(".")
    if all(re.fullmatch(r"(?:0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)", part) for part in parts):
        return True
    return False


def validate_target_url(raw_url: str, *, allow_public_ip: bool = False) -> str:
    """Validates scheme, absence of userinfo, port (80/443), and non-internal target host/IP."""
    text = str(raw_url or "").strip()
    if not text or re.search(r"\s", text):
        raise UnsafeTargetError("[UNSAFE_TARGET] URL media kosong atau mengandung karakter whitespace tidak valid.")

    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError as exc:
        raise UnsafeTargetError("[UNSAFE_TARGET] Format URL media tidak valid.") from exc

    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise UnsafeTargetError("[UNSAFE_TARGET] Hanya protokol http:// dan https:// yang diizinkan.")

    if parsed.username or parsed.password or "@" in (parsed.netloc or "").split("/")[0]:
        raise UnsafeTargetError("[UNSAFE_TARGET] URL dengan kredensial (userinfo) tidak diizinkan.")

    try:
        port = parsed.port
    except ValueError as exc:
        raise UnsafeTargetError("[UNSAFE_TARGET] Port pada URL media tidak valid.") from exc

    if port is not None and port not in ALLOWED_NETWORK_PORTS:
        raise UnsafeTargetError("[UNSAFE_TARGET] Port kustom selain 80 dan 443 tidak diizinkan.")

    hostname = (parsed.hostname or "").strip().strip("[]").rstrip(".").lower()
    if not hostname:
        raise UnsafeTargetError("[UNSAFE_TARGET] Hostname URL media kosong.")

    is_ip_literal = False
    try:
        ipaddress.ip_address(hostname.split("%", 1)[0])
        is_ip_literal = True
    except ValueError:
        is_ip_literal = False

    if is_ip_literal:
        if not allow_public_ip or is_private_or_reserved_ip(hostname):
            raise UnsafeTargetError("[UNSAFE_TARGET] Koneksi ke alamat IP privat atau langsung diblokir.")
        return text

    if _is_obfuscated_ipv4_literal(hostname):
        raise UnsafeTargetError("[UNSAFE_TARGET] Format IP alternatif pada hostname ditolak.")

    if is_internal_hostname(hostname):
        raise UnsafeTargetError("[UNSAFE_TARGET] Host lokal atau jaringan internal tidak diizinkan.")

    return text


def validate_extracted_info_urls(info: Any) -> None:
    """Recursively validates extracted URLs from yt-dlp info before media download starts."""
    if not isinstance(info, dict):
        return

    url_fields = ("webpage_url", "original_url", "url", "manifest_url")
    for field in url_fields:
        val = info.get(field)
        if isinstance(val, str) and val.strip():
            lower_val = val.strip().lower()
            if lower_val.startswith(("http://", "https://")) or "://" in lower_val:
                validate_target_url(val, allow_public_ip=True)

    for list_field in ("formats", "requested_formats", "requested_downloads", "entries", "thumbnails"):
        items = info.get(list_field)
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict):
                    validate_extracted_info_urls(item)


FFMPEG_PROTOCOL_WHITELIST_ARGS = ("-protocol_whitelist", "file,crypto,data")
_HLS_URI_ATTR_RE = re.compile(r'URI=(?:"([^"]+)"|\'([^\']+)\'|([^,\s]+))', re.IGNORECASE)


def _resolve_and_pin_media_ref(raw_ref: str, base_url: str = "") -> str:
    """Resolves a manifest/fragment/key URI against base_url, validates SSRF rules, and pins DNS."""
    resolved = urllib.parse.urljoin(base_url, str(raw_ref or "").strip()) if base_url else str(raw_ref or "").strip()
    validate_target_url(resolved, allow_public_ip=True)
    parsed = urllib.parse.urlsplit(resolved)
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    socket.getaddrinfo(parsed.hostname, port)
    return resolved


def validate_hls_manifest_urls(manifest_text: str, base_url: str) -> None:
    """Validates and pins all URIs referenced in an HLS manifest (keys, maps, segments, variants)."""
    if base_url:
        _resolve_and_pin_media_ref(base_url)

    for raw_line in str(manifest_text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            for match in _HLS_URI_ATTR_RE.finditer(line):
                uri_val = (match.group(1) or match.group(2) or match.group(3) or "").strip()
                if uri_val:
                    _resolve_and_pin_media_ref(uri_val, base_url)
        else:
            _resolve_and_pin_media_ref(line, base_url)


def install_ytdlp_security_hooks(yt_dlp_module: Any, output_dir: str | None = None) -> None:
    """
    Hardens yt-dlp HLS/FFmpeg downloader and postprocessor paths:
    - Validates HLS manifest keys/segments/variants before download
    - Validates yt-dlp's own urllib RedirectHandler
    - Intercepts HlsFD -> FFmpegFD fallback when ffmpeg rejects http(s) via ffmpeg_i whitelist
    - Guards FFmpegFD and FFmpegPostProcessor inputs/outputs against SSRF and path escape
    """
    _ = yt_dlp_module
    state = _NETWORK_GUARD_STATE
    state["output_dir"] = os.path.realpath(output_dir) if output_dir else None
    if state.get("ytdlp_hooks_installed"):
        return

    import yt_dlp.downloader.external as ext_mod
    import yt_dlp.downloader.hls as hls_mod
    import yt_dlp.postprocessor.ffmpeg as fpp_mod

    try:
        import yt_dlp.networking._urllib as ulib_mod
        import yt_dlp.networking.common as net_common_mod
        import yt_dlp.networking.exceptions as net_exc_mod

        orig_ulib_redirect = ulib_mod.RedirectHandler.redirect_request
        orig_director_send = net_common_mod.RequestDirector.send

        def guarded_ulib_redirect(
            self: Any,
            req: Any,
            fp: Any,
            code: int,
            msg: str,
            headers: Any,
            newurl: str,
        ) -> Any:
            validate_target_url(newurl, allow_public_ip=True)
            return orig_ulib_redirect(self, req, fp, code, msg, headers, newurl)

        def guarded_director_send(self: Any, request: Any) -> Any:
            req_url = getattr(request, "url", None)
            if isinstance(req_url, str) and req_url.strip():
                validate_target_url(req_url, allow_public_ip=True)
            try:
                return orig_director_send(self, request)
            except net_exc_mod.NoSupportingHandlers as exc:
                for inner in getattr(exc, "unexpected_errors", ()):
                    if isinstance(inner, UnsafeTargetError):
                        raise inner from exc
                raise

        ulib_mod.RedirectHandler.redirect_request = guarded_ulib_redirect
        net_common_mod.RequestDirector.send = guarded_director_send
    except ImportError:
        pass

    orig_hls_real_download = hls_mod.HlsFD.real_download
    orig_hls_append_frags = hls_mod.HlsFD.download_and_append_fragments
    orig_ffmpeg_call_downloader = ext_mod.FFmpegFD._call_downloader
    orig_ffmpeg_real_run = fpp_mod.FFmpegPostProcessor.real_run_ffmpeg

    def guarded_hls_real_download(self: Any, filename: str, info_dict: dict[str, Any]) -> Any:
        man_url = info_dict["url"]
        validate_target_url(man_url, allow_public_ip=True)

        manifest_text = info_dict.get("hls_media_playlist_data")
        manifest_bytes: bytes | None = None
        if not manifest_text:
            urlh = self.ydl.urlopen(self._prepare_url(info_dict, man_url))
            man_url = urlh.url
            validate_target_url(man_url, allow_public_ip=True)
            manifest_bytes = urlh.read()
            manifest_text = manifest_bytes.decode("utf-8", "ignore")

        validate_hls_manifest_urls(manifest_text, man_url)
        self._midwave_last_manifest = (manifest_text, man_url)

        orig_ff_real_dl = ext_mod.FFmpegFD.real_download
        orig_ydl_urlopen = self.ydl.urlopen
        cached_consumed = {"done": manifest_bytes is None}

        class _CachedManifestResponse:
            def __init__(self, data: bytes, final_url: str) -> None:
                self._buf = io.BytesIO(data)
                self.url = final_url

            def read(self, *rargs: Any) -> bytes:
                return self._buf.read(*rargs)

        def cached_manifest_urlopen(req: Any, *uargs: Any, **ukwargs: Any) -> Any:
            if not cached_consumed["done"] and manifest_bytes is not None:
                cached_consumed["done"] = True
                return _CachedManifestResponse(manifest_bytes, man_url)
            return orig_ydl_urlopen(req, *uargs, **ukwargs)

        def guarded_delegated_ffmpeg_real_dl(
            ff_self: Any,
            ff_filename: str,
            ff_info: dict[str, Any],
        ) -> bool:
            events: list[Any] = state.setdefault("last_events", [])
            input_args = list(ff_self._configuration_args(("_i1", "_i")))
            events.append(("ffmpeg_delegated", input_args))

            ff_self.report_destination(ff_filename)
            tmpfilename = ff_self.temp_name(ff_filename)
            ff_self._cookies_tempfile = None
            try:
                started = time.time()
                retval = ff_self._call_downloader(tmpfilename, ff_info)
            finally:
                if getattr(ff_self, "_cookies_tempfile", None):
                    ff_self.try_remove(ff_self._cookies_tempfile)

            if retval == 0:
                status: dict[str, Any] = {
                    "filename": ff_filename,
                    "status": "finished",
                    "elapsed": time.time() - started,
                }
                if ff_filename != "-":
                    fsize = os.path.getsize(tmpfilename)
                    ff_self.try_rename(tmpfilename, ff_filename)
                    status.update({"downloaded_bytes": fsize, "total_bytes": fsize})
                ff_self._hook_progress(status, ff_info)
                return True

            events.append(("ffmpeg_failed_fallback", int(retval)))
            if ff_filename != "-" and tmpfilename and os.path.exists(tmpfilename):
                ff_self.try_remove(tmpfilename)

            validate_hls_manifest_urls(manifest_text, man_url)
            if self.can_download(
                manifest_text,
                info_dict,
                self.params.get("allow_unplayable_formats"),
            ):
                fallback_info = dict(info_dict)
                fallback_info["hls_media_playlist_data"] = manifest_text
                fallback_info["url"] = man_url
                return orig_hls_real_download(self, ff_filename, fallback_info)

            ff_self.report_error(f"{ff_self.get_basename()} exited with code {retval}")
            return False

        ext_mod.FFmpegFD.real_download = guarded_delegated_ffmpeg_real_dl
        self.ydl.urlopen = cached_manifest_urlopen
        try:
            return orig_hls_real_download(self, filename, info_dict)
        finally:
            self.ydl.urlopen = orig_ydl_urlopen
            ext_mod.FFmpegFD.real_download = orig_ff_real_dl

    def guarded_hls_append_frags(
        self: Any,
        ctx: dict[str, Any],
        fragments: list[dict[str, Any]],
        info_dict: dict[str, Any],
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        last_manifest = getattr(self, "_midwave_last_manifest", None)
        if isinstance(last_manifest, tuple) and len(last_manifest) == 2:
            validate_hls_manifest_urls(last_manifest[0], last_manifest[1])

        for frag in fragments:
            if not isinstance(frag, dict):
                continue
            frag_url = frag.get("url")
            if frag_url:
                _resolve_and_pin_media_ref(frag_url)
            dec = frag.get("decrypt_info")
            if isinstance(dec, dict):
                key_uri = dec.get("URI")
                if isinstance(key_uri, str) and key_uri.strip():
                    _resolve_and_pin_media_ref(key_uri)

        return orig_hls_append_frags(self, ctx, fragments, info_dict, *args, **kwargs)

    def guarded_ffmpeg_call_downloader(
        self: Any,
        tmpfilename: str,
        info_dict: dict[str, Any],
    ) -> int:
        out_dir = state.get("output_dir")
        if out_dir and tmpfilename and tmpfilename != "-":
            assert_inside_dir(out_dir, tmpfilename)

        sanitized_info = dict(info_dict)
        sanitized_info.pop("downloader_options", None)
        selected = sanitized_info.get("requested_formats") or [sanitized_info]
        clean_selected: list[dict[str, Any]] = []
        for fmt in selected:
            if not isinstance(fmt, dict):
                continue
            fmt_url = fmt.get("url")
            if not isinstance(fmt_url, str) or not fmt_url.strip():
                raise UnsafeTargetError("[UNSAFE_TARGET] Target FFmpeg tanpa URL tidak diizinkan.")
            validate_target_url(fmt_url, allow_public_ip=True)
            fmt_copy = dict(fmt)
            fmt_copy.pop("downloader_options", None)
            clean_selected.append(fmt_copy)

        if sanitized_info.get("requested_formats"):
            sanitized_info["requested_formats"] = clean_selected
        elif clean_selected:
            sanitized_info.update(clean_selected[0])

        return orig_ffmpeg_call_downloader(self, tmpfilename, sanitized_info)

    def guarded_ffmpeg_real_run(
        self: Any,
        input_path_opts: list[tuple[str, list[str]]],
        output_path_opts: list[tuple[str, list[str]]],
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        out_dir = state.get("output_dir")
        guarded_inputs: list[tuple[str, list[str]]] = []
        for path_val, opts in input_path_opts:
            if out_dir and path_val and path_val != "-":
                assert_inside_dir(out_dir, path_val)
            opts_list = list(opts or [])
            if "-protocol_whitelist" not in opts_list:
                opts_list = [*FFMPEG_PROTOCOL_WHITELIST_ARGS, *opts_list]
            guarded_inputs.append((path_val, opts_list))

        for path_val, _ in output_path_opts:
            if out_dir and path_val and path_val != "-":
                assert_inside_dir(out_dir, path_val)

        return orig_ffmpeg_real_run(self, guarded_inputs, output_path_opts, *args, **kwargs)

    hls_mod.HlsFD.real_download = guarded_hls_real_download
    hls_mod.HlsFD.download_and_append_fragments = guarded_hls_append_frags
    ext_mod.FFmpegFD._call_downloader = guarded_ffmpeg_call_downloader
    fpp_mod.FFmpegPostProcessor.real_run_ffmpeg = guarded_ffmpeg_real_run
    state["orig_ffmpeg_call_downloader"] = orig_ffmpeg_call_downloader
    state["ytdlp_hooks_installed"] = True


def build_ydl_opts(
    *,
    output_dir: str,
    max_bytes: int,
    has_ffmpeg: bool,
    max_items: int,
    timeout: int,
    yt_logger: Any,
    progress_hook: Any,
    match_filter: Any,
    ffmpeg_loc: str | None = None,
    deno_path: str = "",
    node_path: str = "",
) -> dict[str, Any]:
    """Builds hardened yt-dlp options with ffmpeg_i input protocol whitelist."""
    ydl_opts: dict[str, Any] = {
        "outtmpl": os.path.join(output_dir, "media_%(autonumber)s.%(ext)s"),
        "paths": {"home": output_dir, "temp": output_dir},
        "format": build_format_selector(max_bytes, has_ffmpeg),
        "noplaylist": True,
        "playlist_items": f"1-{max_items}",
        "socket_timeout": max(5, min(timeout, 30)),
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
        "hls_prefer_native": True,
        "enable_file_urls": False,
        "external_downloader_args": {
            "ffmpeg_i": list(FFMPEG_PROTOCOL_WHITELIST_ARGS),
        },
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            )
        },
    }

    if ffmpeg_loc:
        ydl_opts["ffmpeg_location"] = ffmpeg_loc

    deno_clean = str(deno_path or "").strip()
    node_clean = str(node_path or "").strip()
    if deno_clean:
        ydl_opts["js_runtimes"] = {"deno": {"path": deno_clean}}
    elif node_clean:
        ydl_opts["js_runtimes"] = {"node": {"path": node_clean}}

    if has_ffmpeg:
        ydl_opts["merge_output_format"] = "mp4"

    return ydl_opts


class _GuardedHttpRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Validates every HTTP redirect destination before urllib follows it."""

    def redirect_request(self, req: urllib.request.Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> urllib.request.Request | None:
        validate_target_url(newurl, allow_public_ip=True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def install_network_security_guard(pinned_host_args: list[str] | None = None) -> dict[str, str]:
    """
    Installs process-wide socket/DNS/redirect guards so yt-dlp and secondary extractors cannot
    connect to private/reserved/metadata IPs, arbitrary ports, or perform DNS rebinding.
    """
    state = _NETWORK_GUARD_STATE
    with state["lock"]:
        state["pinned_ips"].clear()
        for entry in pinned_host_args or []:
            if "=" not in str(entry):
                continue
            raw_host, raw_ip = str(entry).split("=", 1)
            clean_host = raw_host.strip().strip("[]").rstrip(".").lower()
            clean_ip = raw_ip.strip().strip("[]").split("%", 1)[0]
            if not clean_host or is_internal_hostname(clean_host) or is_private_or_reserved_ip(clean_ip):
                raise UnsafeTargetError("[UNSAFE_TARGET] Pinned host mengarah ke alamat IP yang dilarang.")
            state["pinned_ips"][clean_host] = clean_ip

        if not state["installed"]:
            orig_getaddrinfo = state["orig_getaddrinfo"]
            orig_connect = state["orig_connect"]
            orig_connect_ex = state["orig_connect_ex"]

            def guarded_getaddrinfo(host: Any, port: Any, family: int = 0, type: int = 0, proto: int = 0, flags: int = 0) -> list[Any]:
                clean_port = port
                if isinstance(clean_port, bytes):
                    clean_port = clean_port.decode("ascii", errors="ignore")
                if clean_port not in (None, 0, "0", 80, 443, "80", "443", "http", "https"):
                    raise UnsafeTargetError(f"[UNSAFE_TARGET] Port koneksi '{clean_port}' tidak diizinkan.")

                host_text = (
                    host.decode("ascii", errors="ignore") if isinstance(host, bytes) else str(host or "")
                )
                clean_host = host_text.strip().strip("[]").rstrip(".").lower()
                if not clean_host:
                    raise UnsafeTargetError("[UNSAFE_TARGET] Target host kosong diblokir.")

                try:
                    ipaddress.ip_address(clean_host.split("%", 1)[0])
                    is_literal = True
                except ValueError:
                    is_literal = False

                if is_literal:
                    if is_private_or_reserved_ip(clean_host):
                        raise UnsafeTargetError("[UNSAFE_TARGET] Koneksi ke alamat IP internal/privat diblokir.")
                    return orig_getaddrinfo(host, port, family, type, proto, flags)

                if _is_obfuscated_ipv4_literal(clean_host) or is_internal_hostname(clean_host):
                    raise UnsafeTargetError("[UNSAFE_TARGET] Resolusi hostname lokal atau internal diblokir.")

                with state["lock"]:
                    pinned_ip = state["pinned_ips"].get(clean_host)

                if pinned_ip:
                    return orig_getaddrinfo(pinned_ip, port, family, type, proto, flags)

                results = orig_getaddrinfo(host, port, family, type, proto, flags)
                if not results:
                    raise UnsafeTargetError("[UNSAFE_TARGET] Resolusi DNS tidak menghasilkan alamat tujuan.")

                validated_ips: list[str] = []
                for item in results:
                    sockaddr = item[4]
                    resolved_ip = sockaddr[0] if isinstance(sockaddr, tuple) and sockaddr else ""
                    if is_private_or_reserved_ip(resolved_ip):
                        raise UnsafeTargetError("[UNSAFE_TARGET] Resolusi DNS mengarah ke alamat IP internal/privat.")
                    validated_ips.append(str(resolved_ip).split("%", 1)[0])

                with state["lock"]:
                    state["pinned_ips"].setdefault(clean_host, validated_ips[0])

                return results

            def _check_socket_address(sock: socket.socket, address: Any) -> None:
                if getattr(sock, "family", None) not in (socket.AF_INET, socket.AF_INET6):
                    return
                if not isinstance(address, tuple) or len(address) < 2:
                    raise UnsafeTargetError("[UNSAFE_TARGET] Alamat socket tujuan tidak valid.")
                target_host, target_port = address[0], address[1]
                if target_port not in ALLOWED_NETWORK_PORTS:
                    raise UnsafeTargetError(f"[UNSAFE_TARGET] Koneksi socket ke port {target_port} tidak diizinkan.")
                if is_private_or_reserved_ip(str(target_host)):
                    raise UnsafeTargetError("[UNSAFE_TARGET] Koneksi socket ke alamat IP internal/privat diblokir.")

            def guarded_connect(self: socket.socket, address: Any) -> Any:
                _check_socket_address(self, address)
                return orig_connect(self, address)

            def guarded_connect_ex(self: socket.socket, address: Any) -> int:
                _check_socket_address(self, address)
                return orig_connect_ex(self, address)

            socket.getaddrinfo = guarded_getaddrinfo  # type: ignore[assignment]
            socket.socket.connect = guarded_connect  # type: ignore[method-assign]
            socket.socket.connect_ex = guarded_connect_ex  # type: ignore[method-assign]
            urllib.request.install_opener(urllib.request.build_opener(_GuardedHttpRedirectHandler()))
            state["installed"] = True

        return dict(state["pinned_ips"])


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

    if (
        "[unsafe_target]" in msg
        or "alamat ip internal" in msg
        or "alamat ip privat" in msg
        or "diblokir demi keamanan" in msg
        or "tidak diizinkan" in msg and ("port " in msg or "hostname" in msg or "userinfo" in msg)
    ):
        return (
            "UNSAFE_TARGET",
            "Tujuan URL atau pengalihan mengarah ke jaringan internal atau port terlarang yang diblokir demi keamanan.",
        )

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


def compute_output_dir_bytes(output_dir: str) -> int:
    """Computes total bytes of all non-metadata files currently present in `output_dir`."""
    total = 0
    try:
        for entry in os.scandir(output_dir):
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                continue
            if entry.name.endswith(".json"):
                continue
            try:
                total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
    except OSError:
        return total
    return total


def cleanup_partial_files(output_dir: str, *, remove_all: bool = False) -> None:
    """Removes partial (.part/.ytdl/.temp/.tmp) or all downloaded files inside `output_dir`."""
    try:
        for entry in os.scandir(output_dir):
            if entry.is_symlink():
                try:
                    os.unlink(entry.path)
                except OSError:
                    pass
                continue
            if not entry.is_file(follow_symlinks=False):
                continue
            if remove_all or entry.name.endswith((".part", ".ytdl", ".temp", ".tmp")):
                try:
                    os.remove(entry.path)
                except OSError:
                    pass
    except OSError:
        pass


def enforce_multi_item_budget(
    budget_state: dict[str, Any],
    output_dir: str,
    max_bytes: int,
    status: dict[str, Any],
) -> tuple[int, int]:
    """
    Enforces per-item AND cumulative byte caps across all carousel items/streams during yt-dlp progress hooks.
    Aborts and deletes temporary files immediately if cumulative usage exceeds `max_bytes`.
    """
    completed_files: dict[str, int] = budget_state.setdefault("completed_files", {})
    active_files: dict[str, int] = budget_state.setdefault("active_files", {})

    state = status.get("status")
    key = str(status.get("tmpfilename") or status.get("filename") or "__active__")
    downloaded = int(status.get("downloaded_bytes") or 0)
    total = int(status.get("total_bytes") or status.get("total_bytes_estimate") or 0)

    if state == "finished":
        active_files.pop(key, None)
        final_path = str(status.get("filename") or key)
        actual_size = downloaded
        if final_path and os.path.isfile(final_path):
            try:
                actual_size = max(actual_size, os.path.getsize(final_path))
            except OSError:
                pass
        completed_files[final_path] = actual_size
    elif state == "downloading":
        est_item = downloaded
        if total > 0 and (total > max_bytes and downloaded > int(max_bytes * 0.2) or len(completed_files) > 0):
            est_item = max(downloaded, total)
        active_files[key] = max(active_files.get(key, 0), est_item)

    if downloaded > max_bytes:
        cleanup_partial_files(output_dir, remove_all=True)
        raise SizeLimitExceededError(
            f"Downloaded bytes ({downloaded}) exceeded limit ({max_bytes})."
        )

    if total > 0 and total > max_bytes and downloaded > int(max_bytes * 0.2):
        cleanup_partial_files(output_dir, remove_all=True)
        raise SizeLimitExceededError(
            f"Estimated total size ({total}) exceeded limit ({max_bytes})."
        )

    aggregate_tracked = sum(completed_files.values()) + sum(
        val for active_key, val in active_files.items() if active_key not in completed_files
    )
    disk_usage = compute_output_dir_bytes(output_dir)
    if max(aggregate_tracked, disk_usage) > max_bytes:
        cleanup_partial_files(output_dir, remove_all=True)
        raise SizeLimitExceededError(
            f"Aggregate media bytes ({max(aggregate_tracked, disk_usage)}) exceeded limit ({max_bytes})."
        )

    return downloaded, total


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
    parser.add_argument("--pinned-host", action="append", default=[], help="Validated hostname=ip pin")
    args = parser.parse_args()

    output_dir = os.path.realpath(args.output_dir)
    if not os.path.isdir(output_dir) or os.path.islink(args.output_dir):
        emit_json(
            "RESULT:",
            {"ok": False, "code": "EXTRACTION_FAILED", "message": "Direktori sementara unduhan tidak valid atau tidak ditemukan."},
        )
        return 1

    def _handle_termination(_signum: int, _frame: Any) -> None:
        cleanup_partial_files(output_dir, remove_all=True)
        raise SystemExit(143)

    signal.signal(signal.SIGTERM, _handle_termination)
    if hasattr(signal, "SIGINT"):
        signal.signal(signal.SIGINT, _handle_termination)

    url = args.url.strip()
    try:
        validate_target_url(url, allow_public_ip=False)
        install_network_security_guard(args.pinned_host)
    except UnsafeTargetError as exc:
        emit_json(
            "RESULT:",
            {
                "ok": False,
                "code": "UNSAFE_TARGET",
                "message": "Tujuan URL atau pengalihan mengarah ke jaringan internal atau port terlarang yang diblokir demi keamanan.",
                "details": sanitize_message(exc),
            },
        )
        return 1

    yt_dlp = None
    try:
        import yt_dlp as _yt_dlp  # type: ignore

        yt_dlp = _yt_dlp
    except ImportError:
        ytdlp_zip = (args.ytdlp_path or "").strip()
        if ytdlp_zip and os.path.isfile(ytdlp_zip) and not os.path.islink(ytdlp_zip):
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
    budget_state: dict[str, Any] = {"completed_files": {}, "active_files": {}}

    def progress_hook(status: dict[str, Any]) -> None:
        nonlocal last_progress_emit
        state = status.get("status")
        downloaded, total = enforce_multi_item_budget(
            budget_state,
            output_dir,
            args.max_bytes,
            status,
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

    ydl_opts = build_ydl_opts(
        output_dir=output_dir,
        max_bytes=args.max_bytes,
        has_ffmpeg=has_ffmpeg,
        max_items=max_items,
        timeout=args.timeout,
        yt_logger=yt_logger,
        progress_hook=progress_hook,
        match_filter=match_filter,
        ffmpeg_loc=ffmpeg_loc,
        deno_path=args.deno_path,
        node_path=args.node_path,
    )
    install_ytdlp_security_hooks(yt_dlp, output_dir=output_dir)

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
            if "entries" in info and not isinstance(info.get("entries"), list):
                info["entries"] = entries
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

            validate_extracted_info_urls(info)

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

            # Reuse validated extraction snapshot instead of re-extracting URL (eliminates TOCTOU)
            downloaded_info = ydl.process_ie_result(copy.deepcopy(info), download=True)
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
            if total_downloaded > args.max_bytes:
                cleanup_partial_files(output_dir, remove_all=True)
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

    except UnsafeTargetError as exc:
        cleanup_partial_files(output_dir, remove_all=True)
        emit_json(
            "RESULT:",
            {
                "ok": False,
                "code": "UNSAFE_TARGET",
                "message": "Tujuan URL atau pengalihan mengarah ke jaringan internal atau port terlarang yang diblokir demi keamanan.",
                "details": sanitize_message(exc),
            },
        )
        return 1
    except SizeLimitExceededError:
        cleanup_partial_files(output_dir, remove_all=True)
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
