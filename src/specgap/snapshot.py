"""Freeze requirements plus bounded B/H context without executing repository code."""

import ast
import re
from pathlib import Path, PurePosixPath

from . import __version__
from .errors import SpecGapError
from .gitrepo import GitRepo
from .requirements import parse_requirements
from .util import canonical_hash, physical_lines, read_bytes, sha256, utc_now

TEXT_EXTENSIONS = {".md", ".txt", ".rst", ".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".csv", ".xml"}


def _secret(path):
    for part in PurePosixPath(path).parts:
        name = part.lower()
        if (name.startswith(".env") or name in {".ssh", ".aws", ".npmrc", ".pypirc", "id_rsa", "id_ed25519"}
                or name.endswith((".pem", ".key", ".p12", ".pfx"))
                or re.search(r"(?:^|[._-])(credentials?|secrets?|tokens?)(?:$|[._-])", name)):
            return True
    return False


def _units(text, path, limitations):
    lines = physical_lines(text)
    result = []

    def unit(name, kind, start, end):
        content = "\n".join(lines[start - 1:end])
        return {"id": "SRC-" + canonical_hash([path, name, start, end, content])[:16],
                "name": name, "kind": kind, "start_line": start, "end_line": end,
                "sha256": sha256(content.encode("utf-8"))}

    if path.endswith(".py"):
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError, RecursionError):
            limitations.append(f"Python syntax/AST parse failed: {path}")
        else:
            def visit(node, parents):
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        name = ".".join([*parents, child.name])
                        start = min([child.lineno, *[d.lineno for d in child.decorator_list]])
                        result.append(unit(name, "class" if isinstance(child, ast.ClassDef) else "function",
                                           start, child.end_lineno))
                        visit(child, [*parents, child.name])
                    else:
                        visit(child, parents)
            try:
                visit(tree, [])
            except RecursionError:
                result.clear()  # Never expose a partial symbol index as complete.
                limitations.append(f"Python AST traversal limit; file-level fallback: {path}")
    if not result and lines:
        result.append(unit(path, "file", 1, len(lines)))
    return result


def prepare(repo: Path, requirements: Path, *, head="HEAD", target=None, base=None,
            max_files=100, max_bytes=524288) -> dict:
    if type(max_files) is not int or type(max_bytes) is not int or not (1 <= max_files <= 2000) or not (1 <= max_bytes <= 2097152):
        raise SpecGapError("Budgets must be positive; max_files <=2000 and max_bytes <=2097152")
    git = GitRepo(repo)
    head_sha = git.resolve(head)
    target_sha = git.resolve(target) if target else None
    merge_base = git.merge_base(target_sha, head_sha) if target_sha else None
    base_sha = git.resolve(base) if base else (merge_base or git.resolve(head_sha + "^"))
    raw_requirements = read_bytes(requirements, max_bytes=1048576)
    try:
        text = raw_requirements.decode("utf-8-sig")
    except UnicodeError as exc:
        raise SpecGapError("Requirements must be UTF-8") from exc
    clauses = parse_requirements(text)
    changes = git.changes(base_sha, head_sha)
    head_files = git.files(head_sha)
    base_files = {e["path"]: e for e in git.files(base_sha)}
    changed_heads = {c["new_path"] for c in changes if c["new_path"]}
    changed_bases = {c["old_path"] for c in changes if c["old_path"]}
    pending = [("head", head_sha, e) for e in head_files if e["path"] in changed_heads]
    pending += [("base", base_sha, base_files[p]) for p in sorted(changed_bases) if p in base_files]
    pending += [("head", head_sha, e) for e in head_files if e["path"] not in changed_heads]
    sources, limitations, warnings = [], [], []
    consumed = 0
    for side, commit, entry in pending:
        path = entry["path"]
        label = f"{side}:{path}"
        if entry["mode"] not in {"100644", "100755"}:
            limitations.append(f"Not followed (symlink/submodule/non-regular): {label}")
            continue
        if _secret(path):
            limitations.append(f"Potential secret path excluded: {label}")
            continue
        if len(sources) >= max_files or consumed + entry["size"] > max_bytes:
            limitations.append(f"Context budget omitted: {label}")
            continue
        raw = git.read(commit, path)
        if b"\0" in raw:
            limitations.append(f"Binary source omitted: {label}")
            continue
        try:
            content = raw.decode("utf-8")
        except UnicodeError:
            limitations.append(f"Non-UTF-8 source omitted: {label}")
            continue
        suffix = PurePosixPath(path).suffix.lower()
        if suffix != ".py" and suffix not in TEXT_EXTENSIONS:
            limitations.append(f"Unsupported language; file-level fallback only: {label}")
        consumed += len(raw)
        sources.append({"side": side, "path": path, "sha256": sha256(raw), "content": content,
                        "line_count": len(physical_lines(content)), "language": "python" if suffix == ".py" else "text",
                        "units": _units(content, path, limitations)})
    dirty = git.dirty()
    if dirty is None:
        warnings.append("Worktree status unknown: configured Git clean/process filters prevent safe status checking; uncommitted content is ignored.")
    elif dirty:
        warnings.append("Uncommitted/untracked worktree changes ignored; only committed B/H objects were read.")
    warnings.extend([
        "Static context only: no audited application or tests were executed.",
        "Target integration/merge-result analysis was not performed.",
        "Secret filtering is best-effort: inspect all content before sharing with an agent/provider.",
        "Requirement paragraphs are intake units, not automatically approved semantic clauses.",
    ])
    bundle = {
        "schema_version": "1", "tool_version": __version__,
        "repo": {"root": str(git.root), "head_ref": head, "head_sha": head_sha,
                 "target_ref": target, "target_sha": target_sha, "merge_base_sha": merge_base,
                 "base_ref": base, "base_sha": base_sha},
        "requirements": {"path": str(Path(requirements).resolve()), "sha256": sha256(raw_requirements),
                         "text": text, "clauses": clauses},
        "changes": changes, "sources": sources, "limitations": limitations, "warnings": warnings,
        "budgets": {"max_files": max_files, "max_bytes": max_bytes},
    }
    # Dirty-worktree warnings do not change the frozen committed input identity.
    identity = {k: v for k, v in bundle.items() if k != "warnings"}
    bundle["snapshot_id"] = canonical_hash(identity)
    bundle["created_at"] = utc_now()
    return bundle


def freshness(bundle, repo, requirements) -> list[str]:
    reasons = []
    try:
        git = GitRepo(repo)
        if str(git.root) != bundle["repo"]["root"]:
            reasons.append("Repository location differs from frozen snapshot")
        for label in ("head", "target", "base"):
            ref = bundle["repo"].get(f"{label}_ref")
            if ref and git.resolve(ref) != bundle["repo"][f"{label}_sha"]:
                reasons.append(f"{label} ref moved since snapshot")
    except SpecGapError:
        reasons.append("Repository or tracked ref unavailable; freshness unknown")
    try:
        if sha256(read_bytes(requirements, max_bytes=1048576)) != bundle["requirements"]["sha256"]:
            reasons.append("Requirements content changed since snapshot")
    except SpecGapError:
        reasons.append("Requirements unavailable; freshness unknown")
    return reasons
