import hashlib
import json
import re
import socket
import threading
import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from reader.server import (
    ProgressStore,
    StorageCorruptionError,
    collection_problem_id,
    create_server,
    load_collections,
    normalize_base_path,
    parse_initial_stones,
    source_collection_slug,
)


def user_file_path(progress_path: Path, user: str) -> Path:
    normalized_user = user.strip()
    filename = f"{hashlib.sha256(normalized_user.encode()).hexdigest()}.json"
    return progress_path.parent / "users" / filename


class CollectionTests(unittest.TestCase):
    def make_metadata_fixture(self) -> Path:
        temporary_directory = TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        fixture_root = Path(temporary_directory.name)
        books_directory = fixture_root / "books"
        books_directory.mkdir()
        (books_directory / "beginner.tex").write_text(
            "%tsumego\n"
            "\\def\\entitle{Beginner}\n"
            "\\def\\level{20 ky\\=u}\n"
            "\\def\\problems{%\n"
            "\\p{1}{2}%\n"
            "\\p{1}{2}%\n"
            "}\n"
        )
        (books_directory / "advanced-part-1.tex").write_text(
            "%tesuji\n"
            "\\def\\entitle{Advanced, Part~1}\n"
            "\\def\\level{1 dan}\n"
            "\\def\\problems{%\n"
            "\\p{7}{42}%\n"
            "}\n"
        )
        (fixture_root / "problems/beginner/1").mkdir(parents=True)
        (fixture_root / "problems/beginner/1/2.sgf").write_text("(;AB[aa]AW[bb])")
        (fixture_root / "problems/advanced/7").mkdir(parents=True)
        (fixture_root / "problems/advanced/7/42.sgf").write_text("(;AB[cc]AW[dd])")
        return fixture_root

    def test_load_collections_parses_metadata_orders_by_level_and_namespaces_ids(self) -> None:
        fixture_root = self.make_metadata_fixture()

        collections = load_collections(fixture_root)

        self.assertEqual(
            [collection.slug for collection in collections], ["beginner", "advanced-part-1"]
        )
        self.assertEqual(collections[0].category, "tsumego")
        self.assertEqual(collections[0].level, "20 kyu")
        self.assertEqual(
            [problem.problem_id for problem in collections[0].problems],
            ["beginner:1/2@1", "beginner:1/2@2"],
        )
        self.assertEqual(collections[1].rank, 21)
        self.assertEqual(collections[1].problems[0].problem_id, "advanced-part-1:7/42@1")

    def test_source_collection_slug_removes_only_a_trailing_part_number(self) -> None:
        self.assertEqual(source_collection_slug("advanced-part-1"), "advanced")
        self.assertEqual(source_collection_slug("part-1-reference"), "part-1-reference")
        self.assertEqual(collection_problem_id("beginner", "1/2", 3), "beginner:1/2@3")

    def make_fixture_collection(
        self,
        tex: str = "\\p{24176}{174140}%\n\\p{24176}{174139}%",
        first_sgf: str = "(;AB[aa]AW[bb];B[cc];W[dd])",
    ) -> Path:
        temporary_directory = TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        fixture_root = Path(temporary_directory.name)

        books_directory = fixture_root / "books"
        books_directory.mkdir()
        (books_directory / "200-basic-go-problems.tex").write_text(
            "%tsumego\n"
            "\\def\\entitle{200 Basic Go Problems}\n"
            "\\def\\level{6 ky\\=u}\n"
            "\\def\\problems{%\n"
            f"{tex}\n"
            "}\n"
        )

        problem_directory = fixture_root / "problems/200-basic-go-problems/24176"
        problem_directory.mkdir(parents=True)
        (problem_directory / "174140.sgf").write_text(first_sgf)
        (problem_directory / "174139.sgf").write_text("(;AB[cc]AW[dd];B[ee];W[ff])")

        return fixture_root

    def test_load_collections_uses_tex_order_and_initial_stones(self) -> None:
        fixture_root = self.make_fixture_collection()

        problems = load_collections(fixture_root)[0].problems

        self.assertEqual(
            [(problem.number, problem.problem_id) for problem in problems],
            [
                (1, "200-basic-go-problems:24176/174140@1"),
                (2, "200-basic-go-problems:24176/174139@1"),
            ],
        )
        self.assertEqual(problems[0].black, ["aa"])
        self.assertEqual(problems[0].white, ["bb"])

    def test_load_collections_rejects_missing_sgf(self) -> None:
        fixture_root = self.make_fixture_collection(tex=r"\p{24176}{999999}%")

        with self.assertRaisesRegex(ValueError, "Missing SGF"):
            load_collections(fixture_root)

    def test_load_collections_rejects_malformed_child_syntax_and_trailing_content(self) -> None:
        for source in ("(;AB[aa];B[x])", "(;AB[aa];b[cc])", "(;AB[aa]) trailing"):
            with self.subTest(source=source):
                fixture_root = self.make_fixture_collection(
                    tex=r"\p{24176}{174140}%",
                    first_sgf=source,
                )

                with self.assertRaisesRegex(ValueError, "Invalid SGF"):
                    load_collections(fixture_root)

    def test_parse_initial_stones_ignores_comment_text_and_reads_multiple_values(
        self,
    ) -> None:
        source = r"(;C[hint: AB\[tt\] AW\[uu\] and escaped \[brackets\]]AB[aa][bb]AW[cc][dd])"

        black, white = parse_initial_stones(source)

        self.assertEqual(black, ["aa", "bb"])
        self.assertEqual(white, ["cc", "dd"])

    def test_parse_initial_stones_rejects_invalid_setup_coordinate(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid SGF coordinate: tt"):
            parse_initial_stones("(;AB[tt])")

    def test_parse_initial_stones_rejects_non_ascii_property_identifier(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid SGF property identifier"):
            parse_initial_stones("(;\u00c1B[aa])")

    def test_parse_initial_stones_treats_unescaped_open_bracket_as_comment_text(
        self,
    ) -> None:
        black, white = parse_initial_stones("(;C[hint: [ordinary text]AB[aa])")

        self.assertEqual(black, ["aa"])
        self.assertEqual(white, [])

    def test_parse_initial_stones_reads_setup_from_root_node_only(self) -> None:
        black, white = parse_initial_stones("(;AB[aa];B[bb]AB[cc])")

        self.assertEqual(black, ["aa"])
        self.assertEqual(white, [])

    def test_parse_initial_stones_rejects_missing_closing_game_tree(self) -> None:
        with self.assertRaisesRegex(ValueError, "Missing SGF closing game tree"):
            parse_initial_stones("(;AB[aa]")


class BasePathTests(unittest.TestCase):
    def test_base_path_normalizes_leading_and_trailing_slashes(self) -> None:
        self.assertEqual(normalize_base_path("tsumego/"), "/tsumego")
        self.assertEqual(normalize_base_path("/tsumego/"), "/tsumego")
        self.assertEqual(normalize_base_path("/"), "")

    def test_base_path_rejects_unsafe_segments(self) -> None:
        for base_path in ("/tsumego//reader", "/tsumego/../reader", "/tsumego?<script>"):
            with self.subTest(base_path=base_path), self.assertRaises(ValueError):
                normalize_base_path(base_path)


class ProgressStoreTests(unittest.TestCase):
    problem_id = "200-basic-go-problems:24176/174139@1"
    second_problem_id = "200-basic-go-problems:24176/174140@1"

    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)

    def test_progress_store_uses_safe_deterministic_isolated_user_files(self) -> None:
        path = self.root / "reader-data/progress.json"
        store = ProgressStore(path, {self.problem_id})

        ada_progress = store.set_status("../../Ada", self.problem_id, "solved")
        bert_progress = store.set_status("Bert / ../", self.problem_id, "revisit")

        self.assertEqual(ada_progress[self.problem_id]["status"], "solved")
        self.assertEqual(bert_progress[self.problem_id]["status"], "revisit")
        user_files = sorted((path.parent / "users").glob("*.json"))
        self.assertEqual(len(user_files), 2)
        self.assertTrue(all(file.parent == path.parent / "users" for file in user_files))
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}\.json", file.name) for file in user_files))
        self.assertEqual(user_file_path(path, "../../Ada"), user_file_path(path, "  ../../Ada  "))
        saved_names = {json.loads(file.read_text())["user"] for file in user_files}
        self.assertEqual(saved_names, {"../../Ada", "Bert / ../"})
        self.assertEqual(store.get_user("../../Ada"), ada_progress)
        self.assertEqual(store.get_user("Bert / ../"), bert_progress)
        self.assertFalse(path.exists())

    def test_progress_store_appends_every_repeated_action_event(self) -> None:
        path = self.root / "reader-data/progress.json"
        store = ProgressStore(path, {self.problem_id})

        store.set_status("Ada", self.problem_id, "solved")
        store.set_status("Ada", self.problem_id, "solved")
        result = store.set_status("Ada", self.problem_id, "revisit")

        events = store.get_activity("Ada", 10)
        self.assertEqual([event["status"] for event in events], ["revisit", "solved", "solved"])
        self.assertTrue(all(event["problem_id"] == self.problem_id for event in events))
        self.assertEqual(result[self.problem_id]["status"], "revisit")
        saved = json.loads(user_file_path(path, "Ada").read_text())
        self.assertEqual(len(saved["events"]), 3)

    def test_progress_store_activity_is_newest_first_and_limited(self) -> None:
        store = ProgressStore(self.root / "progress.json", {self.problem_id})
        for status in ("solved", "revisit", "solved"):
            store.set_status("Ada", self.problem_id, status)

        events = store.get_activity("Ada", 2)

        self.assertEqual([event["status"] for event in events], ["solved", "revisit"])

    def test_arbitrary_user_reads_release_their_lock_entries(self) -> None:
        store = ProgressStore(self.root / "progress.json", {self.problem_id})

        for index in range(1_000):
            self.assertEqual(store.get_user(f"Reader {index}"), {})

        self.assertEqual(store._user_locks, {})

    def test_progress_store_unseen_removes_status_without_recording_an_event(self) -> None:
        store = ProgressStore(self.root / "progress.json", {self.problem_id})
        store.set_status("Ada", self.problem_id, "solved")

        result = store.set_status("Ada", self.problem_id, "unseen")

        self.assertEqual(result, {})
        self.assertEqual(len(store.get_activity("Ada", 10)), 1)

    def test_progress_store_rejects_invalid_status_and_unknown_problem(self) -> None:
        store = ProgressStore(self.root / "progress.json", {self.problem_id})

        with self.assertRaisesRegex(ValueError, "Invalid status"):
            store.set_status("Ada", self.problem_id, "wrong")
        with self.assertRaisesRegex(ValueError, "Unknown problem"):
            store.set_status("Ada", "missing", "solved")

    def test_progress_store_validates_user_names(self) -> None:
        store = ProgressStore(self.root / "progress.json", {self.problem_id})

        for user in ("", "  Ada  ", "x" * 81, "\ud800"):
            with self.subTest(user=user):
                if user == "  Ada  ":
                    store.set_status(user, self.problem_id, "solved")
                else:
                    with self.assertRaisesRegex(ValueError, "Invalid user"):
                        store.set_status(user, self.problem_id, "solved")

    def test_progress_store_records_utc_timestamp_and_reloads(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {self.problem_id})

        result = store.set_status("Ada", self.problem_id, "revisit")
        timestamp = result[self.problem_id]["updated_at"]

        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        self.assertIsNotNone(parsed.utcoffset())
        self.assertEqual(parsed.utcoffset().total_seconds(), 0)
        self.assertEqual(ProgressStore(path, {self.problem_id}).get_user("Ada"), result)
        event_timestamp = store.get_activity("Ada", 1)[0]["timestamp"]
        self.assertEqual(event_timestamp, timestamp)

    def test_progress_store_keeps_concurrent_updates(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {self.problem_id, self.second_problem_id})
        original_write = store._write_user_document
        first_write_started = threading.Event()
        allow_first_write = threading.Event()
        second_update_done = threading.Event()

        def blocking_write(user: str, data: dict[str, object]) -> None:
            if not first_write_started.is_set():
                first_write_started.set()
                self.assertTrue(allow_first_write.wait(timeout=1))
            original_write(user, data)

        store._write_user_document = blocking_write  # type: ignore[method-assign]
        first_update = threading.Thread(
            target=store.set_status,
            args=("Ada", self.problem_id, "solved"),
        )
        second_update = threading.Thread(
            target=lambda: (
                store.set_status("Ada", self.second_problem_id, "revisit"),
                second_update_done.set(),
            ),
        )

        first_update.start()
        self.assertTrue(first_write_started.wait(timeout=1))
        second_update.start()
        allow_first_write.set()
        first_update.join(timeout=1)
        second_update.join(timeout=1)

        self.assertFalse(first_update.is_alive())
        self.assertFalse(second_update.is_alive())
        self.assertTrue(second_update_done.is_set())
        self.assertEqual(set(store.get_user("Ada")), {self.problem_id, self.second_problem_id})
        self.assertEqual(store._user_locks, {})

    def test_progress_store_does_not_block_different_users(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {self.problem_id})
        original_write = store._write_user_document
        ada_write_started = threading.Event()
        allow_ada_write = threading.Event()
        bert_update_done = threading.Event()

        def blocking_ada_write(user: str, data: dict[str, object]) -> None:
            if user == "Ada":
                ada_write_started.set()
                self.assertTrue(allow_ada_write.wait(timeout=1))
            original_write(user, data)

        store._write_user_document = blocking_ada_write  # type: ignore[method-assign]
        ada_update = threading.Thread(
            target=store.set_status, args=("Ada", self.problem_id, "solved")
        )
        bert_update = threading.Thread(
            target=lambda: (
                store.set_status("Bert", self.problem_id, "revisit"),
                bert_update_done.set(),
            )
        )

        ada_update.start()
        self.assertTrue(ada_write_started.wait(timeout=1))
        bert_update.start()
        self.assertTrue(bert_update_done.wait(timeout=1))
        allow_ada_write.set()
        ada_update.join(timeout=1)
        bert_update.join(timeout=1)

        self.assertFalse(ada_update.is_alive())
        self.assertFalse(bert_update.is_alive())

    def test_progress_store_rejects_corrupt_per_user_schema(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {self.problem_id})
        user_path = user_file_path(path, "Ada")
        user_path.parent.mkdir(parents=True)
        corrupted_documents = [
            {"user": "Ada", "problems": {}},
            {"user": "Wrong", "problems": {}, "events": []},
            {"user": "Ada", "problems": [], "events": []},
            {"user": "Ada", "problems": {"unknown": {}}, "events": []},
            {
                "user": "Ada",
                "problems": {
                    self.problem_id: {
                        "status": "unseen",
                        "updated_at": "2026-08-23T12:00:00Z",
                    }
                },
                "events": [],
            },
            {
                "user": "Ada",
                "problems": {},
                "events": [
                    {"problem_id": self.problem_id, "status": "solved", "timestamp": "wrong"}
                ],
            },
        ]

        for data in corrupted_documents:
            with self.subTest(data=data):
                user_path.write_text(json.dumps(data))
                with self.assertRaises(StorageCorruptionError):
                    store.get_user("Ada")

    def test_legacy_migration_preflights_then_backs_up_and_creates_user_documents(self) -> None:
        path = self.root / "reader-data/progress.json"
        document = {
            "users": {
                "Ada": {
                    "problems": {
                        "24176/174139": {
                            "status": "solved",
                            "updated_at": "2026-08-23T12:00:00Z",
                        }
                    }
                },
                "Bert": {
                    "problems": {
                        self.second_problem_id: {
                            "status": "revisit",
                            "updated_at": "2026-08-23T13:00:00Z",
                        }
                    }
                },
            }
        }
        original_bytes = json.dumps(document, indent=2).encode()
        path.parent.mkdir(parents=True)
        path.write_bytes(original_bytes)

        store = ProgressStore(path, {self.problem_id, self.second_problem_id})

        self.assertEqual(store.get_user("Ada")[self.problem_id]["status"], "solved")
        self.assertEqual(store.get_activity("Ada", 10)[0]["timestamp"], "2026-08-23T12:00:00Z")
        self.assertEqual(path.read_bytes(), original_bytes)
        backups = list(path.parent.glob("progress.*.backup.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original_bytes)
        marker = json.loads((path.parent / "progress-migration.json").read_text())
        self.assertEqual(marker["state"], "complete")
        self.assertEqual(len(list((path.parent / "users").glob("*.json"))), 2)

    def test_legacy_migration_rejects_invalid_data_before_writing_anything(self) -> None:
        path = self.root / "reader-data/progress.json"
        original_bytes = json.dumps(
            {
                "users": {
                    "Ada": {"problems": {}},
                    "Bert": {"problems": {"unknown:1/2@1": {}}},
                }
            },
            indent=2,
        ).encode()
        path.parent.mkdir(parents=True)
        path.write_bytes(original_bytes)

        with self.assertRaises(StorageCorruptionError):
            ProgressStore(path, {self.problem_id})

        self.assertEqual(path.read_bytes(), original_bytes)
        self.assertFalse((path.parent / "users").exists())
        self.assertFalse((path.parent / "progress-migration.json").exists())
        self.assertEqual(list(path.parent.glob("progress.*.backup.json")), [])

    def test_legacy_migration_recovers_from_an_in_progress_marker_without_duplicate_events(
        self,
    ) -> None:
        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(
                {
                    "users": {
                        "Ada": {
                            "problems": {
                                self.problem_id: {
                                    "status": "solved",
                                    "updated_at": "2026-08-23T12:00:00Z",
                                }
                            }
                        },
                        "Bert": {
                            "problems": {
                                self.second_problem_id: {
                                    "status": "revisit",
                                    "updated_at": "2026-08-23T13:00:00Z",
                                }
                            }
                        },
                    }
                }
            )
        )
        first_store = ProgressStore(path, {self.problem_id, self.second_problem_id})
        marker_path = path.parent / "progress-migration.json"
        marker = json.loads(marker_path.read_text())
        marker["state"] = "in_progress"
        marker_path.write_text(json.dumps(marker))
        user_file_path(path, "Bert").unlink()

        recovered_store = ProgressStore(path, {self.problem_id, self.second_problem_id})

        self.assertEqual(len(first_store.get_activity("Ada", 10)), 1)
        self.assertEqual(len(recovered_store.get_activity("Ada", 10)), 1)
        self.assertEqual(len(recovered_store.get_activity("Bert", 10)), 1)
        self.assertEqual(json.loads(marker_path.read_text())["state"], "complete")
        self.assertEqual(len(list(path.parent.glob("progress.*.backup.json"))), 1)

    def test_legacy_migration_refuses_existing_target_without_backup_or_marker(self) -> None:
        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"users": {"Ada": {"problems": {}}}}))
        target = user_file_path(path, "Ada")
        target.parent.mkdir()
        target.write_text(json.dumps({"user": "Ada", "problems": {}, "events": []}))

        with self.assertRaisesRegex(StorageCorruptionError, "already exists"):
            ProgressStore(path, {self.problem_id})

        self.assertFalse((path.parent / "progress-migration.json").exists())
        self.assertEqual(list(path.parent.glob("progress.*.backup.json")), [])

    def test_completed_migration_marker_rejects_a_missing_migrated_user_file(self) -> None:
        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"users": {"Ada": {"problems": {}}}}))
        ProgressStore(path, {self.problem_id})
        user_file_path(path, "Ada").unlink()

        with self.assertRaisesRegex(StorageCorruptionError, "missing"):
            ProgressStore(path, {self.problem_id})

    def test_legacy_backup_collision_never_removes_the_existing_backup(self) -> None:
        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz: object = None) -> "FixedDateTime":
                return cls(2026, 8, 23, 12, 34, 56, 123456)

        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"users": {}}))
        backup_path = path.parent / "progress.20260823T123456.123456Z.backup.json"
        backup_path.write_bytes(b"existing backup")

        with patch("reader.server.datetime", FixedDateTime), self.assertRaises(FileExistsError):
            ProgressStore(path, {self.problem_id})

        self.assertEqual(backup_path.read_bytes(), b"existing backup")

    def test_progress_store_reports_a_corrupt_migration_marker_as_storage_corruption(self) -> None:
        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"users": {}}))
        ProgressStore(path, {self.problem_id})
        marker_path = path.parent / "progress-migration.json"
        marker = json.loads(marker_path.read_text())
        marker["targets"] = {"": "unsafe.json"}
        marker_path.write_text(json.dumps(marker))

        with self.assertRaises(StorageCorruptionError):
            ProgressStore(path, {self.problem_id})

    def test_legacy_migration_rejects_a_user_name_that_cannot_be_utf8_encoded(self) -> None:
        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"users": {"\ud800": {"problems": {}}}}))

        with self.assertRaises(StorageCorruptionError):
            ProgressStore(path, {self.problem_id})

    def test_completed_migration_marker_requires_its_matching_backup(self) -> None:
        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"users": {}}))
        ProgressStore(path, {self.problem_id})
        next(path.parent.glob("progress.*.backup.json")).unlink()

        with self.assertRaisesRegex(StorageCorruptionError, "backup"):
            ProgressStore(path, {self.problem_id})

    def test_legacy_migration_orders_fractional_timestamps_chronologically(self) -> None:
        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(
                {
                    "users": {
                        "Ada": {
                            "problems": {
                                self.problem_id: {
                                    "status": "solved",
                                    "updated_at": "2026-08-23T12:00:00Z",
                                },
                                self.second_problem_id: {
                                    "status": "revisit",
                                    "updated_at": "2026-08-23T12:00:00.1Z",
                                },
                            }
                        }
                    }
                }
            )
        )

        store = ProgressStore(path, {self.problem_id, self.second_problem_id})

        self.assertEqual(store.get_activity("Ada", 2)[0]["problem_id"], self.second_problem_id)

    def test_migration_marker_rejects_a_different_compatibility_progress_file(self) -> None:
        first_path = self.root / "first.json"
        second_path = self.root / "second.json"
        first_path.write_text(json.dumps({"users": {"Ada": {"problems": {}}}}))
        second_path.write_text(json.dumps({"users": {"Bert": {"problems": {}}}}))
        ProgressStore(first_path, {self.problem_id})

        with self.assertRaisesRegex(StorageCorruptionError, "different legacy progress"):
            ProgressStore(second_path, {self.problem_id})

    def test_first_user_write_fsyncs_each_new_directory_entry(self) -> None:
        path = self.root / "reader-data/progress.json"
        store = ProgressStore(path, {self.problem_id})
        synced_directories: list[Path] = []
        original_sync_directory = store._sync_directory

        def recording_sync_directory(directory: Path) -> None:
            synced_directories.append(directory)
            original_sync_directory(directory)

        store._sync_directory = recording_sync_directory  # type: ignore[method-assign]

        store.set_status("Ada", self.problem_id, "solved")

        self.assertEqual(
            synced_directories,
            [self.root, path.parent, path.parent / "users"],
        )


class HttpApiTests(unittest.TestCase):
    base_path = ""

    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self._make_fixture_collection()
        self.server = create_server(
            self.root,
            self.root / "reader-data/progress.json",
            base_path=self.base_path,
        )
        self.server_thread = threading.Thread(target=self.server.serve_forever)
        self.server_thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.base_url = f"{self.origin}{self.base_path}"
        self.token = self.sign_in("Ada")

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join()

    def test_collections_endpoint_returns_catalog_without_positions(self) -> None:
        response = self.get_json("/api/collections")

        self.assertIsInstance(response, list)
        catalog_entry = response[0]
        self.assertEqual(catalog_entry["slug"], "200-basic-go-problems")
        self.assertEqual(catalog_entry["title"], "200 Basic Go Problems")
        self.assertEqual(catalog_entry["problem_count"], 1)
        self.assertNotIn("problems", catalog_entry)

    def test_health_endpoint_reports_service_status(self) -> None:
        response = self.get_json("/healthz")

        self.assertEqual(response, {"status": "ok"})

    def test_collection_reader_path_serves_reader_shell(self) -> None:
        for path in [
            "/collections/200-basic-go-problems",
            "/collections/200-basic-go-problems/1",
            "/collections/",
        ]:
            with self.subTest(path=path), urlopen(f"{self.base_url}{path}") as response:
                body = response.read().decode("utf-8")

                self.assertEqual(response.status, 200)
                self.assertIn('id="collection-list"', body)

    def test_static_assets_are_served_with_the_configured_route_prefix(self) -> None:
        for path in ["/app.css", "/app.js"]:
            with self.subTest(path=path), urlopen(f"{self.base_url}{path}") as response:
                self.assertEqual(response.status, 200)

    def test_progressive_web_app_assets_are_served_with_the_configured_prefix(self) -> None:
        expected_types = {
            "/manifest.webmanifest": "application/manifest+json",
            "/sw.js": "text/javascript",
            "/icons/icon-192.png": "image/png",
            "/icons/icon-512.png": "image/png",
            "/icons/icon-maskable-512.png": "image/png",
            "/icons/apple-touch-icon.png": "image/png",
        }
        for path, expected_type in expected_types.items():
            with self.subTest(path=path), urlopen(f"{self.base_url}{path}") as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get_content_type(), expected_type)

    def test_manifest_uses_relative_urls_so_one_document_fits_any_base_path(self) -> None:
        with urlopen(f"{self.base_url}/manifest.webmanifest") as response:
            manifest = json.loads(response.read())

        self.assertEqual(manifest["start_url"], "./")
        self.assertEqual(manifest["scope"], "./")
        self.assertEqual(manifest["display"], "standalone")
        for icon in manifest["icons"]:
            self.assertTrue(icon["src"].startswith("./"), icon["src"])
        self.assertIn("512x512", {icon["sizes"] for icon in manifest["icons"]})
        self.assertIn("192x192", {icon["sizes"] for icon in manifest["icons"]})
        self.assertIn("maskable", {icon.get("purpose") for icon in manifest["icons"]})

    def test_reader_shell_links_the_manifest_and_home_screen_icons(self) -> None:
        with urlopen(f"{self.base_url}/") as response:
            body = response.read().decode("utf-8")

        self.assertIn(f'<link rel="manifest" href="{self.base_path}/manifest.webmanifest">', body)
        self.assertIn(f'href="{self.base_path}/icons/apple-touch-icon.png"', body)
        self.assertIn('<meta name="theme-color" content="#e0b563">', body)

    def test_unversioned_assets_are_marked_no_cache_for_shared_caches(self) -> None:
        for path in ["/", "/app.js", "/app.css", "/sw.js", "/manifest.webmanifest"]:
            with self.subTest(path=path), urlopen(f"{self.base_url}{path}") as response:
                self.assertEqual(response.headers["Cache-Control"], "no-cache")

    def test_activity_reports_the_recorded_solve_duration(self) -> None:
        self.put_json(
            "/api/progress",
            {
                "problem_id": "200-basic-go-problems:24176/174140@1",
                "status": "solved",
                "duration_seconds": 42,
            },
        )

        events = self.get_json("/api/activity")["events"]

        self.assertEqual(events[0]["duration_seconds"], 42)

    def test_activity_omits_the_duration_when_none_was_reported(self) -> None:
        self.put_json(
            "/api/progress",
            {
                "problem_id": "200-basic-go-problems:24176/174140@1",
                "status": "solved",
            },
        )

        events = self.get_json("/api/activity")["events"]

        self.assertNotIn("duration_seconds", events[0])

    def test_implausible_or_non_integer_durations_are_rejected(self) -> None:
        for duration in [-1, 3601, 1.5, True, "12"]:
            with self.subTest(duration=duration):
                status, _ = self.request_json(
                    "/api/progress",
                    method="PUT",
                    data=json.dumps(
                        {
                            "problem_id": "200-basic-go-problems:24176/174140@1",
                            "status": "solved",
                            "duration_seconds": duration,
                        }
                    ).encode(),
                    headers={"Content-Type": "application/json"},
                )

                self.assertEqual(status, 400)

    def session(self, **payload: object) -> tuple[int, dict[str, object]]:
        return self.request_json(
            "/api/session",
            method="POST",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            authenticated=False,
        )

    def test_a_mistyped_name_is_reported_rather_than_quietly_created(self) -> None:
        status, response = self.session(user="Grase", password=self.TEST_PASSWORD)

        self.assertEqual(status, 404)
        self.assertIn("error", response)

        # And nothing was created behind the report.
        status, _ = self.session(user="Grase", password=self.TEST_PASSWORD)
        self.assertEqual(status, 404)

    def test_creating_a_profile_takes_an_explicit_second_request(self) -> None:
        status, response = self.session(user="Grace", password=self.TEST_PASSWORD, create=True)

        self.assertEqual(status, 200)
        self.assertIs(response["created"], True)

        status, response = self.session(user="Grace", password=self.TEST_PASSWORD)
        self.assertEqual(status, 200)
        self.assertIs(response["created"], False)

    def test_a_wrong_password_is_refused(self) -> None:
        status, response = self.session(user="Ada", password="a different password")

        self.assertEqual(status, 401)
        self.assertIn("error", response)

    def test_a_weak_password_cannot_create_a_profile(self) -> None:
        status, _ = self.session(user="Grace", password="short", create=True)

        self.assertEqual(status, 400)

    def test_authenticated_routes_refuse_an_absent_or_forged_token(self) -> None:
        for headers in [{}, {"Authorization": "Bearer nonsense"}, {"Authorization": self.token}]:
            for path in ["/api/progress", "/api/activity"]:
                with self.subTest(headers=headers, path=path):
                    status, _ = self.request_json(path, headers=headers, authenticated=False)

                    self.assertEqual(status, 401)

    def test_progress_is_scoped_to_the_token_not_to_a_requested_name(self) -> None:
        # Naming somebody else in the body must not write to their progress.
        other = self.sign_in("Grace")
        self.put_json(
            "/api/progress",
            {
                "user": "Grace",
                "problem_id": "200-basic-go-problems:24176/174140@1",
                "status": "solved",
            },
        )

        status, mine = self.request_json("/api/progress")
        self.assertEqual(status, 200)
        self.assertEqual(len(mine["problems"]), 1)

        status, theirs = self.request_json(
            "/api/progress", headers={"Authorization": f"Bearer {other}"}, authenticated=False
        )
        self.assertEqual(status, 200)
        self.assertEqual(theirs["problems"], {})

    def test_a_profile_holding_progress_must_be_claimed_before_it_can_be_logged_into(self) -> None:
        # "Ada" already has a credential from setUp, so use a name that has
        # progress written directly by the store instead.
        self.server.RequestHandlerClass.progress_store.set_status(
            "Bert", "200-basic-go-problems:24176/174140@1", "solved"
        )

        status, response = self.session(user="Bert", password=self.TEST_PASSWORD, create=True)

        self.assertEqual(status, 409)
        self.assertIn("claim", str(response["error"]).lower())

    def recorded_events(self) -> list[dict[str, object]]:
        return self.server.RequestHandlerClass.event_log.read()

    def test_sign_ins_and_rejections_are_recorded_with_their_reason(self) -> None:
        self.session(user="Grace", password=self.TEST_PASSWORD, create=True)
        self.session(user="Grace", password="a different password")
        self.session(user="Grase", password=self.TEST_PASSWORD)

        events = [
            (entry["event"], entry.get("user"), entry.get("reason"))
            for entry in self.recorded_events()
            if str(entry["event"]).startswith("session.")
        ]

        self.assertIn(("session.created", "Grace", None), events)
        self.assertIn(("session.rejected", "Grace", "AuthError"), events)
        self.assertIn(("session.rejected", "Grase", "UnknownProfileError"), events)

    def test_no_password_or_token_is_ever_written_to_the_log(self) -> None:
        self.session(user="Grace", password=self.TEST_PASSWORD, create=True)
        self.put_json(
            "/api/progress",
            {"problem_id": "200-basic-go-problems:24176/174140@1", "status": "solved"},
        )

        written = json.dumps(self.recorded_events())

        self.assertNotIn(self.TEST_PASSWORD, written)
        self.assertNotIn(self.token, written)

    def test_signing_out_is_recorded_even_though_tokens_are_stateless(self) -> None:
        status, _ = self.request_json("/api/session", method="DELETE")

        self.assertEqual(status, 200)
        self.assertIn(
            ("session.logout", "Ada"),
            [(entry["event"], entry.get("user")) for entry in self.recorded_events()],
        )

    def test_marking_a_problem_records_what_and_how_long(self) -> None:
        self.put_json(
            "/api/progress",
            {
                "problem_id": "200-basic-go-problems:24176/174140@1",
                "status": "solved",
                "duration_seconds": 31,
            },
        )

        recorded = [entry for entry in self.recorded_events() if entry["event"] == "progress.set"]

        self.assertEqual(len(recorded), 1)
        self.assertEqual(recorded[0]["user"], "Ada")
        self.assertEqual(recorded[0]["status"], "solved")
        self.assertEqual(recorded[0]["duration_seconds"], 31)

    def test_the_recorded_address_comes_from_the_proxy_header(self) -> None:
        # The socket peer is always Cloudflare, so a bare peer address would
        # make every event look like it came from the same place.
        self.request_json(
            "/api/session",
            method="DELETE",
            headers={"CF-Connecting-IP": "203.0.113.7"},
        )

        logout = [entry for entry in self.recorded_events() if entry["event"] == "session.logout"]

        self.assertEqual(logout[-1]["ip"], "203.0.113.7")

    def test_head_matches_get_routes_without_sending_a_body(self) -> None:
        for path in ["/", "/app.js", "/api/collections", "/healthz"]:
            with self.subTest(path=path):
                request = Request(f"{self.base_url}{path}", method="HEAD")
                with urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                    self.assertGreater(int(response.headers["Content-Length"]), 0)
                    self.assertEqual(response.read(), b"")

    def test_api_catalog_stays_json_and_nested_collection_path_is_not_reader_route(self) -> None:
        status, response = self.request_json("/api/collections")
        self.assertEqual(status, 200)
        self.assertIsInstance(response, list)

        for path in [
            "/collections/one/two",
            "/collections/one%2Ftwo",
            "/collections//",
            "/collections/one/",
            "/collections//1",
            "/collections/one/1/2",
        ]:
            with self.subTest(path=path):
                request = Request(f"{self.base_url}{path}")
                with self.assertRaises(HTTPError) as error:
                    urlopen(request)

                self.assertEqual(error.exception.code, 404)

    def test_collection_endpoint_returns_initial_positions(self) -> None:
        response = self.get_json("/api/collections/200-basic-go-problems")

        self.assertIsInstance(response, dict)
        self.assertEqual(response["title"], "200 Basic Go Problems")
        self.assertEqual(response["slug"], "200-basic-go-problems")
        self.assertEqual(response["problems"][0]["id"], "200-basic-go-problems:24176/174140@1")
        self.assertNotIn("moves", response["problems"][0])

    def test_removed_legacy_collection_endpoint_returns_not_found(self) -> None:
        status, response = self.request_json("/api/collection")

        self.assertEqual(status, 404)
        self.assertIn("error", response)

    def test_collection_endpoint_returns_structured_not_found_for_unknown_slug(self) -> None:
        status, response = self.request_json("/api/collections/missing")

        self.assertEqual(status, 404)
        self.assertIn("error", response)

    def test_progress_endpoint_round_trip(self) -> None:
        self.put_json(
            "/api/progress",
            {
                "problem_id": "200-basic-go-problems:24176/174140@1",
                "status": "revisit",
            },
        )

        response = self.get_json("/api/progress")

        self.assertEqual(
            response["problems"]["200-basic-go-problems:24176/174140@1"]["status"], "revisit"
        )

    def test_user_specific_responses_disable_caching(self) -> None:
        for path in ("/api/progress", "/api/activity"):
            request = Request(
                f"{self.base_url}{path}", headers={"Authorization": f"Bearer {self.token}"}
            )
            with self.subTest(path=path), urlopen(request) as response:
                self.assertEqual(response.headers["Cache-Control"], "no-store")

        request = Request(
            f"{self.base_url}/api/progress",
            data=json.dumps(
                {
                    "problem_id": "200-basic-go-problems:24176/174140@1",
                    "status": "solved",
                }
            ).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
            },
            method="PUT",
        )
        with urlopen(request) as response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_activity_endpoint_returns_limited_newest_events_with_collection_context(self) -> None:
        for status in ("solved", "revisit", "solved"):
            self.put_json(
                "/api/progress",
                {
                    "problem_id": "200-basic-go-problems:24176/174140@1",
                    "status": status,
                },
            )

        response = self.get_json("/api/activity?limit=2")

        self.assertEqual([event["status"] for event in response["events"]], ["solved", "revisit"])
        event = response["events"][0]
        self.assertEqual(event["problem_id"], "200-basic-go-problems:24176/174140@1")
        self.assertEqual(event["collection_slug"], "200-basic-go-problems")
        self.assertEqual(event["collection_title"], "200 Basic Go Problems")
        self.assertEqual(event["problem_number"], 1)
        self.assertNotIn("black", event)
        self.assertNotIn("white", event)

    def test_activity_endpoint_defaults_to_fifty_events(self) -> None:
        for index in range(55):
            self.put_json(
                "/api/progress",
                {
                    "problem_id": "200-basic-go-problems:24176/174140@1",
                    "status": "solved" if index % 2 == 0 else "revisit",
                },
            )

        response = self.get_json("/api/activity")

        self.assertEqual(len(response["events"]), 50)

    def test_activity_endpoint_rejects_invalid_queries(self) -> None:
        for path in (
            "/api/activity?user=Bert",
            "/api/activity?limit=",
            "/api/activity?limit=nope",
            "/api/activity?limit=0",
            "/api/activity?limit=101",
            "/api/activity?limit=1&limit=2",
        ):
            with self.subTest(path=path):
                status, response = self.request_json(path)

                self.assertEqual(status, 400)
                self.assertIn("error", response)

    def test_api_returns_structured_client_errors(self) -> None:
        status, response = self.request_json("/api/progress", method="PUT", data=b"{")

        self.assertEqual(status, 400)
        self.assertIn("error", response)

    def test_api_returns_structured_not_found_errors(self) -> None:
        status, response = self.request_json("/api/missing")

        self.assertEqual(status, 404)
        self.assertIn("error", response)

    def test_api_returns_server_error_for_corrupt_progress_storage(self) -> None:
        self.put_json(
            "/api/progress",
            {
                "problem_id": "200-basic-go-problems:24176/174140@1",
                "status": "solved",
            },
        )
        user_path = user_file_path(self.root / "reader-data/progress.json", "Ada")
        user_path.write_text("{")

        status, response = self.request_json("/api/progress")

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_get_returns_server_error_for_invalid_utf8_storage(self) -> None:
        user_path = user_file_path(self.root / "reader-data/progress.json", "Ada")
        user_path.parent.mkdir(parents=True)
        user_path.write_bytes(b"\xff")

        status, response = self.request_json("/api/progress")

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_put_returns_server_error_for_invalid_utf8_storage(self) -> None:
        user_path = user_file_path(self.root / "reader-data/progress.json", "Ada")
        user_path.parent.mkdir(parents=True)
        user_path.write_bytes(b"\xff")

        status, response = self.request_json(
            "/api/progress",
            method="PUT",
            data=json.dumps(
                {
                    "problem_id": "200-basic-go-problems:24176/174140@1",
                    "status": "solved",
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
        )

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_get_returns_server_error_for_malformed_nested_storage(self) -> None:
        user_path = user_file_path(self.root / "reader-data/progress.json", "Ada")
        user_path.parent.mkdir(parents=True)
        user_path.write_text(json.dumps({"user": "Ada", "problems": [], "events": []}))

        status, response = self.request_json("/api/progress")

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_put_returns_server_error_for_invalid_persisted_record(self) -> None:
        user_path = user_file_path(self.root / "reader-data/progress.json", "Ada")
        user_path.parent.mkdir(parents=True)
        user_path.write_text(
            json.dumps(
                {
                    "problems": {
                        "200-basic-go-problems:24176/174140@1": {
                            "status": "unseen",
                            "updated_at": "2026-08-23T12:00:00Z",
                        }
                    },
                    "events": [],
                }
            )
        )

        status, response = self.request_json(
            "/api/progress",
            method="PUT",
            data=json.dumps(
                {
                    "problem_id": "200-basic-go-problems:24176/174140@1",
                    "status": "solved",
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
        )

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_put_rejects_missing_or_negative_content_length(self) -> None:
        for content_length in (None, "-1"):
            with self.subTest(content_length=content_length):
                headers = [] if content_length is None else [f"Content-Length: {content_length}"]
                status, response = self.raw_put_progress(headers)

                self.assertEqual(status, 400)
                self.assertIn("error", response)

    def test_progress_put_rejects_oversized_content_length_without_reading_body(self) -> None:
        status, response = self.raw_put_progress(["Content-Length: 16385"])

        self.assertEqual(status, 413)
        self.assertIn("error", response)

    def _make_fixture_collection(self) -> None:
        books_directory = self.root / "books"
        books_directory.mkdir()
        (books_directory / "200-basic-go-problems.tex").write_text(
            "%tsumego\n"
            "\\def\\entitle{200 Basic Go Problems}\n"
            "\\def\\level{6 ky\\=u}\n"
            "\\def\\problems{%\n"
            "\\p{24176}{174140}%\n"
            "}\n"
        )

        problem_directory = self.root / "problems/200-basic-go-problems/24176"
        problem_directory.mkdir(parents=True)
        (problem_directory / "174140.sgf").write_text("(;AB[aa]AW[bb];B[cc];W[dd])")

    def get_json(self, path: str) -> dict[str, object] | list[dict[str, object]]:
        status, response = self.request_json(path)
        self.assertEqual(status, 200)
        return response

    def put_json(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        status, response = self.request_json(
            path,
            method="PUT",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        return response

    TEST_PASSWORD = "correct horse battery"

    def sign_in(self, user: str) -> str:
        status, response = self.request_json(
            "/api/session",
            method="POST",
            data=json.dumps(
                {"user": user, "password": self.TEST_PASSWORD, "create": True}
            ).encode(),
            headers={"Content-Type": "application/json"},
            authenticated=False,
        )
        self.assertEqual(status, 200, response)
        return response["token"]

    def request_json(
        self,
        path: str,
        method: str = "GET",
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        authenticated: bool = True,
    ) -> tuple[int, dict[str, object] | list[dict[str, object]]]:
        headers = dict(headers or {})
        if authenticated and getattr(self, "token", None):
            headers.setdefault("Authorization", f"Bearer {self.token}")
        request = Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urlopen(request) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def raw_put_progress(self, headers: list[str]) -> tuple[int, dict[str, object]]:
        request_lines = [
            f"PUT {self.base_path}/api/progress HTTP/1.1",
            "Host: 127.0.0.1",
            *headers,
            "",
            "",
        ]
        with socket.create_connection(
            ("127.0.0.1", self.server.server_address[1]), timeout=1
        ) as client:
            client.sendall("\r\n".join(request_lines).encode())
            client.shutdown(socket.SHUT_WR)
            response = bytearray()
            while chunk := client.recv(4096):
                response.extend(chunk)

        header, body = bytes(response).split(b"\r\n\r\n", maxsplit=1)
        status = int(header.splitlines()[0].split()[1])
        return status, json.loads(body)


class BasePathHttpApiTests(HttpApiTests):
    base_path = "/tsumego"

    def test_reader_shell_injects_prefixed_asset_and_client_paths(self) -> None:
        with urlopen(f"{self.base_url}/") as response:
            body = response.read().decode("utf-8")

        self.assertIn('href="/tsumego/app.css"', body)
        self.assertIn('src="/tsumego/app.js"', body)
        self.assertIn('window.READER_BASE_PATH = "/tsumego"', body)

    def test_unprefixed_routes_are_not_exposed_in_base_path_mode(self) -> None:
        for path in ["/", "/app.js", "/api/collections", "/healthz"]:
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                urlopen(f"{self.origin}{path}")

            self.assertEqual(error.exception.code, 404)

        request = Request(f"{self.origin}/app.js", method="HEAD")
        with self.assertRaises(HTTPError) as error:
            urlopen(request)

        self.assertEqual(error.exception.code, 404)
