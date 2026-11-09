"""Deterministic in-process adapter races; entrypoint coverage stays in test_bridge."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'src'))
sys.path.insert(0, str(ROOT))
from specgap import store, workflow
from specgap.snapshot import prepare
from tests.helpers import GitFixture
from tests.review_fixture import review_fixture

spec = importlib.util.spec_from_file_location('specgap_test_operations', ROOT / 'plugins/dsh-specgap/python/operations.py')
operations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operations)


class OperationTests(unittest.TestCase):
    def test_view_history_state_and_token_share_one_event_snapshot(self):
        fx = GitFixture(self)
        bundle = prepare(fx.repo, fx.req)
        data = tempfile.TemporaryDirectory()
        self.addCleanup(data.cleanup)
        run = Path(data.name) / 'run'
        store.create_run(run, bundle, {'actors': {'qa': ['qa']}})
        workflow.import_review(run, review_fixture(bundle))
        original = store.load_events
        reads = []

        def interleave(path):
            events = original(path)
            reads.append(events)
            if len(reads) == 1:
                # The history read has completed. Another writer commits before
                # status derivation; a second read would mint an unseen token.
                workflow.record_decision(run, 'F-1', 'qa', 'confirm_defect', 'Intervening decision', True)
            return events

        with patch.object(store, 'load_events', interleave), patch.object(workflow, 'load_events', interleave):
            view = operations._view(run)
        self.assertEqual(view['events'], [])
        self.assertEqual(view['status']['event_count'], 0)
        self.assertEqual(view['status']['findings']['F-1']['disposition'], 'undecided')
        self.assertEqual(view['expectedSequence'], 0)
        self.assertEqual(len(reads), 1)
        self.assertEqual(len(original(run)), 1)
        with self.assertRaises(operations.BridgeError) as caught:
            operations.dispatch('respond', dict(workspaceRoot=str(fx.root), dataRoot=str(run.parent),
                runPath=str(run), finding='F-1', actor='qa', attestLocal=True,
                text='Reply to shown history', expectedSequence=view['expectedSequence']))
        self.assertEqual(caught.exception.code, 'CONFLICT')
        self.assertEqual(len(original(run)), 1)


if __name__ == '__main__':
    unittest.main()
