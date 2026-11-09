import copy
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from specgap import workflow
from specgap.store import mutation_lock

from specgap.errors import SpecGapError, StaleRunError
from specgap.snapshot import prepare
from specgap.store import create_run, load_events, load_run, save_review
from specgap.workflow import import_review, record_decision, record_response, record_verification, status
from tests.helpers import GitFixture
from tests.review_fixture import review_fixture


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.fx = GitFixture(self)
        self.bundle = prepare(self.fx.repo, self.fx.req)
        self.run = self.fx.root / 'run'
        self.policy = {'actors': {'dev': ['developer'], 'pm': ['product'], 'qa': ['qa'], 'sec': ['security']}}
        create_run(self.run, self.bundle, self.policy)
        self.review = review_fixture(self.bundle)
        import_review(self.run, self.review)
        self.evidence = self.fx.root / 'verification.txt'
        self.evidence.write_text('Human observation: limit was 5, not 3.\n', encoding='utf-8')

    def action(self, kind, **keywords):
        # Positional attestation remains a supported CLI/core calling convention.
        if kind == 'response':
            return record_response(self.run, 'F-1', 'dev', 'Human reply', True, **keywords)
        if kind == 'decision':
            return record_decision(self.run, 'F-1', 'qa', 'confirm_defect', 'Reviewed', True, **keywords)
        return record_verification(self.run, 'F-1', 'qa', 'failed', self.evidence, 'manual', True, **keywords)

    def test_expected_sequence_optional_positional_compatibility_and_exact_success(self):
        for kind in ('response', 'decision', 'verification'):
            for mode in ('omitted', 'none', 'exact'):
                before = len(load_events(self.run))
                keywords = {} if mode == 'omitted' else {'expected_sequence': None if mode == 'none' else before}
                event = self.action(kind, **keywords)
                self.assertEqual(event['sequence'], before + 1)
                self.assertNotIn('expected_sequence', event)
        self.assertFalse(status(self.run)['release_approval'])

    def test_zero_sequence_accepts_first_event_for_each_action(self):
        for kind in ('response', 'decision', 'verification'):
            with self.subTest(kind=kind):
                other = self.fx.root / ('empty-' + kind)
                create_run(other, self.bundle, self.policy)
                import_review(other, self.review)
                original, self.run = self.run, other
                try:
                    self.assertEqual(self.action(kind, expected_sequence=0)['sequence'], 1)
                finally:
                    self.run = original

    def test_invalid_sequence_leaves_state_bytes_unchanged(self):
        before = (self.run / 'state.json').read_bytes()
        for kind in ('response', 'decision', 'verification'):
            for value in (True, False, -1, 0.0, '0'):
                with self.subTest(kind=kind, value=value), self.assertRaises(SpecGapError):
                    self.action(kind, expected_sequence=value)
                self.assertEqual((self.run / 'state.json').read_bytes(), before)

    def test_sequence_conflicts_before_context_or_evidence_and_does_not_append(self):
        self.action('response')
        before = (self.run / 'state.json').read_bytes()
        for kind in ('response', 'decision', 'verification'):
            for sequence in (0, 2):
                with self.subTest(kind=kind, sequence=sequence):
                    with patch.object(workflow, '_context', side_effect=AssertionError('context before conflict')), \
                         patch.object(workflow, 'read_bytes', side_effect=AssertionError('evidence before conflict')):
                        with self.assertRaises(SpecGapError) as caught:
                            self.action(kind, expected_sequence=sequence)
                    self.assertEqual(type(caught.exception).__name__, 'SequenceConflictError')
                    self.assertNotIsInstance(caught.exception, StaleRunError)
                    self.assertEqual((self.run / 'state.json').read_bytes(), before)

    def test_sequence_checked_inside_existing_lock_after_intervening_event(self):
        real_lock = mutation_lock
        for kind in ('response', 'decision', 'verification'):
            before = len(load_events(self.run))

            @contextmanager
            def interleave(run):
                # External CLI-style append completes just before acquiring the real lock.
                with patch.object(workflow, 'mutation_lock', real_lock):
                    record_response(run, 'F-1', 'dev', 'Intervening response', True)
                with real_lock(run):
                    yield

            with self.subTest(kind=kind), patch.object(workflow, 'mutation_lock', interleave):
                with self.assertRaises(SpecGapError) as caught:
                    self.action(kind, expected_sequence=before)
            self.assertEqual(type(caught.exception).__name__, 'SequenceConflictError')
            self.assertEqual(len(load_events(self.run)), before + 1)
        with real_lock(self.run):
            owner = (self.run / '.mutation.lock').read_bytes()
            for kind in ('response', 'decision', 'verification'):
                with self.assertRaisesRegex(SpecGapError, 'Run is locked'):
                    self.action(kind, expected_sequence=len(load_events(self.run)))
                self.assertEqual((self.run / '.mutation.lock').read_bytes(), owner)

    def test_sequence_is_run_wide_and_validates_history_not_last_decision(self):
        other = self.fx.root / 'two-findings'
        review = copy.deepcopy(self.review)
        review['findings'].append(dict(review['findings'][0], id='F-2'))
        create_run(other, self.bundle, self.policy)
        import_review(other, review)
        record_response(other, 'F-2', 'dev', 'Different finding', True)
        with self.assertRaises(SpecGapError) as caught:
            record_decision(other, 'F-1', 'qa', 'confirm_defect', 'Reviewed', True, expected_sequence=0)
        self.assertEqual(type(caught.exception).__name__, 'SequenceConflictError')
        self.assertEqual(len(load_events(other)), 1)
        # Even a matching count cannot bypass the validated event hash chain.
        from specgap.util import read_json, write_json, canonical_hash
        state = read_json(other / 'state.json')['data']
        state['events'][0]['sequence'] = True
        write_json(other / 'state.json', {'data': state, 'sha256': canonical_hash(state)})
        with self.assertRaisesRegex(SpecGapError, 'integrity'):
            record_response(other, 'F-1', 'dev', 'Bad history', True, expected_sequence=1)

    def test_response_is_neither_decision_nor_verification(self):
        record_response(self.run, 'F-1', 'dev', 'This was intentional, not yet authorized.', attest_local=True)
        current = status(self.run)
        self.assertEqual(current['review_state'], 'ready_for_review')
        self.assertEqual(current['findings']['F-1']['responses'], 1)
        self.assertEqual(current['findings']['F-1']['disposition'], 'undecided')
        self.assertEqual(current['findings']['F-1']['intent'], 'unconfirmed')
        self.assertEqual(current['findings']['F-1']['verification'], 'unverified')
        self.assertEqual(load_events(self.run)[0]['assurance'], 'local_attestation')

    def test_attestation_actor_role_and_known_finding_required(self):
        for actor, finding, attest in [('dev', 'F-1', False), ('unknown', 'F-1', True), ('qa', 'F-bogus', True)]:
            with self.subTest(actor=actor, finding=finding), self.assertRaises(SpecGapError):
                record_response(self.run, finding, actor, 'text', attest_local=attest)
        with self.assertRaises(SpecGapError):
            record_decision(self.run, 'F-1', 'dev', 'approve_intent_change', 'I wrote it', attest_local=True)
        with self.assertRaises(SpecGapError):
            record_decision(self.run, 'F-1', 'pm', 'confirm_defect', 'Not QA', attest_local=True)
        self.assertEqual(load_events(self.run), [])

    def test_product_can_approve_intent_without_rewriting_requirements(self):
        before = copy.deepcopy(load_run(self.run)['requirements'])
        record_decision(self.run, 'F-1', 'pm', 'approve_intent_change', 'Accept revised limit', attest_local=True)
        state = status(self.run)['findings']['F-1']
        self.assertEqual(state['intent'], 'approved_change_locally_attested')
        self.assertEqual(state['verification'], 'unverified')
        self.assertEqual(load_run(self.run)['requirements'], before)

    def test_risk_acceptance_requires_security_and_does_not_verify(self):
        with self.assertRaises(SpecGapError):
            record_decision(self.run, 'F-1', 'qa', 'accept_risk', 'Not security', attest_local=True)
        record_decision(self.run, 'F-1', 'sec', 'accept_risk', 'Time-bounded exception', attest_local=True)
        self.assertEqual(status(self.run)['findings']['F-1']['verification'], 'unverified')

    def test_pass_requires_prior_decision_and_qa_evidence(self):
        record_response(self.run, 'F-1', 'dev', 'Asked the product owner', attest_local=True)
        with self.assertRaises(SpecGapError):
            record_verification(self.run, 'F-1', 'qa', 'passed', self.evidence, 'manual', attest_local=True)
        record_decision(self.run, 'F-1', 'qa', 'confirm_defect', 'Compared requirement and behavior', attest_local=True)
        with self.assertRaises(SpecGapError):
            record_verification(self.run, 'F-1', 'dev', 'passed', self.evidence, 'manual', attest_local=True)
        event = record_verification(self.run, 'F-1', 'qa', 'passed', self.evidence, 'Manual check of disposition; not an automated test run', attest_local=True, expected_sequence=2)
        self.assertEqual(event['evidence_content'].encode('utf-8'), self.evidence.read_bytes())
        self.assertEqual(event['decision_sequence'], 2)
        self.assertEqual(len(event['evidence_sha256']), 64)
        self.assertEqual(status(self.run)['findings']['F-1']['verification'], 'passed')

    def test_failed_verification_and_new_decision_keep_history(self):
        record_decision(self.run, 'F-1', 'qa', 'confirm_defect', 'Observed violation', attest_local=True, expected_sequence=0)
        record_verification(self.run, 'F-1', 'qa', 'failed', self.evidence, 'Still mismatched', attest_local=True, expected_sequence=1)
        self.assertEqual(status(self.run)['findings']['F-1']['verification'], 'failed')
        self.assertFalse(status(self.run)['release_approval'])
        record_decision(self.run, 'F-1', 'qa', 'not_an_issue', 'New call-path evidence; earlier verification no longer applies', attest_local=True, expected_sequence=2)
        self.assertEqual(status(self.run)['findings']['F-1']['verification'], 'unverified')
        self.assertEqual(len(load_events(self.run)), 3)

    def test_unknown_outcomes_blank_reasons_and_invalid_evidence_rejected(self):
        with self.assertRaises(SpecGapError):
            record_decision(self.run, 'F-1', 'qa', 'ship', 'go', attest_local=True)
        with self.assertRaises(SpecGapError):
            record_response(self.run, 'F-1', 'qa', '  ', attest_local=True)
        with self.assertRaises(SpecGapError):
            record_verification(self.run, 'F-1', 'qa', 'failed', self.fx.root / 'missing', 'manual', attest_local=True)
        self.evidence.write_bytes(b'\x00\xff')
        with self.assertRaises(SpecGapError):
            record_verification(self.run, 'F-1', 'qa', 'failed', self.evidence, 'manual', attest_local=True)
        self.assertEqual(load_events(self.run), [])

    def test_head_advance_refuses_all_mutations_but_keeps_history_readable(self):
        record_response(self.run, 'F-1', 'dev', 'Investigating', attest_local=True)
        self.fx.put('app.py', 'def attempts():\n    return 3\n')
        self.fx.commit('fix in new snapshot')
        before = (self.run / 'state.json').read_bytes()
        for kind in ('response', 'decision', 'verification'):
            with self.subTest(kind=kind), self.assertRaises(StaleRunError):
                self.action(kind, expected_sequence=1)
            self.assertEqual((self.run / 'state.json').read_bytes(), before)
        with self.assertRaises(StaleRunError):
            import_review(self.run, self.review)
        self.assertTrue(status(self.run)['stale'])
        self.assertEqual(len(load_events(self.run)), 1)

    def test_requirement_edits_refuse_mutation(self):
        self.fx.req.write_text('New requirements', encoding='utf-8')
        with self.assertRaises(StaleRunError):
            record_response(self.run, 'F-1', 'dev', 'Cannot carry old authority forward', attest_local=True)

    def test_import_validates_and_review_is_immutable(self):
        other = self.fx.root / 'other'
        create_run(other, self.bundle, self.policy)
        invalid = copy.deepcopy(self.review)
        invalid['requirements'][0]['evidence'][0]['quote'] = 'invented'
        with self.assertRaises(SpecGapError):
            import_review(other, invalid)
        self.assertEqual(status(other)['review_state'], 'needs_review')
        with self.assertRaises(SpecGapError):
            import_review(self.run, self.review)

    def test_no_policy_means_no_authority(self):
        other = self.fx.root / 'no-policy'
        create_run(other, self.bundle)
        save_review(other, self.review)
        with self.assertRaises(SpecGapError):
            record_response(other, 'F-1', 'qa', 'Cannot self-assign actor', attest_local=True)
