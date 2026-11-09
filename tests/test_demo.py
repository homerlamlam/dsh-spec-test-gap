import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from specgap.cli import main
from specgap.demo import create_demo
from specgap.errors import SpecGapError
from specgap.gitrepo import GitRepo
from specgap.store import load_events, load_review, load_run
from specgap.workflow import status


class DemoTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.out = Path(temp.name) / 'demo with spaces'

    def test_real_demo_exercises_both_directions_without_network(self):
        with patch('specgap.provider.urllib.request.build_opener') as opener:
            run = create_demo(self.out)
            opener.assert_not_called()
        self.assertEqual(run, self.out / 'run')
        bundle = load_run(run)
        self.assertEqual(len(bundle['requirements']['clauses']), 3)
        self.assertTrue(any(s['path'] == 'helpers.py' and s['side'] == 'head' for s in bundle['sources']))
        self.assertEqual({f['kind'] for f in load_review(run)['findings']}, {'contradiction', 'undocumented_change', 'no_evidence'})
        self.assertFalse(GitRepo(self.out / 'repo').dirty())
        self.assertEqual(status(run)['findings']['F-2']['responses'], 1)
        self.assertEqual(status(run)['findings']['F-2']['intent'], 'unconfirmed')
        self.assertEqual(status(run)['review_state'], 'ready_for_review')
        self.assertIn('脚本化示例，不代表模型效果评估', (self.out / 'report.md').read_text(encoding='utf-8'))
        review = load_review(run)
        readable = [clause['text'] for clause in bundle['requirements']['clauses']]
        readable += [item['reason'] for item in review['requirements']]
        readable += [item['summary'] for item in review['changes']]
        for finding in review['findings']:
            readable += [finding[key] for key in ('title', 'description', 'question')]
            readable += finding['test_ideas']
        readable += [event['text'] for event in load_events(run) if event['kind'] == 'response']
        for text in readable:
            self.assertRegex(text, '[\u3400-\u9fff]', text)
        self.assertEqual(review['findings'][0]['evidence'][0]['quote'], '    return 5')
        self.assertFalse(status(run)['release_approval'])

    def test_new_directory_required_and_cli_runs(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(['demo', '--out', str(self.out)]), 0)
        with self.assertRaises(SpecGapError):
            create_demo(self.out)
        self.assertTrue((self.out / 'report.md').is_file())
