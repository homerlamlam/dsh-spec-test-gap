"""Local checksummed artifacts; integrity is not authenticated identity."""

import os
from contextlib import contextmanager
from pathlib import Path

from .errors import SpecGapError
from .util import canonical_hash, read_json, safe_path, utc_now, write_json

ROLES = {"developer", "product", "qa", "security"}


def _seal(data):
    return {"data": data, "sha256": canonical_hash(data)}


def _unseal(path):
    envelope = read_json(path)
    if (not isinstance(envelope, dict) or set(envelope) != {"data", "sha256"}
            or canonical_hash(envelope["data"]) != envelope["sha256"]):
        raise SpecGapError(f"Artifact integrity check failed: {path.name}")
    return envelope["data"]


def _validate_policy(policy):
    if not isinstance(policy, dict) or set(policy) != {"actors"} or not isinstance(policy["actors"], dict):
        raise SpecGapError("Policy must contain an actors mapping")
    for name, roles in policy["actors"].items():
        if (not isinstance(name, str) or not name.strip() or len(name) > 120
                or not isinstance(roles, list) or not roles
                or any(not isinstance(role, str) or role not in ROLES for role in roles)
                or len(set(roles)) != len(roles)):
            raise SpecGapError("Policy contains an invalid actor or role list")


def create_run(path, bundle, policy=None):
    path = safe_path(path)
    if not isinstance(bundle, dict) or not isinstance(bundle.get("repo"), dict):
        raise SpecGapError("Bundle requires repository metadata")
    repo = Path(bundle["repo"]["root"]).resolve()
    if path.is_relative_to(repo):
        raise SpecGapError("Run must be outside the audited repository")
    policy = {"actors": {}} if policy is None else policy
    _validate_policy(policy)
    canonical_hash(bundle)
    if path.exists():
        raise SpecGapError("Run destination already exists; choose a new directory")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.mkdir(mode=0o700)
    except FileExistsError as exc:
        raise SpecGapError("Run destination already exists") from exc
    write_json(path / "bundle.json", _seal(bundle))
    write_json(path / "policy.json", _seal(policy))
    write_json(path / "manifest.json", _seal({
        "schema_version": "1", "bundle_sha256": canonical_hash(bundle),
        "policy_sha256": canonical_hash(policy),
    }))
    write_json(path / "state.json", _seal({"review": None, "events": []}))


def _load(path):
    path = safe_path(path)
    manifest = _unseal(path / "manifest.json")
    bundle = _unseal(path / "bundle.json")
    policy = _unseal(path / "policy.json")
    if (not isinstance(manifest, dict) or set(manifest) != {"schema_version", "bundle_sha256", "policy_sha256"}
            or manifest["schema_version"] != "1"
            or manifest["bundle_sha256"] != canonical_hash(bundle)
            or manifest["policy_sha256"] != canonical_hash(policy)):
        raise SpecGapError("Run manifest does not match its artifacts")
    _validate_policy(policy)
    return bundle, policy


def load_run(path):
    return _load(path)[0]


def load_policy(path):
    return _load(path)[1]


def _state(path):
    _load(path)
    state = _unseal(safe_path(path) / "state.json")
    if not isinstance(state, dict) or set(state) != {"review", "events"} or not isinstance(state["events"], list):
        raise SpecGapError("Invalid run state")
    previous = None
    for index, event in enumerate(state["events"], 1):
        if not isinstance(event, dict):
            raise SpecGapError("Invalid event")
        unhashed = {k: v for k, v in event.items() if k != "hash"}
        if (type(event.get("sequence")) is not int or event["sequence"] != index
                or event.get("previous_hash") != previous or event.get("hash") != canonical_hash(unhashed)):
            raise SpecGapError("Event history integrity check failed")
        previous = event["hash"]
    return state


@contextmanager
def mutation_lock(path):
    lock = safe_path(path) / ".mutation.lock"
    safe_path(lock)
    try:
        with lock.open("x", encoding="utf-8") as stream:
            stream.write(str(os.getpid()))
    except FileExistsError as exc:
        raise SpecGapError("Run is locked; another mutation may be in progress") from exc
    try:
        yield
    finally:
        lock.unlink()


def load_review(path):
    return _state(path)["review"]


def load_events(path):
    return _state(path)["events"]


def save_review(path, review):
    with mutation_lock(path):
        save_review_locked(path, review)


def save_review_locked(path, review):
    """Caller holds mutation_lock across freshness/contract validation and write."""
    state = _state(path)
    if state["review"] is not None:
        raise SpecGapError("Review is immutable; prepare a new run to replace it")
    state["review"] = review
    write_json(safe_path(path) / "state.json", _seal(state))


def append_event(path, event):
    with mutation_lock(path):
        return append_event_locked(path, event)


def append_event_locked(path, event):
    """Caller holds mutation_lock across validation and this write."""
    state = _state(path)
    if not isinstance(event, dict) or {"sequence", "hash", "previous_hash", "created_at"} & set(event):
        raise SpecGapError("Event has invalid or reserved fields")
    events = state["events"]
    result = dict(event, sequence=len(events) + 1, created_at=utc_now(),
                  previous_hash=events[-1]["hash"] if events else None)
    result["hash"] = canonical_hash(result)
    events.append(result)
    write_json(safe_path(path) / "state.json", _seal(state))
    return result
