import contextlib
import io
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from specgap.cli import main
from specgap.errors import ProviderError
from specgap.store import load_run
from tests.helpers import GitFixture
from tests.review_fixture import review_fixture


class CLITests(unittest.TestCase):
    def setUp(self):
        self.fx = GitFixture(self)
        self.run = self.fx.root / 'run'
        self.policy = self.fx.root / 'policy.json'
        self.policy.write_text(json.dumps({'actors': {'qa': ['qa'], 'dev': ['developer']}}))

    def call(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main([str(a) for a in args])
        return code, out.getvalue(), err.getvalue()

    def prepare(self):
        code, out, err = self.call('prepare', '--repo', self.fx.repo, '--requirements', self.fx.req, '--out', self.run, '--policy', self.policy)
        self.assertEqual((code, err), (0, ''))
        return out

    def import_review(self):
        source = self.fx.root / 'review.json'
        source.write_text(json.dumps(review_fixture(load_run(self.run))), encoding='utf-8')
        return self.call('import-review', '--run', self.run, '--review', source)

    def test_offline_prepare_template_import_status_and_report(self):
        with patch('specgap.provider.urllib.request.build_opener') as opener:
            self.prepare()
            code, output, _ = self.call('status', '--run', self.run)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output)['review_state'], 'needs_review')
            template = self.fx.root / 'template.json'
            self.assertEqual(self.call('template', '--run', self.run, '--out', template)[0], 0)
            self.assertEqual(json.loads(template.read_text())['requirements'][0]['assessment'], 'unassessed')
            self.assertEqual(self.import_review()[0], 0)
            report = self.fx.root / 'report.md'
            self.assertEqual(self.call('report', '--run', self.run, '--out', report)[0], 0)
            self.assertIn('Retry limit differs', report.read_text(encoding='utf-8'))
            self.assertEqual(self.call('report', '--run', self.run, '--out', report)[0], 2)
            self.assertEqual(self.call('status', '--run', self.run)[0], 0)
            opener.assert_not_called()

    def test_exit_two_for_invalid_review_or_output_inside_target(self):
        self.prepare()
        template = self.fx.root / 'template.json'
        self.call('template', '--run', self.run, '--out', template)
        code, _, err = self.call('import-review', '--run', self.run, '--review', template)
        self.assertEqual(code, 2)
        self.assertNotIn('Traceback', err)
        destination = self.fx.repo / 'report.md'
        self.assertEqual(self.call('report', '--run', self.run, '--out', destination)[0], 2)
        self.assertFalse(destination.exists())

    def test_large_numeric_policy_is_input_error_without_writes(self):
        limit = sys.get_int_max_str_digits()
        self.addCleanup(sys.set_int_max_str_digits, limit)
        sys.set_int_max_str_digits(4300)
        self.policy.write_text('{"actors":' + '9' * 5000 + '}', encoding='utf-8')
        code, _, err = self.call('prepare', '--repo', self.fx.repo, '--requirements', self.fx.req,
                                 '--out', self.run, '--policy', self.policy)
        self.assertEqual(code, 2)
        self.assertNotIn('Traceback', err)
        self.assertFalse(self.run.exists())

    def test_deep_valid_ast_falls_back_without_cli_traceback(self):
        text = 'def earlier():\n    return 0\n\nVALUE = ' + ' + '.join(['1'] * 1100) + '\n'
        compile(text, 'flat.py', 'exec')  # Validate this synthetic fixture; never execute it.
        self.fx.put('flat.py', text)
        self.fx.commit('add valid deep expression')
        self.prepare()
        bundle = load_run(self.run)
        source = next(s for s in bundle['sources'] if s['path'] == 'flat.py')
        self.assertEqual(source['content'], text)
        self.assertEqual(source['units'][0]['kind'], 'file')
        self.assertTrue(any('AST' in item and 'flat.py' in item for item in bundle['limitations']))

    def test_manual_commands_and_stale_exit_three(self):
        self.prepare()
        self.import_review()
        shared = ['--run', self.run, '--finding', 'F-1', '--actor', 'qa', '--attest-local']
        self.assertEqual(self.call('respond', *shared, '--text', 'Reviewing')[0], 0)
        self.assertEqual(self.call('decide', *shared, '--outcome', 'confirm_defect', '--reason', 'Matches evidence')[0], 0)
        evidence = self.fx.root / 'manual.txt'
        evidence.write_text('Human supplied result')
        self.assertEqual(self.call('verify', *shared, '--result', 'failed', '--evidence', evidence, '--note', 'Manual check')[0], 0)
        self.fx.req.write_text('Updated requirements')
        code, _, err = self.call('respond', *shared, '--text', 'stale')
        self.assertEqual(code, 3)
        self.assertNotIn('Traceback', err)
        self.assertIn('已过期或无法确认', self.call('report', '--run', self.run)[1])

    def test_analyze_requires_opt_in_and_provider_failure_is_four(self):
        self.prepare()
        shared = ['analyze', '--run', self.run, '--endpoint', 'https://example.invalid/api', '--model', 'test']
        with patch('specgap.cli.request_review') as provider:
            self.assertEqual(self.call(*shared)[0], 4)
            provider.assert_not_called()
        with patch.dict(os.environ, {'SPECGAP_API_KEY': 'test-key'}), patch('specgap.cli.request_review', side_effect=ProviderError('Provider failed')):
            self.assertEqual(self.call(*shared, '--allow-network')[0], 4)
        self.assertEqual(json.loads(self.call('status', '--run', self.run)[1])['review_state'], 'needs_review')

    def test_analyze_validates_again_after_network_return(self):
        self.prepare()
        shared = ['analyze', '--run', self.run, '--endpoint', 'https://example.invalid/api', '--model', 'test', '--allow-network']
        review = review_fixture(load_run(self.run))
        with patch.dict(os.environ, {'SPECGAP_API_KEY': 'test'}), patch('specgap.cli.request_review', return_value=review):
            self.assertEqual(self.call(*shared)[0], 0)
        with patch('specgap.cli.request_review') as provider:
            self.assertEqual(self.call(*shared)[0], 2)
            provider.assert_not_called()

    def test_analyze_refuses_inputs_changed_during_network_request(self):
        self.prepare()
        review = review_fixture(load_run(self.run))

        def changed(*args, **kwargs):
            self.fx.req.write_text('Revised while provider was processing')
            return review

        with patch.dict(os.environ, {'SPECGAP_API_KEY': 'test'}), patch('specgap.cli.request_review', side_effect=changed):
            code, _, _ = self.call('analyze', '--run', self.run, '--endpoint', 'https://example.invalid/api', '--model', 'test', '--allow-network')
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(self.call('status', '--run', self.run)[1])['review_state'], 'needs_review')

    def test_module_entrypoint_and_invalid_argument_exit(self):
        env = dict(os.environ)  # Preserve source-mode or installed-wheel mode chosen by the runner.
        result = subprocess.run([sys.executable, '-m', 'specgap', '--help'], env=env, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'prepare', result.stdout)
        self.assertEqual(self.call('not-a-command')[0], 2)
