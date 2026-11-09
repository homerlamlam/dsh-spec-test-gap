import copy
import re
import unittest

from specgap.report import render_report
from tests.review_fixture import bundle_fixture, review_fixture


def report_parts(report):
    """Separate Markdown prose from fenced originals using CommonMark fence lengths."""
    prose, blocks, current = [], [], []
    width = None
    for line in report.splitlines(keepends=True):
        stripped = line.rstrip('\r\n')
        if width is None:
            opening = re.fullmatch(r'(`{3,})text', stripped)
            if opening:
                width = len(opening[1])
            else:
                prose.append(line)
        elif re.fullmatch(r'`{' + str(width) + r',}\s*', stripped):
            blocks.append(''.join(current))
            current = []
            width = None
        else:
            current.append(line)
    if width is not None:
        raise AssertionError('Unclosed report code fence')
    return ''.join(prose), blocks


class ReportTests(unittest.TestCase):
    def test_report_has_both_directions_evidence_and_no_release_verdict(self):
        report = render_report(bundle_fixture(), review_fixture(), [])
        prose, blocks = report_parts(report)
        for expected in ['# 需求与实现审查报告', '待人工审阅', '不构成发布批准', '需求 → 实现',
                         '行为变更 → 需求与授权', '问题与澄清', '测试建议（未执行）', '与需求矛盾']:
            self.assertIn(expected, prose)
        self.assertTrue(any('Retry limit differs' in block for block in blocks))
        self.assertTrue(any('    return 5\n' == block for block in blocks))
        self.assertNotIn('ready_for_review', prose)
        self.assertNotIn('product', prose)

    def test_missing_review_and_missing_context_cannot_be_a_clean_result(self):
        self.assertIn('尚未审查', render_report(bundle_fixture(), None, []))
        bundle = bundle_fixture()
        bundle['limitations'] = ['Context budget omitted: head:old.py']
        report = render_report(bundle, review_fixture(), [])
        self.assertIn('审查不完整', report)
        self.assertIn('上下文预算不足，已省略', report)
        self.assertIn('head:old.py', report)
        self.assertIn('已过期或无法确认', render_report(bundle, review_fixture(), [], ['head ref moved since snapshot']))

    def test_untrusted_originals_are_inert_and_backticks_cannot_escape(self):
        review = review_fixture()
        raw = '<script>bad</script> [click](https://evil.test)\n```\n```````\n![image](https://evil.test/pixel)'
        review['findings'][0]['title'] = raw
        review['findings'][0]['evidence'][0]['quote'] = '    value = "<tag>&\\\\"\n```\n```````\n    return value'
        before = copy.deepcopy(review)
        report = render_report(bundle_fixture(), review, [])
        prose, blocks = report_parts(report)
        self.assertNotIn('<script>', prose)
        self.assertNotIn('[click](', prose)
        self.assertNotIn('![image]', prose)
        self.assertIn(raw + '\n', blocks)
        self.assertIn(review['findings'][0]['evidence'][0]['quote'] + '\n', blocks)
        self.assertIn('````````text\n', report)
        self.assertEqual(review, before)

    def test_manual_records_preserve_separate_axes_and_assurance(self):
        events = [{'kind': 'response', 'finding_id': 'F-1', 'actor': 'dev', 'text': 'Asked is not approved.', 'assurance': 'local_attestation', 'created_at': 'today'},
                  {'kind': 'decision', 'finding_id': 'F-1', 'actor': 'qa', 'outcome': 'confirm_defect', 'reason': 'Reviewed', 'assurance': 'local_attestation', 'created_at': 'today'},
                  {'kind': 'verification', 'finding_id': 'F-1', 'actor': 'qa', 'result': 'failed', 'note': 'Manual run', 'evidence_sha256': 'abc', 'assurance': 'local_attestation', 'created_at': 'today'}]
        report = render_report(bundle_fixture(), review_fixture(), events)
        prose, blocks = report_parts(report)
        for expected in ['本地声明', '回复', '裁决', '验证', '人工提供的验证证据', '未通过', '意图状态：未确认', '确认缺陷']:
            self.assertIn(expected, prose)
        self.assertIn('Asked is not approved.\n', blocks)
        self.assertIn('dev\n', blocks)
        self.assertNotIn('local_attestation', prose)
        self.assertIn('尚未验证', render_report(bundle_fixture(), review_fixture(), events[:1]))

    def test_known_warnings_translate_unknown_diagnostics_remain_exact(self):
        bundle = bundle_fixture()
        raw = 'Future external diagnosis: <bad> & `x`\n```\nDo not translate this original.'
        bundle['warnings'] = ['Static context only: no audited application or tests were executed.',
                              'Target integration/merge-result analysis was not performed.', raw]
        before = copy.deepcopy(bundle)
        prose, blocks = report_parts(render_report(bundle, None, []))
        self.assertIn('仅提供静态上下文：未执行被审查的应用或测试', prose)
        self.assertIn('尚未分析目标分支的集成或合并结果', prose)
        self.assertIn('原始诊断（未改写）', prose)
        self.assertIn(raw + '\n', blocks)
        self.assertNotIn('Future external', prose)
        self.assertEqual(bundle, before)

    def test_legacy_english_is_preserved_without_prose_leaks_or_input_mutations(self):
        bundle, review = bundle_fixture(), review_fixture()
        event = {'kind': 'response', 'finding_id': 'F-1', 'actor': '<actor>',
                 'text': '中文记录第一行\nOriginal English must stay unchanged.\n````', 'assurance': 'local_attestation'}
        before = copy.deepcopy((bundle, review, event))
        prose, blocks = report_parts(render_report(bundle, review, [event]))
        self.assertNotRegex(prose, r'[A-Za-z]')
        for original in [review['findings'][0]['title'], review['findings'][0]['description'],
                         review['requirements'][0]['reason'], review['changes'][0]['summary'], event['text']]:
            self.assertIn(original + '\n', blocks)
        self.assertEqual((bundle, review, event), before)

    def test_chinese_explanations_remain_readable_and_markdown_inert(self):
        review = review_fixture()
        review['findings'][0]['title'] = '重试次数超出需求'
        review['findings'][0]['description'] = '中文说明 [链接](https://evil.test) <script>内容</script>'
        review['findings'][0]['question'] = '是否需要先修正实现？'
        prose, _ = report_parts(render_report(bundle_fixture(), review, []))
        self.assertIn('重试次数超出需求', prose)
        self.assertIn('是否需要先修正实现？', prose)
        self.assertNotIn('[链接](', prose)
        self.assertNotIn('<script>', prose)

    def test_empty_findings_never_claim_correctness_in_chinese(self):
        review = review_fixture()
        review['findings'] = []
        report = render_report(bundle_fixture(), review, [])
        self.assertIn('未报告问题。这不代表正确性保证。', report)
