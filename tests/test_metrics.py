import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from reader.metrics import EventLog


class EventLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.log = EventLog(self.root)

    def test_events_round_trip_with_their_fields(self) -> None:
        self.log.record("session.login", user="ada", ip="203.0.113.4")

        (entry,) = self.log.read()

        self.assertEqual(entry["event"], "session.login")
        self.assertEqual(entry["user"], "ada")
        self.assertEqual(entry["ip"], "203.0.113.4")
        self.assertTrue(entry["timestamp"].endswith("Z"))

    def test_absent_fields_are_omitted_rather_than_stored_as_null(self) -> None:
        self.log.record("session.logout", user=None, ip="203.0.113.4")

        (entry,) = self.log.read()

        self.assertNotIn("user", entry)

    def test_events_are_written_one_per_line_in_a_file_per_day(self) -> None:
        for index in range(3):
            self.log.record("progress.set", user="ada", problem_id=f"p{index}")

        files = list(self.log.directory.glob("*.jsonl"))
        self.assertEqual(len(files), 1)
        lines = files[0].read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 3)
        for line in lines:
            self.assertIsInstance(json.loads(line), dict)

    def test_the_directory_is_private_because_it_holds_addresses(self) -> None:
        self.log.record("session.login", user="ada", ip="203.0.113.4")

        self.assertEqual(self.log.directory.stat().st_mode & 0o777, 0o700)

    def test_a_failure_to_record_never_reaches_the_caller(self) -> None:
        # The metrics directory is replaced by a file, so writing cannot work.
        self.log.directory.parent.mkdir(parents=True, exist_ok=True)
        self.log.directory.write_text("not a directory", encoding="utf-8")

        self.log.record("session.login", user="ada")  # must not raise

    def test_a_truncated_line_does_not_discard_the_rest(self) -> None:
        self.log.record("session.login", user="ada")
        path = next(self.log.directory.glob("*.jsonl"))
        with path.open("a", encoding="utf-8") as log_file:
            log_file.write('{"event": "torn\n')
        self.log.record("session.logout", user="ada")

        events = [entry["event"] for entry in self.log.read()]

        self.assertEqual(events, ["session.login", "session.logout"])


if __name__ == "__main__":
    unittest.main()
