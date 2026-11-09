import copy
import unittest

from specgap.errors import SpecGapError
from specgap.review import review_template, validate_citations, validate_review
from tests.review_fixture import bundle_fixture, citation, review_fixture


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.bundle = bundle_fixture()
        self.review = review_fixture()

    def rejected(self, review):
        with self.assertRaises(SpecGapError):
            validate_review(self.bundle, review)

    def test_valid_bidirectional_review_and_unchanged_evidence(self):
        self.assertEqual(validate_review(self.bundle, self.review), self.review)

    def test_template_is_not_a_review_or_an_approval(self):
        template = review_template(self.bundle)
        self.assertEqual(len(template['requirements']), 2)
        self.assertEqual(len(template['changes']), 1)
        self.rejected(template)

    def test_all_ids_once_and_known_references_only(self):
        for mutation in ['missing', 'duplicate', 'unknown', 'unknown_ref', 'extra_field', 'snapshot']:
            review = copy.deepcopy(self.review)
            if mutation == 'missing':
                review['requirements'].pop()
            elif mutation == 'duplicate':
                review['changes'].append(copy.deepcopy(review['changes'][0]))
            elif mutation == 'unknown':
                review['requirements'][0]['id'] = 'REQ-not-real'
            elif mutation == 'unknown_ref':
                review['findings'][0]['change_ids'] = ['CHG-not-real']
            elif mutation == 'extra_field':
                review['approved'] = True
            else:
                review['snapshot_id'] = 'older'
            with self.subTest(mutation=mutation):
                self.rejected(review)

    def test_exact_citation_bounds_path_side_and_quote(self):
        for field, value in [('start_line', True), ('end_line', 3), ('start_line', 0),
                             ('quote', 'return 5'), ('path', '../app.py'), ('side', 'target')]:
            review = copy.deepcopy(self.review)
            review['requirements'][0]['evidence'][0][field] = value
            with self.subTest(field=field, value=value):
                self.rejected(review)

    def test_citations_count_only_physical_newlines(self):
        first_line = 'LABEL = "alpha\u2028beta"'
        for newline in ('\n', '\r\n', '\r'):
            with self.subTest(newline=repr(newline)):
                self.bundle['sources'][1]['content'] = newline.join([first_line, '\fdef attempts():', '    return 5', ''])
                correct = {'side': 'head', 'path': 'app.py', 'start_line': 3, 'end_line': 3, 'quote': '    return 5'}
                validate_citations(self.bundle, [correct])
                validate_citations(self.bundle, [dict(correct, start_line=1, end_line=1, quote=first_line)])
                with self.assertRaises(SpecGapError):
                    validate_citations(self.bundle, [dict(correct, start_line=5, end_line=5)])

    def test_wide_reference_does_not_count_as_precise_evidence(self):
        self.bundle['sources'][1]['content'] = '\n'.join(['x'] * 50)
        self.bundle['sources'][1]['line_count'] = 50
        self.review['requirements'][0]['evidence'] = [{'side': 'head', 'path': 'app.py', 'start_line': 1, 'end_line': 50, 'quote': '\n'.join(['x'] * 50)}]
        self.rejected(self.review)

    def test_supported_requires_head_and_changed_behavior_requires_both_sides(self):
        review = copy.deepcopy(self.review)
        review['requirements'][1]['evidence'] = [citation('base', quote='    return 3')]
        self.rejected(review)
        review = copy.deepcopy(self.review)
        review['changes'][0]['evidence'] = [citation()]
        self.rejected(review)
        review['changes'][0]['evidence'] = [citation('base', path='helpers.py', quote='x'), citation()]
        self.rejected(review)

    def test_no_diff_does_not_erase_unimplemented_requirement(self):
        self.bundle['changes'] = []
        self.review['changes'] = []
        self.review['findings'] = []
        self.review['requirements'][0] = {'id': 'REQ-1', 'assessment': 'no_evidence',
                                         'reason': 'Searched captured files; no implementation evidence in bounded scope.', 'evidence': []}
        validated = validate_review(self.bundle, self.review)
        self.assertEqual(validated['requirements'][0]['assessment'], 'no_evidence')

    def test_zero_findings_allowed_and_no_forced_question(self):
        self.review['findings'] = []
        self.assertEqual(validate_review(self.bundle, self.review)['findings'], [])

    def test_findings_need_known_origin_and_nonempty_evidence_for_behavior(self):
        for update in [{'id': ''}, {'kind': 'undocumented_change', 'change_ids': []},
                       {'requirement_ids': []}, {'evidence': []}, {'test_ideas': 'not a list'},
                       {'severity': 'approved'}, {'question': ''}]:
            review = copy.deepcopy(self.review)
            review['findings'][0].update(update)
            with self.subTest(update=update):
                self.rejected(review)

    def test_bad_json_shapes_are_user_errors_not_tracebacks(self):
        for value in [None, [], 'text', {'schema_version': '1'}, dict(self.review, requirements=[[]]),
                      dict(self.review, findings=[{'id': []}])]:
            with self.subTest(value=value):
                self.rejected(value)
