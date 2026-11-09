"""Small strict serialization and local filesystem boundaries."""

import hashlib
import html
import json
import math
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .errors import SpecGapError

MAX_ARTIFACT_BYTES = 16 * 1024 * 1024


def physical_lines(text: str) -> list[str]:
    """Split LF/CRLF/CR only, matching source locations rather than Unicode layout."""
    if not text:
        return []
    lines = re.split(r"\r\n|\r|\n", text)
    if text.endswith(("\n", "\r")):
        lines.pop()
    return lines


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SpecGapError("Duplicate JSON object key")
        result[key] = value
    return result


def _float(value):
    result = float(value)
    if not math.isfinite(result):
        raise SpecGapError("Non-finite JSON number")
    return result


def _constant(_value):
    raise SpecGapError("Non-finite JSON number")


def strict_loads(text: str):
    try:
        return json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant, parse_float=_float)
    except SpecGapError:
        raise
    except (ValueError, RecursionError) as exc:
        raise SpecGapError("Invalid or unsupported UTF-8 JSON") from exc


def canonical_hash(data) -> str:
    try:
        encoded = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                             allow_nan=False).encode("utf-8")
        return sha256(encoded)
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise SpecGapError("Value cannot be encoded as canonical JSON") from exc


def safe_path(path) -> Path:
    """Refuse symlinks/junctions in local artifact paths, including ancestors.

    This is not an OS sandbox or a defense against an actively racing local user.
    """
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise SpecGapError("Symlink or reparse-point artifact path is not allowed")
    return path


def read_bytes(path, max_bytes=MAX_ARTIFACT_BYTES) -> bytes:
    path = safe_path(path)
    try:
        with path.open("rb") as stream:
            result = stream.read(max_bytes + 1)
    except OSError as exc:
        raise SpecGapError(f"Cannot read file: {path.name}") from exc
    if len(result) > max_bytes:
        raise SpecGapError(f"File exceeds byte limit: {path.name}")
    return result


def read_json(path, max_bytes=MAX_ARTIFACT_BYTES):
    try:
        return strict_loads(read_bytes(path, max_bytes).decode("utf-8"))
    except UnicodeError as exc:
        raise SpecGapError("JSON must be UTF-8") from exc


def write_json(path, data):
    """Atomically replace an owned artifact; callers authorize destination first."""
    path = safe_path(path)
    canonical_hash(data)  # Validate before creating files.
    encoded = (json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2,
                          allow_nan=False) + "\n").encode("utf-8")
    if len(encoded) > MAX_ARTIFACT_BYTES:
        raise SpecGapError("Artifact exceeds byte limit")
    descriptor, temporary = tempfile.mkstemp(prefix=".specgap-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        safe_path(path)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def safe_text(text) -> str:
    """Escape untrusted content as inert Markdown text, not links or raw HTML."""
    value = str(text)
    value = "".join(c for c in value if c in "\n\t" or ord(c) >= 32)
    value = html.escape(value, quote=True)
    return re.sub(r"([\\`*_{}\[\]()#!|>+~.\-])", r"\\\1", value)
