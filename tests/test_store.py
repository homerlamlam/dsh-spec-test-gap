import json
import tempfile
import unittest
from pathlib import Path

from specgap.errors import SpecGapError
from specgap.store import (append_event, create_run, load_events, load_policy, load_review,
                           load_run, mutation_lock, save_review)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.run = self.root / 'run'
        self.bundle = {'schema_version': '1', 'snapshot_id': 'demo', 'repo': {'root': str(self.repo)}}
        self.policy = {'actors': {'alice': ['qa'], 'bob': ['developer']}}

    def create(self):
        create_run(self.run, self.bundle, self.policy)

    def test_immutable_bundle_and_local_policy_roundtrip(self):
        self.create()
        self.assertEqual(load_run(self.run), self.bundle)
        self.assertEqual(load_policy(self.run), self.policy)
        self.assertEqual(load_events(self.run), [])
        self.assertIsNone(load_review(self.run))
        with self.assertRaises(SpecGapError):
            self.create()
        self.assertEqual(load_run(self.run), self.bundle)

    def test_run_cannot_be_written_inside_audited_repository(self):
        for path in [self.repo, self.repo / 'reports' / 'run']:
            with self.subTest(path=path), self.assertRaises(SpecGapError):
                create_run(path, self.bundle)
        self.assertEqual(list(self.repo.iterdir()), [])

    def test_corrupt_bundle_policy_and_manifest_are_rejected(self):
        for filename in ['bundle.json', 'policy.json', 'manifest.json']:
            with self.subTest(filename=filename):
                run = self.root / filename.replace('.', '-')
                create_run(run, self.bundle, self.policy)
                data = json.loads((run / filename).read_text(encoding='utf-8'))
                data['data']['unexpected'] = True
                (run / filename).write_text(json.dumps(data), encoding='utf-8')
                with self.assertRaises(SpecGapError):
                    load_run(run)

    def test_review_is_write_once_and_events_have_integrity(self):
        self.create()
        review = {'snapshot_id': 'demo', 'findings': []}
        save_review(self.run, review)
        self.assertEqual(load_review(self.run), review)
        with self.assertRaises(SpecGapError):
            save_review(self.run, {'replacement': True})
        first = append_event(self.run, {'kind': 'response', 'text': 'answer'})
        second = append_event(self.run, {'kind': 'decision', 'text': 'different axis'})
        self.assertEqual(first['sequence'], 1)
        self.assertEqual(second['sequence'], 2)
        self.assertEqual(second['previous_hash'], first['hash'])
        self.assertEqual(len(load_events(self.run)), 2)
        data = json.loads((self.run / 'state.json').read_text())
        data['data']['events'][0]['text'] = 'tampered'
        (self.run / 'state.json').write_text(json.dumps(data))
        with self.assertRaises(SpecGapError):
            load_events(self.run)

    def test_lock_refuses_concurrent_writers_without_lost_updates(self):
        self.create()
        with mutation_lock(self.run):
            with self.assertRaises(SpecGapError):
                append_event(self.run, {'kind': 'response'})
        self.assertEqual(load_events(self.run), [])
        append_event(self.run, {'kind': 'response'})
        self.assertEqual(len(load_events(self.run)), 1)

    def test_invalid_role_policy_rejected_before_creating_directory(self):
        for policy in [{'actors': {'a': ['admin']}}, {'actors': {'a': 'qa'}}, {'actors': []}]:
            with self.subTest(policy=policy), self.assertRaises(SpecGapError):
                create_run(self.run, self.bundle, policy)
            self.assertFalse(self.run.exists())

    def test_symlinked_run_or_artifact_is_rejected(self):
        self.create()
        link = self.root / 'link'
        try:
            link.symlink_to(self.run, target_is_directory=True)
        except OSError:
            self.skipTest('symlink creation unavailable on host')
        with self.assertRaises(SpecGapError):
            load_run(link)
        (self.run / 'state.json').unlink()
        external = self.root / 'outside.json'
        external.write_text('{}')
        (self.run / 'state.json').symlink_to(external)
        with self.assertRaises(SpecGapError):
            append_event(self.run, {'kind': 'response'})
        self.assertEqual(external.read_text(), '{}')
