"""Validate evidence references, never certify the semantic truth of a review."""

import copy
import re

from .errors import SpecGapError
from .util import canonical_hash, physical_lines

REQUIREMENT_STATES = {"supported", "partial", "contradicted", "no_evidence", "unclear"}
CHANGE_STATES = {"behavior_changed", "implementation_only", "unknown"}
FINDING_KINDS = {"contradiction", "partial", "no_evidence", "undocumented_change", "ambiguity", "regression", "test_gap", "unknown"}
ROLES = {"developer", "product", "qa", "security"}


def _object(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise SpecGapError(f"Invalid {label} fields")


def _text(value, label, limit=12000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise SpecGapError(f"Invalid or empty {label}")


def _list(value, label, limit=10000):
    if not isinstance(value, list) or len(value) > limit:
        raise SpecGapError(f"Invalid {label} list")


def _enum(value, allowed, label):
    if not isinstance(value, str) or value not in allowed:
        raise SpecGapError(f"Invalid {label}")


def _refs(value, known, label):
    _list(value, label)
    if any(not isinstance(v, str) or v not in known for v in value) or len(set(value)) != len(value):
        raise SpecGapError(f"Unknown or duplicate {label}")


def validate_citations(bundle, citations):
    _list(citations, "evidence", 200)
    sources = {(s["side"], s["path"]): s for s in bundle["sources"]}
    seen = set()
    for cite in citations:
        _object(cite, "side path start_line end_line quote", "citation")
        _enum(cite["side"], {"base", "head"}, "citation side")
        _text(cite["path"], "citation path", 4096)
        start, end = cite["start_line"], cite["end_line"]
        if type(start) is not int or type(end) is not int or start < 1 or end < start or end - start >= 40:
            raise SpecGapError("Citation range must be 1–40 exact lines")
        source = sources.get((cite["side"], cite["path"]))
        if source is None:
            raise SpecGapError("Citation is not in frozen source context")
        lines = physical_lines(source["content"])
        if (end > len(lines) or not isinstance(cite["quote"], str)
                or len(cite["quote"]) > 65536 or cite["quote"] != "\n".join(lines[start - 1:end])):
            raise SpecGapError("Citation quote does not match its exact frozen lines")
        digest = canonical_hash(cite)
        if digest in seen:
            raise SpecGapError("Duplicate citation")
        seen.add(digest)


def review_template(bundle):
    return {"schema_version": "1", "snapshot_id": bundle["snapshot_id"],
            "requirements": [{"id": r["id"], "assessment": "unassessed", "reason": "", "evidence": []}
                             for r in bundle["requirements"]["clauses"]],
            "changes": [{"id": c["id"], "assessment": "unassessed", "summary": "",
                         "requirement_ids": [], "evidence": []} for c in bundle["changes"]],
            "findings": []}


def validate_review(bundle, review) -> dict:
    canonical_hash(review)
    _object(review, "schema_version snapshot_id requirements changes findings", "review")
    if review["schema_version"] != "1" or review["snapshot_id"] != bundle["snapshot_id"]:
        raise SpecGapError("Review schema or snapshot mismatch")
    req_ids = {r["id"] for r in bundle["requirements"]["clauses"]}
    changes = {c["id"]: c for c in bundle["changes"]}
    for section, expected in (("requirements", req_ids), ("changes", set(changes))):
        _list(review[section], section)
        ids = []
        for item in review[section]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                raise SpecGapError(f"Invalid {section} entry")
            ids.append(item["id"])
        if len(set(ids)) != len(ids) or set(ids) != expected:
            raise SpecGapError(f"Every {section} ID must be assessed exactly once")
    for item in review["requirements"]:
        _object(item, "id assessment reason evidence", "requirement assessment")
        _enum(item["assessment"], REQUIREMENT_STATES, "requirement assessment")
        _text(item["reason"], "requirement reason")
        validate_citations(bundle, item["evidence"])
        if item["assessment"] in {"supported", "partial", "contradicted"} and not item["evidence"]:
            raise SpecGapError("Implementation assessment requires evidence")
        if item["assessment"] == "supported" and not any(e["side"] == "head" for e in item["evidence"]):
            raise SpecGapError("Supported requirement requires head evidence")
    available = {(s["side"], s["path"]) for s in bundle["sources"]}
    for item in review["changes"]:
        _object(item, "id assessment summary requirement_ids evidence", "change assessment")
        _enum(item["assessment"], CHANGE_STATES, "change assessment")
        _text(item["summary"], "change summary")
        _refs(item["requirement_ids"], req_ids, "change requirement references")
        validate_citations(bundle, item["evidence"])
        if item["assessment"] == "behavior_changed":
            change = changes[item["id"]]
            needed = {(side, change[key]) for side, key in (("base", "old_path"), ("head", "new_path"))
                      if change[key] is not None and (side, change[key]) in available}
            actual = {(e["side"], e["path"]) for e in item["evidence"]}
            if not needed or not needed <= actual:
                raise SpecGapError("Behavior change requires evidence on every available changed side")
    _list(review["findings"], "findings", 2000)
    seen = set()
    for item in review["findings"]:
        _object(item, "id kind title description severity requirement_ids change_ids evidence question suggested_role test_ideas", "finding")
        if not isinstance(item["id"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", item["id"]) or item["id"] in seen:
            raise SpecGapError("Finding IDs must be unique nonempty identifiers")
        seen.add(item["id"])
        _enum(item["kind"], FINDING_KINDS, "finding kind")
        _enum(item["severity"], {"low", "medium", "high", "critical"}, "finding severity")
        _enum(item["suggested_role"], ROLES, "suggested role")
        for field in ("title", "description", "question"):
            _text(item[field], field)
        _refs(item["requirement_ids"], req_ids, "finding requirement references")
        _refs(item["change_ids"], set(changes), "finding change references")
        if not item["requirement_ids"] and not item["change_ids"]:
            raise SpecGapError("Finding must identify its review origin")
        if item["kind"] == "undocumented_change" and not item["change_ids"]:
            raise SpecGapError("Undocumented change must cite a feature change, not only legacy code")
        if item["kind"] in {"contradiction", "partial", "no_evidence", "ambiguity"} and not item["requirement_ids"]:
            raise SpecGapError("Requirement-related finding needs a requirement ID")
        validate_citations(bundle, item["evidence"])
        if item["kind"] in {"contradiction", "partial", "undocumented_change", "regression"} and not item["evidence"]:
            raise SpecGapError("Definite behavior finding requires evidence")
        _list(item["test_ideas"], "test ideas", 100)
        for idea in item["test_ideas"]:
            _text(idea, "test idea")
    return copy.deepcopy(review)


def review_state(bundle, review):
    if review is None:
        return "needs_review"
    if (bundle["limitations"] or any(r["assessment"] == "unclear" for r in review["requirements"])
            or any(c["assessment"] == "unknown" for c in review["changes"])
            or any(f["kind"] == "unknown" for f in review["findings"])):
        return "partial"
    return "ready_for_review"
