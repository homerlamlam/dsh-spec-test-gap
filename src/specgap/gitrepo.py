"""Read committed Git objects only; no checkout, fetch, diff drivers or hooks."""

import os
import re
import subprocess
from pathlib import Path

from .errors import SpecGapError
from .util import canonical_hash


class GitRepo:
    def __init__(self, path):
        self.root = Path(path).resolve()
        self._trees = {}
        if not self.root.is_dir():
            raise SpecGapError("Repository directory does not exist")
        top = self._text("rev-parse", "--show-toplevel").strip()
        if Path(top).resolve() != self.root:
            raise SpecGapError("Use the repository root, not a nested directory")
        promisor = self._run("config", "--get-regexp", r"^(extensions\.partialclone|remote\..*\.promisor)$", allowed=(0, 1))
        if promisor.strip():
            raise SpecGapError("Partial/promisor clones are not supported; provide local full history")

    def _run(self, *args, allowed=(0,)):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1")
        command = ["git", "--no-replace-objects", "-c", "core.fsmonitor=false",
                   "-c", "core.untrackedCache=false", "-c", "core.quotePath=false",
                   "-C", str(self.root), *args]
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                    env=env, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SpecGapError("Git unavailable or command timed out") from exc
        if result.returncode not in allowed:
            raise SpecGapError(f"Git {args[0]} failed (exit {result.returncode}); check refs and local history")
        if len(result.stdout) > 32 * 1024 * 1024:
            raise SpecGapError("Git output exceeds metadata limit")
        return result.stdout

    def _text(self, *args):
        try:
            return self._run(*args).decode("utf-8")
        except UnicodeError as exc:
            raise SpecGapError("Git paths must be UTF-8") from exc

    def resolve(self, ref):
        if not isinstance(ref, str) or not ref or ref.startswith("-") or "\x00" in ref:
            raise SpecGapError("Invalid Git ref")
        sha = self._text("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").strip()
        if not re.fullmatch(r"[0-9a-f]{40,64}", sha):
            raise SpecGapError("Git did not resolve a commit")
        return sha

    def merge_base(self, a, b):
        bases = self._text("merge-base", "--all", self.resolve(a), self.resolve(b)).splitlines()
        if len(bases) != 1:
            raise SpecGapError("No unique merge-base; complete history or choose an explicit base without target")
        return bases[0]

    def files(self, commit):
        commit = self.resolve(commit)
        if commit not in self._trees:
            entries = []
            for record in self._run("ls-tree", "-r", "-z", "--long", "--full-tree", commit).split(b"\0"):
                if not record:
                    continue
                metadata, raw_path = record.split(b"\t", 1)
                mode, kind, oid, size = metadata.decode("ascii").split()
                try:
                    path = raw_path.decode("utf-8")
                except UnicodeError as exc:
                    raise SpecGapError("Git paths must be UTF-8") from exc
                entries.append({"path": path, "mode": mode, "type": kind, "oid": oid,
                                "size": int(size) if size != "-" else 0})
            self._trees[commit] = entries
        return self._trees[commit]

    def read(self, commit, path):
        entry = next((e for e in self.files(commit) if e["path"] == path), None)
        if entry is None or entry["mode"] not in {"100644", "100755"} or entry["type"] != "blob":
            raise SpecGapError("Source is not a regular committed blob")
        if entry["size"] > 16 * 1024 * 1024:
            raise SpecGapError("Source exceeds blob size limit")
        return self._run("cat-file", "blob", entry["oid"])

    def changes(self, base, head):
        parts = self._run("diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M",
                          self.resolve(base), self.resolve(head), "--").split(b"\0")
        changes, i = [], 0
        try:
            while i < len(parts) and parts[i]:
                status = parts[i].decode("ascii")
                path = parts[i + 1].decode("utf-8")
                i += 2
                if status.startswith(("R", "C")):
                    old, new = path, parts[i].decode("utf-8")
                    i += 1
                else:
                    old, new = (None if status == "A" else path), (None if status == "D" else path)
                change = {"status": status, "old_path": old, "new_path": new}
                change["id"] = "CHG-" + canonical_hash(change)[:16]
                changes.append(change)
        except (UnicodeError, IndexError) as exc:
            raise SpecGapError("Unsupported Git change metadata") from exc
        return changes

    def dirty(self):
        # Even read-only status can execute clean/process drivers while hashing
        # touched worktree files. Do not invoke it when such drivers are configured.
        filters = self._run("config", "--name-only", "--get-regexp",
                            r"^filter\..*\.(clean|process)$", allowed=(0, 1))
        if filters:
            return None  # Unknown is safer than executing a repository helper.
        return bool(self._run("status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"))
