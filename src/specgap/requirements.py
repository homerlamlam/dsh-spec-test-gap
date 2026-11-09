"""Lossless paragraph/bullet intake; semantic clause splitting stays human-reviewed."""

import re

from .errors import SpecGapError
from .util import physical_lines, sha256

_EXPLICIT = re.compile(r"\[(REQ-[A-Za-z0-9_-]+)\]")
_NEW = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+|\[REQ-)")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s")


def parse_requirements(text: str) -> list[dict]:
    if not isinstance(text, str):
        raise SpecGapError("Requirements must be text")
    clauses, pending, seen, repeats = [], [], set(), {}
    start, fence = 0, None

    def flush():
        if not pending:
            return
        original = "\n".join(pending)
        match = _EXPLICIT.search(original)
        if match:
            identifier = match.group(1)
        else:
            digest = sha256(original.encode("utf-8"))[:12]
            repeats[digest] = repeats.get(digest, 0) + 1
            identifier = f"REQ-AUTO-{digest}-{repeats[digest]}"
        if identifier in seen:
            raise SpecGapError(f"Duplicate requirement ID: {identifier}")
        seen.add(identifier)
        clauses.append({"id": identifier, "text": original,
                        "start_line": start, "end_line": start + len(pending) - 1})
        pending.clear()

    for number, line in enumerate(physical_lines(text), 1):
        stripped = line.lstrip()
        fence_match = re.match(r"(`{3,}|~{3,})", stripped)
        if fence is not None:
            pending.append(line)
            if fence_match and fence_match.group(1)[0] == fence[0] and len(fence_match.group(1)) >= len(fence):
                fence = None
            continue
        if fence_match:
            if not pending:
                start = number
            fence = fence_match.group(1)
            pending.append(line)
            continue
        if not line.strip() or _HEADING.match(line):
            flush()
            continue
        if _NEW.match(line):
            flush()
        if not pending:
            start = number
        pending.append(line)
    flush()
    if not clauses:
        raise SpecGapError("Requirements contain no reviewable paragraphs or bullets")
    return clauses
