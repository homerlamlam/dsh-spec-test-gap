import os
import shlex
import sys
import unittest

from specgap.errors import SpecGapError
from specgap.gitrepo import GitRepo
from specgap.snapshot import freshness, prepare
from tests.helpers import GitFixture


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.fx = GitFixture(self)

    def prepare(self, **kwargs):
        return prepare(self.fx.repo, self.fx.req, **kwargs)

    def test_default_baseline_and_unchanged_head_context(self):
        bundle = self.prepare()
        self.assertEqual(bundle['repo']['base_sha'], self.fx.base)
        self.assertEqual(bundle['repo']['head_sha'], self.fx.head)
        self.assertEqual([(c['status'], c['new_path']) for c in bundle['changes']], [('M', 'app.py')])
        self.assertTrue(any(s['side'] == 'head' and s['path'] == 'helpers.py' for s in bundle['sources']))
        self.assertEqual(bundle['snapshot_id'], self.prepare()['snapshot_id'])
        self.assertEqual(freshness(bundle, self.fx.repo, self.fx.req), [])

    def test_merge_base_not_target_tip_prevents_false_deletion(self):
        self.fx.git('switch', 'main')
        self.fx.put('target_only.py', 'TARGET_ONLY = True\n')
        target = self.fx.commit('unrelated target change')
        self.fx.git('switch', 'feature')
        bundle = self.prepare(target='main')
        self.assertEqual(bundle['repo']['target_sha'], target)
        self.assertEqual(bundle['repo']['merge_base_sha'], self.fx.base)
        self.assertEqual(bundle['repo']['base_sha'], self.fx.base)
        self.assertFalse(any(c['old_path'] == 'target_only.py' for c in bundle['changes']))

    def test_explicit_base_and_ref_option_injection(self):
        self.assertEqual(self.prepare(base=self.fx.base)['repo']['base_sha'], self.fx.base)
        with self.assertRaises(SpecGapError):
            self.prepare(head='--help')
        with self.assertRaises(SpecGapError):
            self.prepare(head='missing')

    def test_body_hash_async_and_nested_symbols(self):
        self.fx.put('async.py', 'async def outer():\n    def nested():\n        return 1\n    return nested()\n')
        self.fx.commit('add async')
        bundle = self.prepare(base=self.fx.base)
        units = next(s['units'] for s in bundle['sources'] if s['path'] == 'async.py')
        self.assertIn('outer', [u['name'] for u in units])
        self.assertIn('outer.nested', [u['name'] for u in units])
        old = next(s for s in bundle['sources'] if s['side'] == 'base' and s['path'] == 'app.py')
        new = next(s for s in bundle['sources'] if s['side'] == 'head' and s['path'] == 'app.py')
        self.assertNotEqual(old['units'][0]['sha256'], new['units'][0]['sha256'])
        self.assertEqual(new['units'][0]['end_line'], 2)

    def test_physical_lines_keep_unicode_separators_inside_body_hashes(self):
        self.fx.put('app.py', 'LABEL = "alpha\u2028beta"\n\fdef attempts():\n    return 3\n')
        base = self.fx.commit('physical line baseline')
        self.fx.put('app.py', 'LABEL = "alpha\u2028beta"\n\fdef attempts():\n    return 5\n')
        self.fx.commit('physical line body change')
        bundle = self.prepare(base=base)
        old = next(s for s in bundle['sources'] if s['side'] == 'base' and s['path'] == 'app.py')
        new = next(s for s in bundle['sources'] if s['side'] == 'head' and s['path'] == 'app.py')
        self.assertEqual(new['line_count'], 3)
        self.assertEqual((new['units'][0]['start_line'], new['units'][0]['end_line']), (2, 3))
        self.assertNotEqual(old['units'][0]['sha256'], new['units'][0]['sha256'])

    def test_renames_deletions_and_unicode_paths_preserved(self):
        self.fx.git('mv', 'helpers.py', '帮助 util.py')
        self.fx.git('rm', 'app.py')
        self.fx.put('new.py', 'NEW = True\n')
        self.fx.commit('move and delete')
        bundle = self.prepare(base=self.fx.base)
        changes = bundle['changes']
        self.assertTrue(any(c['status'].startswith('R') and c['old_path'] == 'helpers.py' and c['new_path'] == '帮助 util.py' for c in changes))
        self.assertTrue(any(c['status'] == 'D' and c['old_path'] == 'app.py' and c['new_path'] is None for c in changes))
        self.assertTrue(any(c['status'] == 'A' and c['new_path'] == 'new.py' for c in changes))

    def test_dirty_worktree_ignored_not_modified_and_staleness_reported(self):
        bundle = self.prepare()
        self.fx.put('app.py', 'DO NOT OVERWRITE\n')
        dirty = self.prepare()
        self.assertTrue(any('uncommitted' in w.lower() for w in dirty['warnings']))
        self.assertEqual((self.fx.repo / 'app.py').read_text(), 'DO NOT OVERWRITE\n')
        self.assertNotIn('DO NOT OVERWRITE', str(dirty['sources']))
        self.fx.commit('advance')
        self.assertTrue(any('head' in x.lower() for x in freshness(bundle, self.fx.repo, self.fx.req)))
        self.fx.req.write_text('New requirements', encoding='utf-8')
        self.assertTrue(any('requirement' in x.lower() for x in freshness(bundle, self.fx.repo, self.fx.req)))

    def test_target_and_explicit_base_ref_changes_are_stale(self):
        bundle = self.prepare(base='main', target='main')
        self.fx.git('branch', '-f', 'main', 'feature')
        reasons = freshness(bundle, self.fx.repo, self.fx.req)
        self.assertTrue(any('target' in r.lower() for r in reasons))
        self.assertTrue(any('base' in r.lower() for r in reasons))

    def test_secret_binary_unsupported_and_budget_omissions_are_explicit(self):
        self.fx.put('.env', 'TOKEN=DO_NOT_EXPORT\n')
        self.fx.put('image.bin', b'\x00\x01\xff')
        self.fx.put('app.ts', 'export const n = 1;\n')
        self.fx.put('bad.py', 'def broken(\n')
        self.fx.put('latin.py', b'\xffnot utf8')
        self.fx.commit('unsupported and secret')
        bundle = self.prepare(base=self.fx.base)
        for keyword in ['secret', 'binary', 'unsupported', 'syntax', 'utf-8']:
            self.assertTrue(any(keyword in s.lower() for s in bundle['limitations']), keyword)
        self.assertNotIn('DO_NOT_EXPORT', str(bundle))
        limited = self.prepare(base=self.fx.base, max_files=1, max_bytes=10)
        self.assertTrue(any('budget' in s.lower() for s in limited['limitations']))
        self.assertGreater(len(limited['changes']), len(limited['sources']))

    def test_git_symlink_entry_not_followed(self):
        self.fx.git('config', 'core.symlinks', 'false')
        blob = self.fx.git('hash-object', '-w', '--stdin')
        self.fx.git('update-index', '--add', '--cacheinfo', f'120000,{blob},linked.py')
        self.fx.git('commit', '-m', 'git symlink')
        bundle = self.prepare(base=self.fx.base)
        self.assertTrue(any('symlink' in x.lower() for x in bundle['limitations']))
        self.assertFalse(any(s['path'] == 'linked.py' for s in bundle['sources']))

    def test_no_diff_still_includes_requirements_and_context(self):
        bundle = self.prepare(base=self.fx.head)
        self.assertEqual(bundle['changes'], [])
        self.assertEqual(len(bundle['requirements']['clauses']), 2)
        self.assertTrue(bundle['sources'])

    def test_repository_nested_directory_and_partial_clone_rejected(self):
        with self.assertRaises(SpecGapError):
            GitRepo(self.fx.repo / 'missing')
        self.fx.git('config', 'remote.origin.promisor', 'true')
        with self.assertRaises(SpecGapError):
            self.prepare()

    def test_worktree_status_never_executes_clean_filter(self):
        self._check_filter_not_executed('clean')

    def test_worktree_status_never_executes_process_filter(self):
        self._check_filter_not_executed('process')

    def _check_filter_not_executed(self, kind):
        marker = self.fx.root / ('executed-' + kind)
        script = self.fx.repo / 'filter_probe.py'
        script.write_text(
            'from pathlib import Path\nimport sys\n'
            + f'Path({str(marker)!r}).write_text("executed")\n'
            + ('sys.stdout.buffer.write(sys.stdin.buffer.read())\n' if kind == 'clean' else ''),
            encoding='utf-8')
        self.fx.put('.gitattributes', 'app.py filter=probe\n')
        self.fx.commit('add inert filter fixture before configuring driver')
        command = shlex.quote(sys.executable.replace('\\', '/')) + ' ' + shlex.quote(script.as_posix())
        self.fx.git('config', 'filter.probe.' + kind, command)
        tracked = self.fx.repo / 'app.py'
        info = tracked.stat()
        os.utime(tracked, (info.st_atime, info.st_mtime + 5))
        bundle = self.prepare()
        self.assertFalse(marker.exists(), 'prepare invoked audited Git filter code')
        self.assertTrue(any('unknown' in w.lower() and 'filter' in w.lower() for w in bundle['warnings']))
        self.assertTrue(any(s['path'] == 'app.py' for s in bundle['sources']))

    def test_git_external_helpers_never_run(self):
        marker = self.fx.root / 'executed'
        self.fx.git('config', 'core.fsmonitor', f'echo unsafe > "{marker.as_posix()}"')
        self.fx.git('config', 'diff.external', f'echo unsafe > "{marker.as_posix()}"')
        self.prepare()
        self.assertFalse(marker.exists())
