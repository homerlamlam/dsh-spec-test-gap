import unittest

from specgap.errors import SpecGapError
from specgap.requirements import parse_requirements


class RequirementsTests(unittest.TestCase):
    def test_preserves_quantifiers_units_negation_and_source_spans(self):
        text = '# Payment\n\n- [REQ-7] Only admins may retry, at most 3 times.\n  Never debit twice; timeout 200 ms.\n- [REQ-8] 金额必须大于 0 元。\n'
        clauses = parse_requirements(text)
        self.assertEqual(len(clauses), 2)
        self.assertEqual(clauses[0], {'id': 'REQ-7', 'text': '- [REQ-7] Only admins may retry, at most 3 times.\n  Never debit twice; timeout 200 ms.', 'start_line': 3, 'end_line': 4})
        self.assertEqual(clauses[1]['text'], '- [REQ-8] 金额必须大于 0 元。')
        self.assertEqual(clauses[1]['start_line'], 5)

    def test_paragraph_ids_are_deterministic_and_repeated_text_distinguished(self):
        clauses = parse_requirements('Respond quickly.\n\nRespond quickly.\n')
        self.assertEqual(clauses, parse_requirements('Respond quickly.\n\nRespond quickly.\n'))
        self.assertNotEqual(clauses[0]['id'], clauses[1]['id'])
        self.assertEqual(clauses[0]['text'], 'Respond quickly.')

    def test_empty_docs_and_duplicate_explicit_ids_are_rejected(self):
        for text in ['', '# Only heading\n', '[REQ-A] One\n\n[REQ-A] Two']:
            with self.subTest(text=text), self.assertRaises(SpecGapError):
                parse_requirements(text)

    def test_unicode_separators_are_not_physical_requirement_lines(self):
        text = '[REQ-A] Preserve alpha\u2028beta and form\ffeed.\n\n[REQ-B] Another clause.\n'
        clauses = parse_requirements(text)
        self.assertEqual(clauses[0]['text'], '[REQ-A] Preserve alpha\u2028beta and form\ffeed.')
        self.assertEqual(clauses[0]['end_line'], 1)
        self.assertEqual(clauses[1]['start_line'], 3)

    def test_code_blocks_remain_verbatim_inside_a_clause(self):
        clauses = parse_requirements('[REQ-A] Input example:\n```text\n- not a new clause\n# not a heading\n```\n')
        self.assertEqual(len(clauses), 1)
        self.assertIn('- not a new clause\n# not a heading', clauses[0]['text'])
