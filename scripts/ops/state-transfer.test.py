import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("state_transfer", Path(__file__).with_name("state-transfer.py"))
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


class StateTransferTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key = self.root / "passphrase"
        self.key.write_text("test-only-passphrase-please-never-use-in-production\n")
        self.key.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def data(self, site, value):
        data = self.root / site / "data"
        data.mkdir(parents=True)
        db = sqlite3.connect(data / "bot.db")
        db.execute("pragma journal_mode=wal")
        db.execute("create table history(value text)")
        db.execute("insert into history values (?)", (value,))
        db.commit()
        db.close()
        (data / "artifact.txt").write_text(value)
        (data.parent / "config.yaml").write_text("public_url: " + site)
        return data

    def history(self, data):
        connection = sqlite3.connect(data / "bot.db")
        try:
            return connection.execute("select value from history").fetchone()[0]
        finally:
            connection.close()

    def archive(self, data, name="source.gpg", quiesced=False):
        file = self.root / name
        transfer.snapshot(data, file, self.key, quiesced=quiesced, config=data.parent / "config.yaml")
        return file

    def test_live_snapshot_is_consistent_and_never_silently_used_for_final_cutover(self):
        source = self.data("aws", "history-original")
        file = self.archive(source)
        with transfer.unpack(file, self.key) as (payload, manifest):
            self.assertEqual(self.history(payload / "data"), "history-original")
            self.assertFalse(manifest["quiesced"])
        with self.assertRaisesRegex(ValueError, "quiesced source"):
            transfer.restore(file, self.root / "ali/data", self.key, self.root / "backups", "backup", "/backup", new_target=True)
        self.assertFalse((self.root / "ali/data").exists())

    def test_existing_target_is_not_overwritten_when_remote_backup_fails(self):
        source = self.data("aws", "source")
        target = self.data("ali", "target-before")
        file = self.archive(source, quiesced=True)
        with patch.object(transfer, "assert_stopped"), patch.object(transfer, "replicate", side_effect=RuntimeError("remote offline")):
            with self.assertRaisesRegex(RuntimeError, "remote offline"):
                transfer.restore(file, target, self.key, self.root / "backups", "backup", "/backup")
        self.assertEqual(self.history(target), "target-before")
        self.assertEqual(len(list((self.root / "backups").glob("*.gpg"))), 1)

    def test_bidirectional_replacement_keeps_both_preimages_and_each_sites_config(self):
        aws = self.data("aws", "original")
        ali = self.data("ali", "old-target")
        checks = []
        def remote(archive, host, directory):
            with transfer.unpack(archive, self.key) as (payload, _):
                checks.append(self.history(payload / "data"))
            return {"host": host, "sha256": transfer.sha256(archive)}
        with patch.object(transfer, "assert_stopped"), patch.object(transfer, "replicate", side_effect=remote):
            result = transfer.restore(self.archive(aws, quiesced=True), ali, self.key, self.root / "backups", "backup", "/backup")
            self.assertEqual(self.history(ali), "original")
            self.assertEqual(self.history(Path(result["retained_directory"])), "old-target")
            db = sqlite3.connect(ali / "bot.db"); db.execute("update history set value='ali-new'"); db.commit(); db.close()
            transfer.restore(self.archive(ali, "reverse.gpg", True), aws, self.key, self.root / "backups", "backup", "/backup")
        self.assertEqual(self.history(aws), "ali-new")
        self.assertEqual(checks, ["old-target", "original"])
        self.assertEqual((aws.parent / "config.yaml").read_text(), "public_url: aws")
        self.assertEqual((ali.parent / "config.yaml").read_text(), "public_url: ali")

    def test_new_target_and_live_pid_guards(self):
        source = self.data("aws", "source")
        file = self.archive(source)
        with self.assertRaisesRegex(ValueError, "existing directory"):
            transfer.restore(file, source, self.key, self.root / "backups", "backup", "/backup", new_target=True, allow_live_mirror=True)
        pid = self.root / "bot.pid"; pid.write_text(str(os.getpid()))
        with self.assertRaisesRegex(ValueError, "still alive"):
            transfer.assert_stopped(pid_file=pid)
        transfer.restore(file, self.root / "ali/data", self.key, self.root / "backups", "backup", "/backup", new_target=True, allow_live_mirror=True)
        self.assertEqual(self.history(self.root / "ali/data"), "source")

    def test_corruption_cannot_replace_target(self):
        source = self.data("aws", "source")
        target = self.data("ali", "before")
        file = self.archive(source, quiesced=True)
        content = file.read_bytes(); file.write_bytes(content[:len(content)//2])
        with patch.object(transfer, "assert_stopped"), self.assertRaises(Exception):
            transfer.restore(file, target, self.key, self.root / "backups", "backup", "/backup")
        self.assertEqual(self.history(target), "before")

    def test_provider_login_links_are_recorded_but_never_followed(self):
        source = self.data("aws", "history")
        login = self.root / "provider-secret"; login.write_text("do-not-migrate-provider-login")
        link = source / "users/lht/claude-sessions/.credentials.json"
        link.parent.mkdir(parents=True); link.symlink_to(login)
        with transfer.unpack(self.archive(source), self.key) as (payload, manifest):
            self.assertEqual(manifest["omitted_provider_links"], ["users/lht/claude-sessions/.credentials.json"])
            self.assertFalse((payload / "data" / link.relative_to(source)).exists())


if __name__ == "__main__":
    unittest.main()
