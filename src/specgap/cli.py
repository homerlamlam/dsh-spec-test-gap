"""CLI orchestration; successful execution is never release approval."""

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from .errors import ProviderError, SpecGapError, StaleRunError
from .provider import request_review
from .report import render_report
from .review import review_template
from .snapshot import prepare
from .store import create_run, load_events, load_review, load_run
from .util import read_json, safe_path
from .workflow import (DECISION_ROLES, import_review, record_decision, record_response,
                       record_verification, require_fresh, status)


def _parser():
    parser = argparse.ArgumentParser(prog="specgap", description="Evidence-backed QA reconciliation, not a release gate.")
    parser.add_argument("--version", action="version", version=f"specgap {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("prepare", help="Freeze independent requirements and committed Git evidence offline")
    command.add_argument("--repo", required=True, type=Path)
    command.add_argument("--requirements", required=True, type=Path)
    command.add_argument("--head", default="HEAD")
    command.add_argument("--target", help="Target ref; default baseline is merge-base(target, head)")
    command.add_argument("--base", help="Explicit baseline; overrides merge-base/HEAD parent")
    command.add_argument("--out", required=True, type=Path, help="NEW run directory outside audited repo")
    command.add_argument("--policy", type=Path, help="Local actor-role policy JSON; not identity authentication")
    command.add_argument("--max-files", type=int, default=100)
    command.add_argument("--max-bytes", type=int, default=524288)
    for name, help_text in [("template", "Export an intentionally unassessed agent review scaffold"),
                            ("import-review", "Validate and save one immutable semantic review"),
                            ("analyze", "Explicitly send frozen content to an OpenAI-compatible provider"),
                            ("report", "Render a historical review report"), ("status", "Read completeness, freshness and separate finding axes"),
                            ("respond", "Record an answer, not approval"), ("decide", "Record a role-bound local decision"),
                            ("verify", "Attach human-supplied verification evidence, not execute tests")]:
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--run", type=Path, required=True)
        if name in {"template", "report"}:
            command.add_argument("--out", type=Path, help="New file outside audited repo; default stdout")
        if name == "import-review":
            command.add_argument("--review", type=Path, required=True)
        if name == "analyze":
            command.add_argument("--endpoint", required=True, help="Full chat/completions URL; HTTPS except loopback")
            command.add_argument("--model", required=True)
            command.add_argument("--api-key-env", default="SPECGAP_API_KEY")
            command.add_argument("--allow-network", action="store_true", help="Consent to send frozen source and requirements")
            command.add_argument("--timeout", type=float, default=60)
        if name in {"respond", "decide", "verify"}:
            command.add_argument("--finding", required=True)
            command.add_argument("--actor", required=True)
            command.add_argument("--attest-local", action="store_true")
        if name == "respond":
            command.add_argument("--text", required=True)
        if name == "decide":
            command.add_argument("--outcome", required=True, choices=sorted(DECISION_ROLES))
            command.add_argument("--reason", required=True)
        if name == "verify":
            command.add_argument("--result", required=True, choices=["passed", "failed"])
            command.add_argument("--evidence", required=True, type=Path)
            command.add_argument("--note", required=True)
    command = commands.add_parser("demo", help="Build a synthetic Git fixture and scripted review, no model calls")
    command.add_argument("--out", type=Path, required=True, help="NEW directory for disposable demo material")
    return parser


def _json(data):
    return json.dumps(data, indent=2, ensure_ascii=True, allow_nan=False) + "\n"


def _export(destination, text, bundle):
    if destination is None:
        sys.stdout.write(text)
        return
    destination = safe_path(destination)
    if destination.is_relative_to(Path(bundle["repo"]["root"]).resolve()):
        raise SpecGapError("Output must be outside the audited repository")
    # Exclusive creation: never overwrite source, imported reviews, artifacts or unrelated files.
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
    except FileExistsError as exc:
        raise SpecGapError("Output already exists; choose a new file") from exc
    sys.stdout.write(_json({"written": str(destination)}))


def _run(args):
    if args.command == "prepare":
        policy = read_json(args.policy) if args.policy else None
        bundle = prepare(args.repo, args.requirements, head=args.head, target=args.target, base=args.base,
                         max_files=args.max_files, max_bytes=args.max_bytes)
        create_run(args.out, bundle, policy)
        return {"run": str(args.out.resolve()), "snapshot_id": bundle["snapshot_id"],
                "review_state": "needs_review", "limitations": bundle["limitations"], "warnings": bundle["warnings"]}
    if args.command == "demo":
        from .demo import run_demo
        return run_demo(args.out)
    if args.command == "status":
        return status(args.run)
    if args.command == "template":
        bundle = load_run(args.run)
        _export(args.out, _json(review_template(bundle)), bundle)
        return None
    if args.command == "import-review":
        review = import_review(args.run, read_json(args.review, max_bytes=1048576))
        return {"imported": True, "snapshot_id": review["snapshot_id"], "finding_count": len(review["findings"])}
    if args.command == "analyze":
        bundle = load_run(args.run)
        require_fresh(bundle)
        if load_review(args.run) is not None:
            raise SpecGapError("Review already exists; create a new run before requesting another")
        if not args.allow_network:
            raise ProviderError("Network disabled; inspect frozen material before using --allow-network")
        review = request_review(bundle, endpoint=args.endpoint, model=args.model,
                                api_key=os.environ.get(args.api_key_env, ""),
                                allow_network=True, timeout=args.timeout)
        import_review(args.run, review)  # Re-check freshness after the network call.
        return {"imported": True, "snapshot_id": bundle["snapshot_id"], "finding_count": len(review["findings"])}
    if args.command == "report":
        current = status(args.run)
        bundle = load_run(args.run)
        text = render_report(bundle, load_review(args.run), load_events(args.run), current["stale_reasons"])
        _export(args.out, text, bundle)
        return None
    common = (args.run, args.finding, args.actor)
    if args.command == "respond":
        event = record_response(*common, args.text, attest_local=args.attest_local)
    elif args.command == "decide":
        event = record_decision(*common, args.outcome, args.reason, attest_local=args.attest_local)
    else:
        event = record_verification(*common, args.result, args.evidence, args.note, attest_local=args.attest_local)
    return {"recorded": event["kind"], "sequence": event["sequence"], "assurance": event["assurance"]}


def main(argv=None):
    try:
        args = _parser().parse_args(argv)
        result = _run(args)
        if result is not None:
            sys.stdout.write(_json(result))
        return 0
    except SystemExit as exc:
        return int(exc.code or 0)
    except ProviderError as exc:
        print(f"specgap: {exc}", file=sys.stderr)
        return 4
    except StaleRunError as exc:
        print(f"specgap: {exc}", file=sys.stderr)
        return 3
    except SpecGapError as exc:
        print(f"specgap: {exc}", file=sys.stderr)
        return 2
    except (OSError, UnicodeError):
        print("specgap: Local file/encoding operation failed; check paths and permissions", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("specgap: Interrupted", file=sys.stderr)
        return 130
