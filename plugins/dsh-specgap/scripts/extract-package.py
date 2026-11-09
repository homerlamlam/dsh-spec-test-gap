"""Extract only regular package/ members; compatible with Python 3.11+."""
from pathlib import Path, PurePosixPath
import sys
import tarfile


def extract(archive, destination):
    destination = Path(destination).resolve()
    seen = set()
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        for member in members:
            parts = PurePosixPath(member.name).parts
            if (not parts or parts[0] != 'package' or '..' in parts
                    or '\\' in member.name or ':' in member.name
                    or not (member.isdir() or member.isfile())):
                raise ValueError('Unsafe package member: ' + member.name)
            target = destination.joinpath(*parts)
            if not target.resolve().is_relative_to(destination):
                raise ValueError('Package path escapes extraction root')
            key = str(target).casefold()
            if key in seen or target.exists():
                raise ValueError('Duplicate/existing package member')
            seen.add(key)
        # Validation precedes all writes; no archive-defined links or modes.
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as incoming, target.open('xb') as outgoing:
                    while chunk := incoming.read(1024 * 1024):
                        outgoing.write(chunk)


if __name__ == '__main__':
    extract(*sys.argv[1:])
