#!/usr/bin/env python3
"""A bounded SQLite online backup. Errors leave the running process untouched."""
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys

spec = importlib.util.spec_from_file_location('release_budget', Path(__file__).with_name('release-budget.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def backup(source, destination):
    budget = module.Budget(seconds=300)
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix('.partial')
    fd = os.open(partial, os.O_CREAT | os.O_WRONLY, 0o600)
    os.close(fd)
    with sqlite3.connect('file:' + str(Path(source).resolve()) + '?mode=ro', uri=True) as src:
        # Pin one read snapshot. Otherwise each concurrent Bot commit restarts
        # SQLite's incremental backup, so pacing can prevent it ever finishing.
        # In production WAL mode writers remain free to commit while we read.
        src.execute('BEGIN')
        src.execute('SELECT count(*) FROM sqlite_schema').fetchone()
        page_size = src.execute('PRAGMA page_size').fetchone()[0]
        with sqlite3.connect(partial) as dst:
            src.backup(dst, pages=128, progress=lambda *_: budget.step(128 * page_size), sleep=0.1)
    with open(partial, 'rb') as snapshot:
        os.fsync(snapshot.fileno())
    partial.replace(target)
    fd = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    print('db backup →', target)


if __name__ == '__main__':
    backup(*sys.argv[1:])
