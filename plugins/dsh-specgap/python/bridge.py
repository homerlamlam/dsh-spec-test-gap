"""One isolated, bounded JSON exchange. The Host owns executable/path authority."""
import json
import os
from pathlib import Path
import stat
import sys

MAX_REQUEST = 8 * 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024
_job = None  # Windows kill-on-close handle; kept until OS process teardown.


def _error(code, message):
    return {'version': 1, 'ok': False, 'error': {'code': code, 'message': message}}


def _regular(path):
    for part in (path, *path.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Untrusted installed path')
    return path


def _own_windows_tree():
    """Fail closed before Git if a kill-on-close job cannot own this process.

    Unlike a late taskkill lookup, the job also kills descendants when this
    interpreter exits unexpectedly. No breakaway flag or inheritable job handle.
    """
    global _job
    if os.name != 'nt':
        return
    import ctypes
    from ctypes import wintypes as w

    class Basic(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                    ('flags', w.DWORD), ('min_ws', ctypes.c_size_t), ('max_ws', ctypes.c_size_t),
                    ('active', w.DWORD), ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]

    class Extended(ctypes.Structure):
        _fields_ = [('basic', Basic), ('io', IO), ('process_memory', ctypes.c_size_t),
                    ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]

    dll = ctypes.WinDLL('kernel32.dll', use_last_error=True)  # Windows KnownDLL, not PATH search.
    dll.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
    dll.CreateJobObjectW.restype = w.HANDLE
    dll.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
    dll.SetInformationJobObject.restype = w.BOOL
    dll.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    dll.AssignProcessToJobObject.restype = w.BOOL
    dll.GetCurrentProcess.restype = w.HANDLE
    dll.CloseHandle.argtypes = [w.HANDLE]
    handle = dll.CreateJobObjectW(None, None)
    limits = Extended()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not handle:
        raise OSError('Cannot own process tree')
    if not dll.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not dll.AssignProcessToJobObject(handle, dll.GetCurrentProcess()):
        dll.CloseHandle(handle)
        raise OSError('Cannot own process tree')
    _job = handle


def main():
    if not sys.flags.isolated or not sys.flags.no_site or sys.version_info < (3, 11):
        return _error('ENVIRONMENT', 'Python 3.11+ with -I -S is required.')
    try:
        root = _regular(Path(__file__).absolute()).parent
        _regular(root / 'operations.py')
        _regular(root / 'specgap' / '__init__.py')
        for directory, dirs, files in os.walk(root / 'specgap', followlinks=False):
            for name in [*dirs, *files]:
                _regular(Path(directory) / name)
        if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
            raise ValueError('Missing trusted Git executable')
        git = _regular(Path(sys.argv[1]))
        if not git.is_file():
            raise ValueError('Missing Git executable')
        _own_windows_tree()
    except (OSError, ValueError):
        return _error('ENVIRONMENT', 'Trusted installed core, Git and process ownership are required.')

    # -I -S removed cwd, PYTHONPATH and site hooks. Never fall back to src/ or repo.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(root))
    try:
        from specgap.errors import SpecGapError
        from specgap.util import strict_loads, canonical_hash
        from operations import BridgeError, configure_git, dispatch
    except Exception:
        return _error('ENVIRONMENT', 'Installed Python core is unavailable.')
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise ValueError('Request limit')
        request = strict_loads(raw.decode('utf-8'))
        canonical_hash(request)  # Reject lone surrogates/deep or unsupported data.
        if (not isinstance(request, dict) or set(request) != {'version', 'operation', 'payload'}
                or type(request['version']) is not int or request['version'] != 1):
            raise ValueError('Invalid envelope')
    except (SpecGapError, ValueError, UnicodeError, RecursionError):
        return _error('INVALID_INPUT', 'Expected one bounded UTF-8 version 1 JSON request.')
    try:
        configure_git(git)
        return {'version': 1, 'ok': True, 'data': dispatch(request['operation'], request['payload'])}
    except BridgeError as exc:
        return _error(exc.code, str(exc))
    except Exception:
        # No tracebacks, subprocess output, paths, source or provider material.
        return _error('INTERNAL', 'Bridge operation failed.')


if __name__ == '__main__':
    try:
        response = json.dumps(main(), ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        if len(response) + 1 > MAX_RESPONSE:
            response = json.dumps(_error('ENVIRONMENT', 'Bridge response exceeds output limit.')).encode('utf-8')
        sys.stdout.buffer.write(response + b'\n')
        sys.stdout.buffer.flush()
    except BrokenPipeError:
        os._exit(1)
