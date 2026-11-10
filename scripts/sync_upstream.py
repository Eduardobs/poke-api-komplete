"""Check or apply upstream source updates, preserving project-specific files."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'https://github.com/PokeAPI/pokeapi'


def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd)


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def sync(apply=False):
    path = ROOT / 'upstream.lock.json'
    original = path.read_text()
    lock = json.loads(original)
    if lock['repository'].rstrip('/') != REPOSITORY:
        raise RuntimeError('Unexpected upstream repository')
    old = lock['commit']
    target = git('ls-remote', REPOSITORY + '.git', 'refs/heads/master').decode().split()[0]
    checked = now()
    report = {'base': old, 'target': target, 'checked_at': checked,
              'updates_available': old != target, 'applied': False}
    if old != target:
        with tempfile.TemporaryDirectory(prefix='pokeapi-sync-') as folder:
            git('init', '-q', folder)
            git('fetch', '--quiet', '--no-tags', REPOSITORY + '.git', old, target, cwd=folder)
            git('merge-base', '--is-ancestor', old, target, cwd=folder)
            report['commits'] = git('log', '--format=%h %s', f'{old}..{target}', cwd=folder).decode().splitlines()
            report['files'] = git('diff', '--stat', old, target, cwd=folder).decode()
            # Gitlinks contain separately managed media snapshots. Never silently skip them.
            raw = git('diff', '--raw', old, target, cwd=folder).decode()
            if any('160000' in line.split('\t')[0] for line in raw.splitlines()):
                report['media_review_required'] = True
                if apply:
                    raise RuntimeError('Upstream submodules changed; reconcile cries/sprites separately before applying')
            if apply:
                if git('status', '--porcelain', '--untracked-files=all', '--', 'vendor/pokeapi', 'upstream.lock.json').strip():
                    raise RuntimeError('Vendor or lock has uncommitted changes; preserve them before synchronization')
                patch = git('diff', '--binary', '--full-index', old, target, cwd=folder)
                with tempfile.NamedTemporaryFile(suffix='.patch') as patchfile:
                    patchfile.write(patch)
                    patchfile.flush()
                    args = ('apply', '--directory=vendor/pokeapi', '--whitespace=nowarn')
                    git(*args, '--check', patchfile.name)
                    if path.read_text() != original:
                        raise RuntimeError('Lock changed during synchronization')
                    git(*args, patchfile.name)
                # Force the next build to recreate SQLite instead of reusing stale rows.
                for cache in ('.snapshot-db-ready', 'db.sqlite3', 'db.sqlite3-wal', 'db.sqlite3-shm'):
                    (ROOT / 'vendor/pokeapi' / cache).unlink(missing_ok=True)
                lock.update(commit=target, last_synced_at=now(), last_synced_at_source='source_sync')
                report['applied'] = True
    lock.update(branch='master', last_checked_at=checked, last_checked_commit=target)
    path.write_text(json.dumps(lock, indent=2) + '\n')
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Apply source changes after conflict checks')
    options = parser.parse_args()
    try:
        sync(options.apply)
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        parser.exit(1, f'Synchronization failed: {error}\n')
