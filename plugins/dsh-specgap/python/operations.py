"""Host-only adapters. No provider dispatch and no execution of audited sources.

Paths here are canonical Host inputs, NOT browser authority. Task3 must bind
workspace/run IDs before calling these operations. The extra containment checks
are defense in depth, not an OS sandbox against an actively racing local user.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from uuid import uuid4

from specgap import __version__
from specgap import demo, gitrepo, report, snapshot, store, workflow
from specgap.errors import SpecGapError, StaleRunError, SequenceConflictError
from specgap.provider import SYSTEM_PROMPT
from specgap.requirements import parse_requirements
from specgap.review import review_template
from specgap.util import canonical_hash, read_bytes, safe_path

COMMON = {'workspaceRoot', 'dataRoot', 'runPath'}
ACTIONS = COMMON | {'finding', 'actor', 'attestLocal', 'expectedSequence'}
SCHEMAS = {
    'health': (set(), set()),
    'refs': ({'workspaceRoot', 'repoPath'}, set()),
    'prepare': (COMMON | {'repoPath'}, {'requirementsPath', 'requirementsText', 'head', 'target', 'base', 'maxFiles', 'maxBytes', 'policy'}),
    'read': (COMMON, set()), 'material': (COMMON, set()), 'report': (COMMON, set()),
    'import_review': (COMMON | {'review'}, set()),
    'respond': (ACTIONS | {'text'}, set()),
    'decide': (ACTIONS | {'outcome', 'reason'}, set()),
    'verify': (ACTIONS | {'result', 'evidenceText', 'note'}, set()),
    'demo': ({'workspaceRoot', 'dataRoot', 'demoPath'}, set()),
}


class BridgeError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code='INVALID_INPUT', message='Invalid operation payload.'):
    raise BridgeError(code, message)


def configure_git(executable):
    """Bind the unchanged core's two subprocess seams to an absolute Git file.

    PATH alone is insufficient on Windows (cwd wins before PATH). Core still
    supplies the safe fixed Git arguments, deadlines and output checks.
    """
    executable = str(executable)

    def run(argv, **options):
        if not isinstance(argv, list) or not argv or argv[0] != 'git':
            fail('ENVIRONMENT', 'Unsupported subprocess request.')
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GIT_', 'PYTHON'))}
        env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0', GIT_NO_LAZY_FETCH='1',
                   GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        options.update(env=env, cwd=str(Path(executable).parent), shell=False)
        return subprocess.run([executable, *argv[1:]], **options)

    adapter = SimpleNamespace(run=run, DEVNULL=subprocess.DEVNULL,
                              TimeoutExpired=subprocess.TimeoutExpired, SubprocessError=subprocess.SubprocessError)
    gitrepo.subprocess = adapter
    demo.subprocess = adapter


def _text(value, *, chars=12000, byte_limit=None):
    if not isinstance(value, str) or not value.strip() or '\0' in value or len(value) > chars:
        fail()
    try:
        if byte_limit is not None and len(value.encode('utf-8')) > byte_limit:
            fail()
    except UnicodeError:
        fail()
    return value


def _path(value):
    _text(value, chars=32768)
    path = Path(value)
    if not path.is_absolute():
        fail('FORBIDDEN', 'Only canonical Host paths are accepted.')
    try:
        result = safe_path(path)
    except SpecGapError:
        fail('FORBIDDEN', 'Linked artifact paths are not permitted.')
    # Reject Windows alternate streams/device paths even in owned storage.
    if os.name == 'nt' and (str(path).startswith(('\\\\?\\', '\\\\.\\')) or any(':' in p for p in path.parts[1:])):
        fail('FORBIDDEN', 'Special filesystem paths are not permitted.')
    return result


def _within(root, value, *, allow_root=False):
    result = _path(value)
    if not result.is_relative_to(root) or (not allow_root and result == root):
        fail('FORBIDDEN', 'Path escapes its Host-authorized root.')
    return result


def _roots(payload):
    workspace = _path(payload['workspaceRoot'])
    if not workspace.is_dir():
        fail('NOT_FOUND', 'Workspace directory is unavailable.')
    data = _path(payload['dataRoot'])
    if data.is_relative_to(workspace) or workspace.is_relative_to(data):
        fail('FORBIDDEN', 'Plugin data and audited workspace must be separate.')
    return workspace, data


def _new(path):
    if path.exists():
        fail('CONFLICT', 'Destination already exists; choose a new owned directory.')


def _immutable(directory, name, text):
    safe_path(directory).mkdir(parents=True, exist_ok=True)
    path = safe_path(directory / (name + '-' + uuid4().hex + '.txt'))
    with path.open('xb') as stream:
        stream.write(text.encode('utf-8'))
    return path


def _view(run):
    try:
        bundle, policy, review = store.load_run(run), store.load_policy(run), store.load_review(run)
        events = store.load_events(run)
        # History, action state and token describe this one validated event read.
        return {'bundle': bundle, 'policy': policy, 'review': review, 'events': events,
                'status': workflow.status_from_events(bundle, review, events), 'expectedSequence': len(events)}
    except SpecGapError:
        fail('INTEGRITY', 'Run artifacts cannot be validated.')


def _run(payload):
    workspace, data = _roots(payload)
    run = _within(data, payload['runPath'])
    if not run.is_dir():
        fail('NOT_FOUND', 'Run does not exist.')
    try:
        bundle = store.load_run(run)
    except SpecGapError:
        fail('INTEGRITY', 'Run artifacts cannot be validated.')
    # Demo repositories/requirements are plugin-owned. Other roots must stay in
    # the workspace; Task3 also verifies exact run metadata and workspace owner.
    for value in (bundle['repo']['root'], bundle['requirements']['path']):
        target = _path(value)
        if not (target.is_relative_to(workspace) or target.is_relative_to(data)):
            fail('FORBIDDEN', 'Run source paths escape authorized storage.')
    return run


def _prepare(p):
    workspace, data = _roots(p)
    repo = _within(workspace, p['repoPath'], allow_root=True)
    run = _within(data, p['runPath'])
    _new(run)
    if ('requirementsPath' in p) == ('requirementsText' in p):
        fail()
    for key, default, maximum in [('maxFiles', 100, 2000), ('maxBytes', 524288, 2097152)]:
        if type(p.get(key, default)) is not int or not 1 <= p.get(key, default) <= maximum:
            fail()
    for key in ('head', 'target', 'base'):
        if key in p:
            _text(p[key], chars=4096)
            if p[key].startswith('-'):
                fail()
    policy = p.get('policy', {'actors': {}})
    store._validate_policy(policy)  # Same frozen schema, before any owned write.
    pasted = None
    if 'requirementsText' in p:
        text = _text(p['requirementsText'], chars=1048576, byte_limit=1048576)
        parse_requirements(text)
        pasted = _immutable(data / 'inputs', 'requirements', text)
        requirements = pasted
    else:
        requirements = _within(workspace, p['requirementsPath'])
    try:
        bundle = snapshot.prepare(repo, requirements, head=p.get('head', 'HEAD'), target=p.get('target'), base=p.get('base'),
                                  max_files=p.get('maxFiles', 100), max_bytes=p.get('maxBytes', 524288))
        store.create_run(run, bundle, policy)
    except Exception:
        # Keep any partially persisted run honest; do not delete arbitrary paths.
        if pasted and not run.exists():
            pasted.unlink()
        raise
    return _view(run)


def _dispatch(operation, p):
    if operation == 'health':
        return {'python': sys.version.split()[0], 'coreVersion': __version__, 'isolated': bool(sys.flags.isolated and sys.flags.no_site)}
    if operation == 'refs':
        workspace = _path(p['workspaceRoot'])
        repo = gitrepo.GitRepo(_within(workspace, p['repoPath'], allow_root=True))
        raw = repo._text('for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/', 'refs/remotes/', 'refs/tags/')
        refs = []
        for line in raw.splitlines():
            name, oid = line.split('\0')
            refs.append({'name': name, 'oid': oid})
        return {'head': repo.resolve('HEAD'), 'refs': refs}
    if operation == 'prepare':
        return _prepare(p)
    if operation == 'demo':
        _, data = _roots(p)
        destination = _within(data, p['demoPath'])
        _new(destination)
        result = demo.run_demo(destination)
        return {**result, 'view': _view(Path(result['run']))}

    # Validate action scalars before any artifact write (including evidence).
    if operation in ('respond', 'decide', 'verify'):
        if type(p['expectedSequence']) is not int or p['expectedSequence'] < 0:
            fail()
        _text(p['finding'], chars=120)
        _text(p['actor'], chars=120)
        if p['attestLocal'] is not True:
            fail('FORBIDDEN', 'Explicit local attestation is required.')
        if operation == 'respond':
            _text(p['text'])
        elif operation == 'decide':
            _text(p['reason'])
            if not isinstance(p['outcome'], str) or p['outcome'] not in workflow.DECISION_ROLES:
                fail()
        else:
            _text(p['note'])
            _text(p['evidenceText'], chars=65536, byte_limit=65536)
            if p['result'] not in ('passed', 'failed'):
                fail()
    if operation == 'import_review':
        if not isinstance(p['review'], dict) or len(json.dumps(p['review'], ensure_ascii=False).encode('utf-8')) > 1048576:
            fail('INVALID_REVIEW', 'Review must be a bounded JSON object.')
    run = _run(p)
    if operation in ('respond', 'decide', 'verify'):
        try:
            store.load_policy(run)  # Validate its manifest binding before owned evidence writes.
        except SpecGapError:
            fail('INTEGRITY', 'Frozen local policy cannot be validated.')
    if operation == 'read':
        return _view(run)
    if operation == 'material':
        bundle = store.load_run(run)
        outbound = copy.deepcopy(bundle)
        outbound['repo'].pop('root')
        outbound['requirements'].pop('path')
        template = review_template(bundle)
        user = json.dumps({'bundle': outbound, 'template': template}, ensure_ascii=False)
        exact = {'system': SYSTEM_PROMPT, 'user': user}
        size = len(SYSTEM_PROMPT.encode('utf-8')) + len(user.encode('utf-8'))
        if size > 8 * 1024 * 1024:
            fail('INVALID_INPUT', 'Frozen model input exceeds 8 MiB.')
        return {**exact, 'template': template, 'hash': canonical_hash(exact), 'bytes': size}
    if operation == 'report':
        view = _view(run)
        return {'markdown': report.render_report(view['bundle'], view['review'], view['events'], stale=view['status']['stale_reasons'])}
    if operation == 'import_review':
        return workflow.import_review(run, p['review'])
    if operation == 'respond':
        return workflow.record_response(run, p['finding'], p['actor'], p['text'], attest_local=True, expected_sequence=p['expectedSequence'])
    if operation == 'decide':
        return workflow.record_decision(run, p['finding'], p['actor'], p['outcome'], p['reason'], attest_local=True, expected_sequence=p['expectedSequence'])
    if operation == 'verify':
        evidence = _immutable(run / 'inputs', 'verification', p['evidenceText'])
        try:
            return workflow.record_verification(run, p['finding'], p['actor'], p['result'], evidence, p['note'], attest_local=True, expected_sequence=p['expectedSequence'])
        except Exception:
            evidence.unlink()  # Only this invocation's newly created input.
            raise
    fail()


def dispatch(operation, payload):
    if not isinstance(operation, str) or operation not in SCHEMAS or not isinstance(payload, dict):
        fail()
    required, optional = SCHEMAS[operation]
    if not required <= payload.keys() or not payload.keys() <= required | optional:
        fail()
    try:
        return _dispatch(operation, payload)
    except BridgeError:
        raise
    except SequenceConflictError:
        fail('CONFLICT', 'Event history changed; refresh the run before acting.')
    except StaleRunError:
        fail('STALE', 'Run is stale; prepare a new snapshot.')
    except SpecGapError as exc:
        message = str(exc)
        # Classify only known core messages; never return their path/material text.
        if message.startswith(('Run is locked', 'Review is immutable', 'Run destination already exists', 'Passed verification requires')):
            fail('CONFLICT', 'Run mutation conflicts with its current state.')
        if message.startswith(('Actor is not allowed', 'Explicit local attestation')):
            fail('FORBIDDEN', 'Frozen local policy does not permit this action.')
        if message.startswith(('Git unavailable', 'Demo Git setup failed')):
            fail('ENVIRONMENT', 'Trusted Git is unavailable or timed out.')
        fail('INVALID_REVIEW' if operation == 'import_review' else 'INVALID_INPUT', 'Core validation rejected the operation.')
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
        fail('INVALID_INPUT', 'Operation inputs or local artifacts are unavailable or invalid.')
