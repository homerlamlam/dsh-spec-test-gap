"""Real, isolated Git fixtures. Never run scripts from an audited repository."""

import os
import subprocess
import tempfile
from pathlib import Path


class GitFixture:
    def __init__(self, test):
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo with spaces'
        self.repo.mkdir()
        self.req = self.root / 'requirements.md'
        self.req.write_text('[REQ-1] Retry at most 3 times.\n\n[REQ-2] Name must not be empty.\n', encoding='utf-8')
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Test Author')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.autocrlf', 'false')
        self.git('config', 'core.hooksPath', str(self.root / 'no-hooks'))
        self.put('app.py', 'def attempts():\n    return 3\n')
        self.put('helpers.py', 'def valid(name):\n    return bool(name)\n')
        self.base = self.commit('baseline')
        self.git('switch', '-c', 'feature')
        self.put('app.py', 'def attempts():\n    return 5\n')
        self.head = self.commit('increase retry limit')

    def git(self, *args):
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        env['GIT_TERMINAL_PROMPT'] = '0'
        result = subprocess.run(['git', '-C', str(self.repo), *args], env=env,
                                capture_output=True, check=True, timeout=30)
        return result.stdout.decode('utf-8').strip()

    def put(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(text, bytes):
            path.write_bytes(text)
        else:
            path.write_text(text, encoding='utf-8', newline='')

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-m', message)
        return self.git('rev-parse', 'HEAD')
