import sys
import tempfile
import unittest
from pathlib import Path

from specgap.errors import SpecGapError
from specgap.util import canonical_hash, physical_lines, read_json, safe_text, strict_loads, write_json


class UtilTests(unittest.TestCase):
    def test_duplicate_keys_and_nonfinite_values_are_rejected(self):
        for text in ['{"x":1,"x":2}', '{"x":{"a":1,"a":2}}', 'NaN', 'Infinity', '1e999', '{']:
            with self.subTest(text=text), self.assertRaises(SpecGapError):
                strict_loads(text)

    def test_large_json_integer_is_a_domain_error(self):
        limit = sys.get_int_max_str_digits()
        self.addCleanup(sys.set_int_max_str_digits, limit)
        sys.set_int_max_str_digits(4300)
        with self.assertRaises(SpecGapError):
            strict_loads('{"value":' + '9' * 5000 + '}')

    def test_hash_ignores_object_key_order_not_content(self):
        self.assertEqual(canonical_hash({'a': 1, 'b': '中文'}), canonical_hash({'b': '中文', 'a': 1}))
        self.assertNotEqual(canonical_hash({'a': 1}), canonical_hash({'a': 2}))
        with self.assertRaises(SpecGapError):
            canonical_hash({'x': float('nan')})

    def test_utf8_roundtrip_and_bounded_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / '数据.json'
            write_json(path, {'text': '最多重试 3 次'})
            self.assertEqual(read_json(path), {'text': '最多重试 3 次'})
            with self.assertRaises(SpecGapError):
                read_json(path, max_bytes=4)

    def test_physical_lines_preserve_layout_and_trailing_empty_lines(self):
        for text, expected in [('', []), ('\n', ['']), ('a\n\n', ['a', '']),
                               ('a\r\nb\rc\n', ['a', 'b', 'c']),
                               ('a\u2028b\u2029c\fd\x85e', ['a\u2028b\u2029c\fd\x85e'])]:
            with self.subTest(text=repr(text)):
                self.assertEqual(physical_lines(text), expected)

    def test_markup_is_not_executable_or_a_live_link(self):
        result = safe_text('<script>alert(1)</script>\n[click](https://evil.test)\n```\n# fake')
        self.assertNotIn('<script>', result)
        self.assertNotIn('[click](', result)
        self.assertNotIn('```', result)
        self.assertNotIn('\n# ', result)
