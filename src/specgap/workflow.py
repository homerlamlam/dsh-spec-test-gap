"""Human attestations keep authority, disposition and verification separate."""

from pathlib import Path

from .errors import SpecGapError, StaleRunError, SequenceConflictError
from .report import finding_state
from .review import review_state, validate_review
from .snapshot import freshness
from .store import (append_event_locked, load_events, load_policy, load_review, load_run,
                    mutation_lock, save_review_locked)
from .util import read_bytes, sha256

DECISION_ROLES = {"confirm_defect": "qa", "not_an_issue": "qa",
                  "approve_intent_change": "product", "accept_risk": "security"}


def stale_reasons(bundle):
    return freshness(bundle, Path(bundle["repo"]["root"]), Path(bundle["requirements"]["path"]))


def require_fresh(bundle):
    reasons = stale_reasons(bundle)
    if reasons:
        raise StaleRunError("Stale run: " + "; ".join(reasons) + ". Prepare a new run; history is retained.")


def import_review(run, review):
    with mutation_lock(run):
        bundle = load_run(run)
        require_fresh(bundle)
        validated = validate_review(bundle, review)
        save_review_locked(run, validated)
    return validated


def _context(run, finding, actor, attest_local, role=None):
    bundle = load_run(run)
    require_fresh(bundle)
    if attest_local is not True:
        raise SpecGapError("Explicit local attestation is required; this does not authenticate identity")
    actors = load_policy(run)["actors"]
    if not isinstance(actor, str) or actor not in actors or (role and role not in actors[actor]):
        raise SpecGapError("Actor is not allowed for this action by the frozen local policy")
    review = load_review(run)
    if review is None:
        raise SpecGapError("Import a validated review before recording human actions")
    validate_review(bundle, review)
    if not isinstance(finding, str) or finding not in {f["id"] for f in review["findings"]}:
        raise SpecGapError("Unknown finding ID")
    return bundle


def _text(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 12000:
        raise SpecGapError(f"{label} must be nonempty text, at most 12000 characters")


def _event(kind, bundle, finding, actor, **fields):
    return dict(kind=kind, snapshot_id=bundle["snapshot_id"], finding_id=finding, actor=actor,
                assurance="local_attestation", **fields)


def _require_sequence_locked(run, expected_sequence):
    # Legacy core/CLI callers may omit the token. UI callers must supply one.
    if expected_sequence is None:
        return
    if type(expected_sequence) is not int or expected_sequence < 0:
        raise SpecGapError("Expected sequence must be a nonnegative integer")
    if len(load_events(run)) != expected_sequence:
        raise SequenceConflictError("Event history changed; refresh the run before acting")


def record_response(run, finding, actor, text, attest_local=False, *, expected_sequence=None):
    _text(text, "Response")
    with mutation_lock(run):
        _require_sequence_locked(run, expected_sequence)
        bundle = _context(run, finding, actor, attest_local)
        return append_event_locked(run, _event("response", bundle, finding, actor, text=text))


def record_decision(run, finding, actor, outcome, reason, attest_local=False, *, expected_sequence=None):
    if not isinstance(outcome, str) or outcome not in DECISION_ROLES:
        raise SpecGapError("Unknown decision outcome")
    _text(reason, "Decision reason")
    with mutation_lock(run):
        _require_sequence_locked(run, expected_sequence)
        bundle = _context(run, finding, actor, attest_local, DECISION_ROLES[outcome])
        return append_event_locked(run, _event("decision", bundle, finding, actor, outcome=outcome, reason=reason))


def record_verification(run, finding, actor, result, evidence, note, attest_local=False, *, expected_sequence=None):
    if result not in ("passed", "failed"):
        raise SpecGapError("Verification result must be passed or failed")
    _text(note, "Verification note")
    with mutation_lock(run):
        _require_sequence_locked(run, expected_sequence)
        bundle = _context(run, finding, actor, attest_local, "qa")
        decisions = [e for e in load_events(run) if e["kind"] == "decision" and e["finding_id"] == finding]
        if result == "passed" and not decisions:
            raise SpecGapError("Passed verification requires a prior decision, not just a response")
        raw = read_bytes(evidence, max_bytes=65536)
        try:
            text = raw.decode("utf-8")
        except UnicodeError as exc:
            raise SpecGapError("Verification evidence must be UTF-8 text") from exc
        if not text.strip() or "\0" in text:
            raise SpecGapError("Verification evidence must be nonempty text")
        require_fresh(bundle)
        return append_event_locked(run, _event("verification", bundle, finding, actor,
            result=result, note=note, evidence_name=Path(evidence).name, evidence_sha256=sha256(raw),
            evidence_content=text, decision_sequence=decisions[-1]["sequence"] if decisions else None))


def status(run):
    return status_from_events(load_run(run), load_review(run), load_events(run))


def status_from_events(bundle, review, events):
    """Derive status from an already validated event snapshot, without reloading it."""
    if review is not None:
        validate_review(bundle, review)
    stale = stale_reasons(bundle)
    return {"schema_version": "1", "snapshot_id": bundle["snapshot_id"],
            "review_state": review_state(bundle, review), "stale": bool(stale), "stale_reasons": stale,
            "assurance": "local_attestation_only", "limitation_count": len(bundle["limitations"]),
            "findings": {f["id"]: finding_state(f, events) for f in review["findings"]} if review else {},
            "event_count": len(events), "release_approval": False}
