"""Hand-written semantic fixture: not evidence of model quality."""


def bundle_fixture():
    return {
        'schema_version': '1', 'snapshot_id': 'snapshot-fixture', 'created_at': '2026-11-06T00:00:00Z',
        'repo': {'root': '/fixture', 'base_sha': 'a' * 40, 'head_sha': 'b' * 40, 'target_sha': None, 'merge_base_sha': None},
        'requirements': {'path': '/requirements.md', 'sha256': 'req-hash', 'text': '[REQ-1] Retry at most 3 times.\n[REQ-2] Nonempty name.', 'clauses': [
            {'id': 'REQ-1', 'text': '[REQ-1] Retry at most 3 times.', 'start_line': 1, 'end_line': 1},
            {'id': 'REQ-2', 'text': '[REQ-2] Nonempty name.', 'start_line': 2, 'end_line': 2}]},
        'changes': [{'id': 'CHG-1', 'status': 'M', 'old_path': 'app.py', 'new_path': 'app.py'}],
        'sources': [
            {'side': 'base', 'path': 'app.py', 'content': 'def attempts():\n    return 3\n', 'line_count': 2},
            {'side': 'head', 'path': 'app.py', 'content': 'def attempts():\n    return 5\n', 'line_count': 2},
            {'side': 'head', 'path': 'helpers.py', 'content': 'def valid(name):\n    return bool(name)\n', 'line_count': 2}],
        'limitations': [], 'warnings': ['Static evidence only; tests not executed.'],
    }


def citation(side='head', path='app.py', quote='    return 5'):
    return {'side': side, 'path': path, 'start_line': 2, 'end_line': 2, 'quote': quote}


def review_fixture(bundle=None):
    bundle = bundle_fixture() if bundle is None else bundle
    old = citation('base', quote='    return 3')
    new = citation()
    return {'schema_version': '1', 'snapshot_id': bundle['snapshot_id'],
            'requirements': [
                {'id': 'REQ-1', 'assessment': 'contradicted', 'reason': 'Changed limit exceeds 3.', 'evidence': [new]},
                {'id': 'REQ-2', 'assessment': 'supported', 'reason': 'Unchanged helper checks emptiness; call reachability needs human confirmation.',
                 'evidence': [citation(path='helpers.py', quote='    return bool(name)')]}],
            'changes': [{'id': bundle['changes'][0]['id'], 'assessment': 'behavior_changed', 'summary': 'Retry limit 3 to 5.',
                         'requirement_ids': ['REQ-1'], 'evidence': [old, new]}],
            'findings': [{'id': 'F-1', 'kind': 'contradiction', 'title': 'Retry limit differs',
                          'description': 'Static candidate: 5 instead of at most 3; confirm the actual call path.',
                          'severity': 'medium', 'requirement_ids': ['REQ-1'], 'change_ids': [bundle['changes'][0]['id']],
                          'evidence': [new], 'question': 'Is increasing the limit intended and authorized?',
                          'suggested_role': 'product', 'test_ideas': ['Count retry attempts on repeated failure.']}]}
