import json
import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from reader.server import ProgressStore, load_collection, parse_initial_stones


class CollectionTests(unittest.TestCase):
    def make_fixture_collection(
        self, tex: str = r"\p{24176}{174140}%\p{24176}{174139}%"
    ) -> Path:
        temporary_directory = TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        fixture_root = Path(temporary_directory.name)

        books_directory = fixture_root / "books"
        books_directory.mkdir()
        (books_directory / "200-basic-go-problems.tex").write_text(tex)

        problem_directory = fixture_root / "problems/200-basic-go-problems/24176"
        problem_directory.mkdir(parents=True)
        (problem_directory / "174140.sgf").write_text("(;AB[aa]AW[bb];B[cc];W[dd])")
        (problem_directory / "174139.sgf").write_text("(;AB[cc]AW[dd];B[ee];W[ff])")

        return fixture_root

    def test_load_collection_uses_tex_order_and_initial_stones(self) -> None:
        fixture_root = self.make_fixture_collection()

        problems = load_collection(fixture_root)

        self.assertEqual(
            [(problem.number, problem.problem_id) for problem in problems],
            [(1, "24176/174140"), (2, "24176/174139")],
        )
        self.assertEqual(problems[0].black, ["aa"])
        self.assertEqual(problems[0].white, ["bb"])

    def test_load_collection_rejects_missing_sgf(self) -> None:
        fixture_root = self.make_fixture_collection(tex=r"\p{24176}{999999}%")

        with self.assertRaisesRegex(ValueError, "Missing SGF"):
            load_collection(fixture_root)

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

    def test_parse_initial_stones_treats_unescaped_open_bracket_as_comment_text(
        self,
    ) -> None:
        black, white = parse_initial_stones("(;C[hint: [ordinary text]AB[aa])")

        self.assertEqual(black, ["aa"])
        self.assertEqual(white, [])


class ProgressStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)

    def test_progress_store_persists_a_solved_status(self) -> None:
        path = self.root / "reader-data/progress.json"
        store = ProgressStore(path, {"24176/174139"})

        result = store.set_status("Ada", "24176/174139", "solved")

        self.assertEqual(result["24176/174139"]["status"], "solved")
        saved = json.loads(path.read_text())
        self.assertEqual(
            saved["users"]["Ada"]["problems"]["24176/174139"]["status"],
            "solved",
        )

    def test_progress_store_rejects_invalid_status_and_unknown_problem(self) -> None:
        store = ProgressStore(self.root / "progress.json", {"24176/174139"})

        with self.assertRaisesRegex(ValueError, "Invalid status"):
            store.set_status("Ada", "24176/174139", "wrong")
        with self.assertRaisesRegex(ValueError, "Unknown problem"):
            store.set_status("Ada", "missing", "solved")

    def test_progress_store_validates_user_names(self) -> None:
        store = ProgressStore(self.root / "progress.json", {"24176/174139"})

        for user in ("", "  Ada  ", "x" * 81):
            with self.subTest(user=user):
                if user == "  Ada  ":
                    store.set_status(user, "24176/174139", "solved")
                else:
                    with self.assertRaisesRegex(ValueError, "Invalid user"):
                        store.set_status(user, "24176/174139", "solved")

    def test_progress_store_removes_unseen_status_and_reads_saved_data(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {"24176/174139"})
        store.set_status("Ada", "24176/174139", "solved")

        result = store.set_status("Ada", "24176/174139", "unseen")

        self.assertEqual(result, {})
        self.assertEqual(store.get_user("Ada"), {})
        self.assertEqual(json.loads(path.read_text())["users"]["Ada"]["problems"], {})

    def test_progress_store_records_utc_timestamp_and_reloads(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {"24176/174139"})

        result = store.set_status("Ada", "24176/174139", "revisit")
        timestamp = result["24176/174139"]["updated_at"]

        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        self.assertIsNotNone(parsed.utcoffset())
        self.assertEqual(parsed.utcoffset().total_seconds(), 0)
        self.assertEqual(ProgressStore(path, {"24176/174139"}).get_user("Ada"), result)
