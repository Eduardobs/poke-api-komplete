"""Exercise synchronization against a local upstream, without network access."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sync_upstream', Path(__file__).resolve().parents[1] / 'scripts/sync_upstream.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTest(unittest.TestCase):
    def test_update_conflict_and_no_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            remote, project = base / 'remote', base / 'project'
            remote.mkdir()
            project.mkdir()
            def git(*args, cwd=remote):
                return subprocess.check_output(['git', *args], cwd=cwd, stderr=subprocess.DEVNULL)
            for repo in (remote, project):
                git('init', '-q', '-b', 'master', cwd=repo)
                git('config', 'user.email', 'test@example.invalid', cwd=repo)
                git('config', 'user.name', 'Test', cwd=repo)
            (remote / 'data.txt').write_text('old\n')
            git('add', '.')
            git('commit', '-qm', 'initial')
            old = git('rev-parse', 'HEAD').decode().strip()
            vendor = project / 'vendor/pokeapi'
            vendor.mkdir(parents=True)
            (vendor / 'data.txt').write_text('old\n')
            (vendor / 'local.txt').write_text('preserved\n')
            lockpath = project / 'upstream.lock.json'
            lockpath.write_text(json.dumps({'repository': sync.REPOSITORY, 'commit': old, 'last_synced_at': 'initial'}))
            git('add', '.', cwd=project)
            git('commit', '-qm', 'initial', cwd=project)
            (remote / 'data.txt').write_text('new\n')
            git('commit', '-qam', 'update')
            target = git('rev-parse', 'HEAD').decode().strip()
            actual_git, actual_root = sync.git, sync.ROOT
            def local_git(*args, cwd=None):
                return actual_git(*(str(remote) if arg == sync.REPOSITORY + '.git' else arg for arg in args), cwd=cwd or project)
            sync.git, sync.ROOT = local_git, project
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    sync.sync()
                self.assertEqual(json.loads(lockpath.read_text())['commit'], old)
                git('add', '.', cwd=project)
                git('commit', '-qm', 'check', cwd=project)
                (vendor / 'data.txt').write_text('local conflict\n')
                git('commit', '-qam', 'local change', cwd=project)
                with self.assertRaises(subprocess.CalledProcessError):
                    sync.sync(True)
                self.assertEqual(json.loads(lockpath.read_text())['commit'], old)
                self.assertEqual((vendor / 'data.txt').read_text(), 'local conflict\n')
                (vendor / 'data.txt').write_text('old\n')
                git('commit', '-qam', 'resolve', cwd=project)
                (vendor / 'db.sqlite3').touch()
                (vendor / '.snapshot-db-ready').touch()
                # Ignore generated caches, as the real repository does.
                (project / '.gitignore').write_text('*.sqlite3\n.snapshot-db-ready\n')
                with contextlib.redirect_stdout(io.StringIO()):
                    sync.sync(True)
                self.assertEqual(json.loads(lockpath.read_text())['commit'], target)
                self.assertEqual((vendor / 'data.txt').read_text(), 'new\n')
                self.assertEqual((vendor / 'local.txt').read_text(), 'preserved\n')
                self.assertFalse((vendor / 'db.sqlite3').exists())
                self.assertFalse((vendor / '.snapshot-db-ready').exists())
                stamp = json.loads(lockpath.read_text())['last_synced_at']
                with contextlib.redirect_stdout(io.StringIO()):
                    sync.sync()
                self.assertEqual(json.loads(lockpath.read_text())['last_synced_at'], stamp)
            finally:
                sync.git, sync.ROOT = actual_git, actual_root


if __name__ == '__main__':
    unittest.main()
