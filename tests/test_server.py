import json
import threading
import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from reader.server import (
    ProgressStore,
    create_server,
    load_collection,
    parse_initial_stones,
)


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

    def test_progress_store_keeps_concurrent_updates(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {"24176/174139", "24176/174140"})
        original_write = store._write
        first_write_started = threading.Event()
        allow_first_write = threading.Event()
        second_update_done = threading.Event()

        def blocking_write(data: dict[str, dict[str, object]]) -> None:
            if not first_write_started.is_set():
                first_write_started.set()
                self.assertTrue(allow_first_write.wait(timeout=1))
            original_write(data)

        store._write = blocking_write  # type: ignore[method-assign]
        first_update = threading.Thread(
            target=store.set_status,
            args=("Ada", "24176/174139", "solved"),
        )
        second_update = threading.Thread(
            target=lambda: (
                store.set_status("Ada", "24176/174140", "revisit"),
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
        self.assertEqual(
            set(store.get_user("Ada")), {"24176/174139", "24176/174140"}
        )


class HttpApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self._make_fixture_collection()
        self.server = create_server(self.root, self.root / "reader-data/progress.json")
        self.server_thread = threading.Thread(target=self.server.serve_forever)
        self.server_thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join()

    def test_collection_endpoint_returns_initial_positions(self) -> None:
        response = self.get_json("/api/collection")

        self.assertEqual(response["title"], "200 Basic Go Problems")
        self.assertEqual(response["problems"][0]["id"], "24176/174140")
        self.assertNotIn("moves", response["problems"][0])

    def test_progress_endpoint_round_trip(self) -> None:
        self.put_json(
            "/api/progress",
            {"user": "Ada", "problem_id": "24176/174140", "status": "revisit"},
        )

        response = self.get_json("/api/progress?user=Ada")

        self.assertEqual(response["problems"]["24176/174140"]["status"], "revisit")

    def test_api_returns_structured_client_errors(self) -> None:
        status, response = self.request_json("/api/progress", method="PUT", data=b"{")

        self.assertEqual(status, 400)
        self.assertIn("error", response)

    def test_api_returns_structured_not_found_errors(self) -> None:
        status, response = self.request_json("/api/missing")

        self.assertEqual(status, 404)
        self.assertIn("error", response)

    def test_api_returns_server_error_for_corrupt_progress_storage(self) -> None:
        progress_path = self.root / "reader-data/progress.json"
        progress_path.parent.mkdir(parents=True)
        progress_path.write_text("{")

        status, response = self.request_json("/api/progress?user=Ada")

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_get_returns_server_error_for_invalid_utf8_storage(self) -> None:
        progress_path = self.root / "reader-data/progress.json"
        progress_path.parent.mkdir(parents=True)
        progress_path.write_bytes(b"\xff")

        status, response = self.request_json("/api/progress?user=Ada")

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_put_returns_server_error_for_invalid_utf8_storage(self) -> None:
        progress_path = self.root / "reader-data/progress.json"
        progress_path.parent.mkdir(parents=True)
        progress_path.write_bytes(b"\xff")

        status, response = self.request_json(
            "/api/progress",
            method="PUT",
            data=json.dumps(
                {"user": "Ada", "problem_id": "24176/174140", "status": "solved"}
            ).encode(),
            headers={"Content-Type": "application/json"},
        )

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def _make_fixture_collection(self) -> None:
        books_directory = self.root / "books"
        books_directory.mkdir()
        (books_directory / "200-basic-go-problems.tex").write_text(
            r"\p{24176}{174140}%"
        )

        problem_directory = self.root / "problems/200-basic-go-problems/24176"
        problem_directory.mkdir(parents=True)
        (problem_directory / "174140.sgf").write_text("(;AB[aa]AW[bb];B[cc];W[dd])")

    def get_json(self, path: str) -> dict[str, object]:
        status, response = self.request_json(path)
        self.assertEqual(status, 200)
        return response

    def put_json(self, path: str, payload: dict[str, str]) -> dict[str, object]:
        status, response = self.request_json(
            path,
            method="PUT",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        return response

    def request_json(
        self,
        path: str,
        method: str = "GET",
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, object]]:
        request = Request(
            f"{self.base_url}{path}", data=data, headers=headers or {}, method=method
        )
        try:
            with urlopen(request) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())
