"""PostgreSQL integration tests; use a disposable TEST_DATABASE_URL database."""
import os
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import psycopg
from seed_graphql import sync_table


@unittest.skipUnless(os.environ.get('TEST_DATABASE_URL'), 'Set TEST_DATABASE_URL to a test PostgreSQL database')
class SnapshotImportTest(unittest.TestCase):
    def setUp(self):
        self.pg = psycopg.connect(os.environ['TEST_DATABASE_URL'])
        self.addCleanup(self.pg.close)
        self.source = sqlite3.connect(':memory:')
        self.addCleanup(self.source.close)
        self.cursor = self.pg.cursor()
        self.cursor.execute('CREATE TEMP TABLE seed_test (id serial PRIMARY KEY, text text, language_id integer)')
        self.source.execute('CREATE TABLE seed_test (id integer PRIMARY KEY, text text, language_id integer)')
        self.columns = ['id', 'text', 'language_id']

    def sync(self):
        return sync_table(self.source, self.cursor, 'seed_test', self.columns, 'id')

    def test_existing_database_receives_translation_and_repeat_changes_nothing(self):
        self.cursor.execute("INSERT INTO seed_test VALUES (1, 'Prevents burns.', 9), (99, 'extra', 5)")
        self.source.executemany('INSERT INTO seed_test VALUES (?, ?, ?)', [
            (1, 'Prevents burns.', 9), (2, 'Previne queimaduras.', 13)])
        self.assertEqual(self.sync(), (2, 1))
        self.assertEqual(self.sync(), (2, 0))
        self.cursor.execute('SELECT * FROM seed_test ORDER BY id')
        self.assertEqual(self.cursor.fetchall(), [
            (1, 'Prevents burns.', 9), (2, 'Previne queimaduras.', 13), (99, 'extra', 5)])
        self.cursor.execute("INSERT INTO seed_test (text) VALUES ('next') RETURNING id")
        self.assertEqual(self.cursor.fetchone()[0], 100)

    def test_changed_and_null_fields_are_updated(self):
        self.cursor.execute("INSERT INTO seed_test VALUES (1, 'old', 9), (2, NULL, 13)")
        self.source.executemany('INSERT INTO seed_test VALUES (?, ?, ?)', [(1, None, 9), (2, 'new', 13)])
        self.assertEqual(self.sync(), (2, 2))
        self.assertEqual(self.sync(), (2, 0))

    def test_empty_snapshot_preserves_destination(self):
        self.cursor.execute("INSERT INTO seed_test VALUES (1, 'extra', 9)")
        self.assertEqual(self.sync(), (0, 0))
        self.cursor.execute('SELECT count(*) FROM seed_test')
        self.assertEqual(self.cursor.fetchone()[0], 1)

    def test_failure_rolls_back_previously_merged_tables(self):
        self.source.execute("INSERT INTO seed_test VALUES (1, 'translated', 13)")
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            with self.pg.transaction():
                self.assertEqual(self.sync(), (1, 1))
                self.cursor.execute('CREATE TEMP TABLE seed_child (id integer REFERENCES seed_test(id) DEFERRABLE INITIALLY DEFERRED)')
                self.cursor.execute('INSERT INTO seed_child VALUES (999)')
                self.cursor.execute('SET CONSTRAINTS ALL IMMEDIATE')
        self.cursor.execute('SELECT count(*) FROM seed_test')
        self.assertEqual(self.cursor.fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
