import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from reader.admins import AdminStore


class AdminStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.store = AdminStore(self.root)

    def test_nobody_is_an_admin_before_anybody_is_granted_it(self) -> None:
        self.assertEqual(self.store.names(), [])
        self.assertFalse(self.store.is_admin("jirka"))

    def test_a_granted_name_is_an_admin_and_survives_a_new_store(self) -> None:
        self.assertTrue(self.store.grant("jirka"))

        self.assertTrue(AdminStore(self.root).is_admin("jirka"))

    def test_granting_twice_changes_nothing_and_says_so(self) -> None:
        self.store.grant("jirka")

        self.assertFalse(self.store.grant("jirka"))
        self.assertEqual(self.store.names(), ["jirka"])

    def test_revoking_removes_the_grant_and_reports_whether_there_was_one(self) -> None:
        self.store.grant("jirka")

        self.assertTrue(self.store.revoke("jirka"))
        self.assertFalse(self.store.revoke("jirka"))
        self.assertFalse(self.store.is_admin("jirka"))

    def test_the_match_is_exact_because_two_profiles_can_differ_only_in_case(self) -> None:
        # `Magic` and `magic` are two different profiles anybody may create, so
        # a case-insensitive grant would hand one person's role to another.
        self.store.grant("Magic")

        self.assertFalse(self.store.is_admin("magic"))
        self.assertFalse(self.store.is_admin(" Magic"))

    def test_a_grant_read_from_disk_takes_effect_without_rebuilding_the_store(self) -> None:
        # `grant-admin` is run against the live tree; needing a restart to be
        # believed would make the command look broken.
        self.path.write_text(json.dumps({"admins": ["jirka"]}), encoding="utf-8")

        self.assertTrue(self.store.is_admin("jirka"))

    def test_a_corrupted_file_grants_nobody_rather_than_failing_the_request(self) -> None:
        self.path.write_text("{not json", encoding="utf-8")

        self.assertEqual(self.store.names(), [])
        self.assertFalse(self.store.is_admin("jirka"))

    def test_entries_that_are_not_names_are_ignored(self) -> None:
        self.path.write_text(json.dumps({"admins": ["jirka", 7, None, ""]}), encoding="utf-8")

        self.assertEqual(self.store.names(), ["jirka"])

    def test_names_are_stored_sorted_so_the_file_reads_as_a_list(self) -> None:
        for name in ["zoe", "Ada", "jirka"]:
            self.store.grant(name)

        self.assertEqual(self.store.names(), ["Ada", "jirka", "zoe"])

    @property
    def path(self) -> Path:
        return self.root / "admins.json"


if __name__ == "__main__":
    unittest.main()
