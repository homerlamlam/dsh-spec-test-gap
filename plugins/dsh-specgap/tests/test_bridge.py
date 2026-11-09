"""Offline integration of the shipped entrypoint, never audited application code."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = Path(__file__).resolve().parents[1]
ENTRY = PLUGIN / 'python' / 'bridge.py'
GIT = Path(shutil.which('git') or '')
# Only the test runner uses source core, as the unchanged baseline comparator.
sys.path.insert(0, str(ROOT / 'src'))
sys.path.insert(0, str(ROOT))
from specgap.snapshot import prepare as core_prepare
from specgap.provider import SYSTEM_PROMPT
from specgap.review import review_template
from tests.helpers import GitFixture
from tests.review_fixture import review_fixture


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(ENTRY.is_file(), 'Task2 Python bridge entrypoint is not implemented')
        self.fx = GitFixture(self)
        self.data = self.fx.root / 'owned 数据 & literal'
        self.workspace = self.fx.root / 'workspace'
        self.workspace.mkdir()
        # GitFixture repo/requirements share a dedicated authorized workspace.
        shutil.move(str(self.fx.repo), self.workspace / 'repo 中文 & space')
        self.fx.repo = self.workspace / 'repo 中文 & space'
        shutil.move(str(self.fx.req), self.workspace / 'requirements.md')
        self.fx.req = self.workspace / 'requirements.md'
        self.run = self.data / 'runs' / 'first'
        self.common = dict(workspaceRoot=str(self.workspace), dataRoot=str(self.data), runPath=str(self.run))
        self.policy = {'actors': {'dev': ['developer'], 'pm': ['product'], 'qa': ['qa'], 'sec': ['security']}}

    def raw(self, raw, *, entry=ENTRY, env=None, isolated=True):
        result = subprocess.run([sys.executable, *(['-I', '-S'] if isolated else []), str(entry), str(GIT)],
                                input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=PLUGIN, env=env, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(result.stderr, b'')
        response = json.loads(result.stdout.decode('utf-8'))
        self.assertEqual(response['version'], 1)
        self.assertEqual(set(response), {'version', 'ok', 'data' if response['ok'] else 'error'})
        return response

    def call(self, op, payload, code=None):
        response = self.raw(json.dumps(dict(version=1, operation=op, payload=payload), ensure_ascii=False).encode())
        if code:
            self.assertFalse(response['ok'], response)
            self.assertEqual(response['error']['code'], code, response)
            return response['error']
        self.assertTrue(response['ok'], response)
        return response['data']

    def prepare(self, **changes):
        payload = dict(self.common, repoPath=str(self.fx.repo), requirementsPath=str(self.fx.req), policy=self.policy)
        payload.update(changes)
        return self.call('prepare', payload)

    def test_refs_prepare_read_preserve_core_snapshot_and_dirty_files(self):
        refs = self.call('refs', dict(workspaceRoot=str(self.workspace), repoPath=str(self.fx.repo)))
        self.assertEqual(refs['head'], self.fx.head)
        self.assertIn('refs/heads/main', [r['name'] for r in refs['refs']])
        # Make status policy deterministic even when host Git has system LFS
        # filters (the bridge intentionally disables system/global configuration).
        self.fx.git('config', 'filter.specgap-test.clean', 'must-not-execute')
        self.fx.put('app.py', 'uncommitted = True\n')
        before = (self.fx.repo / 'app.py').read_bytes()
        expected = core_prepare(self.fx.repo, self.fx.req)
        view = self.prepare()
        self.assertEqual(view['bundle']['snapshot_id'], expected['snapshot_id'])
        for key in expected:
            if key != 'created_at':
                self.assertEqual(view['bundle'][key], expected[key], key)
        self.assertEqual(view, self.call('read', self.common))
        self.assertEqual(view['status']['review_state'], 'needs_review')
        self.assertFalse(view['status']['release_approval'])
        self.assertEqual((self.fx.repo / 'app.py').read_bytes(), before)

    def test_pasted_requirements_are_immutable_owned_inputs(self):
        payload = dict(self.common, repoPath=str(self.fx.repo), requirementsText='[REQ-X] 永远不执行源代码。')
        view = self.call('prepare', payload)
        stored = Path(view['bundle']['requirements']['path'])
        self.assertTrue(stored.is_relative_to(self.data))
        self.assertEqual(stored.read_text(encoding='utf-8'), payload['requirementsText'])
        self.call('prepare', payload, 'CONFLICT')
        self.assertEqual(stored.read_text(encoding='utf-8'), payload['requirementsText'])

    def test_material_exact_prompt_template_hash_and_no_absolute_metadata(self):
        view = self.prepare()
        material = self.call('material', self.common)
        self.assertEqual(material['system'], SYSTEM_PROMPT)
        self.assertEqual(material['template'], review_template(view['bundle']))
        outbound = copy.deepcopy(view['bundle'])
        del outbound['repo']['root']
        del outbound['requirements']['path']
        self.assertEqual(json.loads(material['user']), {'bundle': outbound, 'template': material['template']})
        exact = json.dumps({'system': material['system'], 'user': material['user']}, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        self.assertEqual(material['hash'], hashlib.sha256(exact).hexdigest())
        self.assertEqual(material['bytes'], len(material['system'].encode()) + len(material['user'].encode()))
        self.assertNotIn(str(self.workspace), material['user'])

    def test_no_diff_no_evidence_zero_findings_and_report_are_not_approval(self):
        view = self.prepare(base=self.fx.head)
        review = review_template(view['bundle'])
        for item in review['requirements']:
            item.update(assessment='no_evidence', reason='No evidence in bounded captured scope.')
        self.call('import_review', dict(self.common, review=review))
        current = self.call('read', self.common)
        self.assertEqual(current['review']['findings'], [])
        self.assertEqual(current['bundle']['changes'], [])
        self.assertFalse(current['status']['release_approval'])
        self.assertIn('这不代表正确性保证', self.call('report', self.common)['markdown'])

    def test_human_actions_keep_axes_and_evidence_and_reject_stale(self):
        view = self.prepare()
        self.call('import_review', dict(self.common, review=review_fixture(view['bundle'])))
        action = dict(self.common, finding='F-1', actor='dev', attestLocal=True, expectedSequence=0)
        self.call('respond', dict(action, text='Intentional, not approved.'))
        reply = self.call('read', self.common)
        self.assertEqual(reply['expectedSequence'], 1)
        self.assertEqual(reply['status']['findings']['F-1']['disposition'], 'undecided')
        self.assertEqual(reply['status']['findings']['F-1']['verification'], 'unverified')
        self.assertFalse(reply['status']['release_approval'])
        action['expectedSequence'] = 1
        self.call('decide', dict(action, outcome='approve_intent_change', reason='Not authorized'), 'FORBIDDEN')
        self.call('verify', dict(action, actor='qa', result='passed', evidenceText='observed', note='manual'), 'CONFLICT')
        self.call('decide', dict(action, actor='qa', outcome='confirm_defect', reason='Evidence reviewed'))
        action['expectedSequence'] = 2
        event = self.call('verify', dict(action, actor='qa', result='passed', evidenceText='人类观察', note='manual'))
        self.assertEqual(event['evidence_content'], '人类观察')
        self.assertEqual(event['decision_sequence'], 2)
        self.assertEqual(len(list((self.run / 'inputs').glob('verification-*.txt'))), 1)
        status = self.call('read', self.common)['status']
        self.assertEqual(status['findings']['F-1']['intent'], 'unconfirmed')
        self.assertEqual(status['findings']['F-1']['verification'], 'passed')
        self.assertFalse(status['release_approval'])
        self.assertEqual(status['assurance'], 'local_attestation_only')
        action['expectedSequence'] = 3
        self.call('decide', dict(action, actor='pm', outcome='approve_intent_change', reason='New intent decision'))
        view = self.call('read', self.common)
        self.assertEqual([e['sequence'] for e in view['events']], [1, 2, 3, 4])
        self.assertEqual(view['events'][2]['decision_sequence'], 2)
        self.assertEqual(view['expectedSequence'], 4)
        self.assertEqual(view['status']['findings']['F-1']['verification'], 'unverified')
        self.assertFalse(view['status']['release_approval'])
        self.assertTrue(all(e['assurance'] == 'local_attestation' for e in view['events']))
        error = self.call('verify', dict(action, actor='qa', result='passed', evidenceText='old view', note='manual'), 'CONFLICT')
        self.assertIn('refresh', error['message'].lower())
        self.assertEqual(len(list((self.run / 'inputs').glob('verification-*.txt'))), 1)
        action['expectedSequence'] = 4
        self.fx.put('app.py', 'changed = True\n')
        self.fx.commit('move head')
        self.call('respond', dict(action, text='stale'), 'STALE')
        self.assertTrue(self.call('read', self.common)['status']['stale'])

    def test_invalid_review_is_not_persisted_or_exposed_in_error(self):
        view = self.prepare()
        review = review_fixture(view['bundle'])
        review['requirements'][0]['evidence'][0]['quote'] = 'PRIVATE_INVALID_CODE'
        error = self.call('import_review', dict(self.common, review=review), 'INVALID_REVIEW')
        self.assertNotIn('PRIVATE_INVALID_CODE', error['message'])
        self.assertIsNone(self.call('read', self.common)['review'])
        self.call('import_review', dict(self.common, review=review_fixture(view['bundle'])))
        self.call('import_review', dict(self.common, review=review_fixture(view['bundle'])), 'CONFLICT')

    def test_strict_protocol_and_unsupported_fields_fail_closed(self):
        valid = dict(version=1, operation='health', payload={})
        for value in [dict(valid, version=True), dict(valid, version=2), dict(valid, operation='exec'),
                      dict(valid, command='x'), dict(valid, payload={'pythonPath': str(sys.executable)}),
                      dict(valid, payload=[]), [], None]:
            with self.subTest(value=value):
                response = self.raw(json.dumps(value).encode())
                self.assertEqual(response['error']['code'], 'INVALID_INPUT')
        for raw in [b'', b'{}{}', b'NaN', b'1e999', b'\xff',
                    b'{"version":1,"version":1,"operation":"health","payload":{}}',
                    b'{"version":1,"operation":"health","payload":{"x":1,"x":2}}', b' ' * (8 * 1024 * 1024 + 1)]:
            with self.subTest(size=len(raw)):
                self.assertEqual(self.raw(raw)['error']['code'], 'INVALID_INPUT')

    def test_empty_oversized_and_boolean_limits_do_not_create_runs(self):
        base = dict(self.common, repoPath=str(self.fx.repo), requirementsText='[REQ-A] requirement')
        for changes in [{'maxFiles': True}, {'maxFiles': 2001}, {'maxBytes': True}, {'maxBytes': 2097153},
                        {'requirementsText': ''}, {'requirementsText': '中' * 349526}, {'unknown': True},
                        {'requirementsPath': str(self.fx.req)}, {'policy': {'actors': {'a': ['admin']}}}]:
            with self.subTest(changes=list(changes)):
                self.call('prepare', dict(base, **changes), 'INVALID_INPUT')
                self.assertFalse(self.run.exists())

    def test_paths_refuse_escape_existing_run_and_junctions(self):
        base = dict(self.common, repoPath=str(self.fx.repo), requirementsPath=str(self.fx.req))
        self.call('prepare', dict(base, runPath=str(self.fx.repo / 'output')), 'FORBIDDEN')
        self.call('prepare', dict(base, requirementsPath=str(self.fx.root / 'outside.txt')), 'FORBIDDEN')
        self.prepare()
        self.call('prepare', base, 'CONFLICT')
        link = self.data / 'linked-run'
        if os.name == 'nt':
            # Junction creation does not need symlink privilege.
            import _winapi
            _winapi.CreateJunction(str(self.run), str(link))
        else:
            link.symlink_to(self.run, target_is_directory=True)
        self.addCleanup(lambda: link.rmdir() if os.name == 'nt' else link.unlink())
        self.call('read', dict(self.common, runPath=str(link)), 'FORBIDDEN')

    def test_audited_modules_and_python_environment_hooks_never_import(self):
        marker = self.fx.root / 'EXECUTED'
        code = f'from pathlib import Path\nPath({str(marker)!r}).write_text("bad")\n'
        for name in ['sitecustomize.py', 'usercustomize.py', 'json.py', 'subprocess.py']:
            self.fx.put(name, code)
        self.fx.put('specgap/__init__.py', code)
        self.fx.commit('inert import traps')
        env = dict(os.environ, PYTHONPATH=str(self.fx.repo), PYTHONHOME=str(self.fx.repo), PYTHONSTARTUP=str(self.fx.repo / 'sitecustomize.py'))
        raw = json.dumps(dict(version=1, operation='prepare', payload=dict(self.common, repoPath=str(self.fx.repo), requirementsPath=str(self.fx.req)))).encode()
        self.assertTrue(self.raw(raw, env=env)['ok'])
        self.assertFalse(marker.exists())

    def test_entry_requires_isolated_start_and_trusted_default_core_directory(self):
        raw = b'{"version":1,"operation":"health","payload":{}}'
        self.assertEqual(self.raw(raw, isolated=False)['error']['code'], 'ENVIRONMENT')
        clone = self.fx.root / 'incomplete-plugin'
        clone.mkdir()
        shutil.copyfile(ENTRY, clone / 'bridge.py')
        self.assertEqual(self.raw(raw, entry=clone / 'bridge.py')['error']['code'], 'ENVIRONMENT')
        shutil.copyfile(PLUGIN / 'python' / 'operations.py', clone / 'operations.py')
        core = clone / 'specgap'
        if os.name == 'nt':
            import _winapi
            _winapi.CreateJunction(str(PLUGIN / 'python' / 'specgap'), str(core))
        else:
            core.symlink_to(PLUGIN / 'python' / 'specgap', target_is_directory=True)
        self.addCleanup(lambda: core.rmdir() if os.name == 'nt' else core.unlink())
        self.assertEqual(self.raw(raw, entry=clone / 'bridge.py')['error']['code'], 'ENVIRONMENT')

    def test_corrupt_installed_adapter_errors_are_sanitized(self):
        clone = self.fx.root / 'corrupt-plugin'
        shutil.copytree(PLUGIN / 'python', clone)
        (clone / 'operations.py').write_text('raise RuntimeError("PRIVATE_INSTALLED_CONTENT")\n', encoding='utf-8')
        response = self.raw(b'{"version":1,"operation":"health","payload":{}}', entry=clone / 'bridge.py')
        self.assertEqual(response['error']['code'], 'ENVIRONMENT')
        self.assertNotIn('PRIVATE_INSTALLED_CONTENT', response['error']['message'])

    def test_partial_and_dirty_context_are_not_hidden(self):
        self.fx.put('app.py', 'uncommitted = True\n')
        view = self.prepare(maxFiles=1)
        self.assertTrue(view['bundle']['limitations'])
        self.assertTrue(any('Uncommitted/untracked' in warning for warning in view['bundle']['warnings']))
        review = review_template(view['bundle'])
        for item in review['requirements']:
            item.update(assessment='no_evidence', reason='Bounded scope only.')
        for item in review['changes']:
            item.update(assessment='unknown', summary='Insufficient context.')
        self.call('import_review', dict(self.common, review=review))
        status = self.call('read', self.common)['status']
        self.assertEqual(status['review_state'], 'partial')
        self.assertFalse(status['release_approval'])

    def test_evidence_limits_and_invalid_types_never_retain_inputs(self):
        view = self.prepare()
        self.call('import_review', dict(self.common, review=review_fixture(view['bundle'])))
        action = dict(self.common, finding='F-1', actor='qa', attestLocal=True, expectedSequence=0, result='failed', evidenceText='observed', note='manual')
        for changes, code in [({'evidenceText': '中' * 21846}, 'INVALID_INPUT'), ({'evidenceText': ''}, 'INVALID_INPUT'),
                              ({'note': 'x' * 12001}, 'INVALID_INPUT'), ({'result': True}, 'INVALID_INPUT'),
                              ({'attestLocal': 1}, 'FORBIDDEN'), ({'actor': ['qa']}, 'INVALID_INPUT')]:
            with self.subTest(changes=list(changes)):
                self.call('verify', dict(action, **changes), code)
                self.assertFalse((self.run / 'inputs').exists())
        self.assertEqual(self.call('read', self.common)['status']['event_count'], 0)

    def actions(self):
        common = dict(self.common, finding='F-1', actor='qa', attestLocal=True, expectedSequence=0)
        return [('respond', dict(common, text='Human reply')),
                ('decide', dict(common, outcome='confirm_defect', reason='Reviewed')),
                ('verify', dict(common, result='failed', evidenceText='Observed', note='manual'))]

    def reviewed(self):
        view = self.prepare()
        self.call('import_review', dict(self.common, review=review_fixture(view['bundle'])))

    def test_all_human_routes_require_strict_sequence_before_any_evidence_write(self):
        self.reviewed()
        before = (self.run / 'state.json').read_bytes()
        for op, action in self.actions():
            missing = dict(action)
            del missing['expectedSequence']
            self.call(op, missing, 'INVALID_INPUT')
            for value in (None, True, False, -1, 0.0, '0'):
                with self.subTest(op=op, value=value):
                    self.call(op, dict(action, expectedSequence=value), 'INVALID_INPUT')
                    self.assertEqual((self.run / 'state.json').read_bytes(), before)
                    self.assertFalse((self.run / 'inputs').exists())

    def test_human_authorization_and_content_fail_without_appending(self):
        self.reviewed()
        before = (self.run / 'state.json').read_bytes()
        for op, action in self.actions():
            missing = dict(action)
            del missing['attestLocal']
            self.call(op, missing, 'INVALID_INPUT')
            for changes, code in [({'attestLocal': False}, 'FORBIDDEN'), ({'attestLocal': 1}, 'FORBIDDEN'),
                                  ({'actor': 'unknown'}, 'FORBIDDEN'), ({'finding': 'F-unknown'}, 'INVALID_INPUT')]:
                self.call(op, dict(action, **changes), code)
            if op != 'respond':
                self.call(op, dict(action, actor='dev'), 'FORBIDDEN')
            else:
                self.call(op, dict(action, text='   '), 'INVALID_INPUT')
            self.assertEqual((self.run / 'state.json').read_bytes(), before)
        self.assertEqual(list((self.run / 'inputs').glob('*')), [])

    def test_all_actions_reject_git_stale_and_manifest_bound_policy_tampering(self):
        self.reviewed()
        before = (self.run / 'state.json').read_bytes()
        original = self.fx.req.read_bytes()
        self.fx.req.write_text('[REQ-1] changed requirements', encoding='utf-8')
        for op, action in self.actions():
            self.call(op, action, 'STALE')
            self.assertEqual((self.run / 'state.json').read_bytes(), before)
        self.fx.req.write_bytes(original)
        from specgap.util import canonical_hash
        policy_file = self.run / 'policy.json'
        policy = json.loads(policy_file.read_text(encoding='utf-8'))
        policy['data']['actors']['dev'].append('qa')
        for reseal in (False, True):
            if reseal:
                policy['sha256'] = canonical_hash(policy['data'])
            policy_file.write_text(json.dumps(policy), encoding='utf-8')
            for op, action in self.actions():
                self.call(op, dict(action, actor='dev'), 'INTEGRITY')
                self.assertEqual((self.run / 'state.json').read_bytes(), before)
        self.assertEqual(list((self.run / 'inputs').glob('*')), [])

    def test_human_actions_reject_moved_head_without_appending(self):
        self.reviewed()
        before = (self.run / 'state.json').read_bytes()
        self.fx.put('app.py', 'changed = True\n')
        self.fx.commit('move head')
        for op, action in self.actions():
            self.call(op, action, 'STALE')
            self.assertEqual((self.run / 'state.json').read_bytes(), before)
        self.assertEqual(list((self.run / 'inputs').glob('*')), [])

    def test_manual_evidence_exact_utf8_limit_is_inert_and_rejections_preserve_others(self):
        self.reviewed()
        op, action = self.actions()[2]
        evidence = '界' * 21845 + 'a'
        event = self.call(op, dict(action, evidenceText=evidence))
        self.assertEqual(event['evidence_content'], evidence)
        self.assertEqual(event['evidence_sha256'], hashlib.sha256(evidence.encode()).hexdigest())
        self.assertIsNone(event['decision_sequence'])
        inputs = self.run / 'inputs'
        sentinel = inputs / 'unrelated.txt'
        sentinel.write_text('Preserve another invocation', encoding='utf-8')
        saved = {p.name: p.read_bytes() for p in inputs.iterdir()}
        before = (self.run / 'state.json').read_bytes()
        for changes, code in [({'expectedSequence': 0}, 'CONFLICT'), ({'actor': 'dev'}, 'FORBIDDEN'),
                              ({'result': 'passed'}, 'CONFLICT'), ({'evidenceText': evidence + 'a'}, 'INVALID_INPUT')]:
            payload = dict(action, expectedSequence=1)
            payload.update(changes)
            self.call(op, payload, code)
            self.assertEqual({p.name: p.read_bytes() for p in inputs.iterdir()}, saved)
            self.assertEqual((self.run / 'state.json').read_bytes(), before)
        marker = self.fx.root / 'MUST_NOT_EXECUTE'
        command = f'from pathlib import Path; Path({str(marker)!r}).write_text("executed")'
        event = self.call(op, dict(action, expectedSequence=1, evidenceText=command))
        self.assertEqual(event['evidence_content'], command)
        self.assertFalse(marker.exists())
        self.assertFalse(self.call('read', self.common)['status']['release_approval'])

    def test_missing_and_damaged_artifacts_fail_closed(self):
        self.call('read', self.common, 'NOT_FOUND')
        self.fx.req.write_bytes(b'x' * 1048577)
        self.call('prepare', dict(self.common, repoPath=str(self.fx.repo), requirementsPath=str(self.fx.req)), 'INVALID_INPUT')
        self.assertFalse(self.run.exists())
        self.fx.req.write_text('[REQ-1] bounded requirement', encoding='utf-8')
        self.prepare()
        (self.run / 'bundle.json').write_text('{}', encoding='utf-8')
        self.call('read', self.common, 'INTEGRITY')
        self.call('material', self.common, 'INTEGRITY')

    def test_demo_is_scripted_offline_new_owned_directory(self):
        payload = dict(workspaceRoot=str(self.workspace), dataRoot=str(self.data), demoPath=str(self.data / 'demos' / 'one'))
        result = self.call('demo', payload)
        self.assertEqual(result['semantic_review'], 'scripted_fixture_not_model_evaluation')
        self.assertFalse(result['view']['status']['release_approval'])
        self.assertEqual({f['kind'] for f in result['view']['review']['findings']}, {'contradiction', 'undocumented_change', 'no_evidence'})
        self.call('demo', payload, 'CONFLICT')


if __name__ == '__main__':
    unittest.main()
