import json
import socket
import threading
import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from reader.server import (
    ProgressStore,
    StorageCorruptionError,
    collection_problem_id,
    create_server,
    load_collections,
    parse_initial_stones,
    source_collection_slug,
)


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


class ProgressStoreTests(unittest.TestCase):
    problem_id = "200-basic-go-problems:24176/174139@1"
    second_problem_id = "200-basic-go-problems:24176/174140@1"

    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)

    def test_progress_store_persists_a_solved_status(self) -> None:
        path = self.root / "reader-data/progress.json"
        store = ProgressStore(path, {self.problem_id})

        result = store.set_status("Ada", self.problem_id, "solved")

        self.assertEqual(result[self.problem_id]["status"], "solved")
        saved = json.loads(path.read_text())
        self.assertEqual(
            saved["users"]["Ada"]["problems"][self.problem_id]["status"],
            "solved",
        )

    def test_progress_store_migrates_valid_200_basic_legacy_records_before_validation(self) -> None:
        path = self.root / "reader-data/progress.json"
        legacy_record = {"status": "solved", "updated_at": "2026-08-23T12:00:00Z"}
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps({"users": {"Ada": {"problems": {"24176/174139": legacy_record}}}})
        )
        store = ProgressStore(path, {self.problem_id})

        result = store.get_user("Ada")

        namespaced_id = "200-basic-go-problems:24176/174139@1"
        self.assertEqual(result, {namespaced_id: legacy_record})
        self.assertNotIn("24176/174139", json.loads(path.read_text())["users"]["Ada"]["problems"])

    def test_progress_store_rejects_unknown_legacy_records_instead_of_migrating_them(self) -> None:
        path = self.root / "reader-data/progress.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(
                {
                    "users": {
                        "Ada": {
                            "problems": {
                                "999/1": {"status": "solved", "updated_at": "2026-08-23T12:00:00Z"}
                            }
                        }
                    }
                }
            )
        )
        store = ProgressStore(path, {self.problem_id})

        with self.assertRaises(StorageCorruptionError):
            store.get_user("Ada")

    def test_progress_store_does_not_rewrite_malformed_legacy_records(self) -> None:
        path = self.root / "reader-data/progress.json"
        legacy_record = {"status": "unseen", "updated_at": "2026-08-23T12:00:00Z"}
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps({"users": {"Ada": {"problems": {"24176/174139": legacy_record}}}})
        )
        store = ProgressStore(path, {self.problem_id})

        with self.assertRaises(StorageCorruptionError):
            store.get_user("Ada")

        self.assertEqual(
            path.read_text(),
            json.dumps({"users": {"Ada": {"problems": {"24176/174139": legacy_record}}}}),
        )

    def test_progress_store_leaves_storage_unchanged_when_migration_proposal_is_invalid(
        self,
    ) -> None:
        path = self.root / "reader-data/progress.json"
        document = {
            "users": {
                "Ada": {
                    "problems": {
                        "24176/174139": {
                            "status": "solved",
                            "updated_at": "2026-08-23T12:00:00Z",
                        },
                        "unknown:1/2@1": {
                            "status": "solved",
                            "updated_at": "2026-08-23T12:00:00Z",
                        },
                    }
                }
            }
        }
        original_bytes = json.dumps(document, indent=2).encode()
        path.parent.mkdir(parents=True)
        path.write_bytes(original_bytes)
        store = ProgressStore(path, {self.problem_id})

        with self.assertRaises(StorageCorruptionError):
            store.get_user("Ada")

        self.assertEqual(path.read_bytes(), original_bytes)

    def test_progress_store_leaves_storage_unchanged_for_a_malformed_other_user(self) -> None:
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
                "Bert": {"problems": []},
            }
        }
        original_bytes = json.dumps(document, indent=2).encode()
        path.parent.mkdir(parents=True)
        path.write_bytes(original_bytes)
        store = ProgressStore(path, {self.problem_id})

        with self.assertRaises(StorageCorruptionError):
            store.get_user("Ada")

        self.assertEqual(path.read_bytes(), original_bytes)

    def test_progress_store_rejects_invalid_status_and_unknown_problem(self) -> None:
        store = ProgressStore(self.root / "progress.json", {self.problem_id})

        with self.assertRaisesRegex(ValueError, "Invalid status"):
            store.set_status("Ada", self.problem_id, "wrong")
        with self.assertRaisesRegex(ValueError, "Unknown problem"):
            store.set_status("Ada", "missing", "solved")

    def test_progress_store_validates_user_names(self) -> None:
        store = ProgressStore(self.root / "progress.json", {self.problem_id})

        for user in ("", "  Ada  ", "x" * 81):
            with self.subTest(user=user):
                if user == "  Ada  ":
                    store.set_status(user, self.problem_id, "solved")
                else:
                    with self.assertRaisesRegex(ValueError, "Invalid user"):
                        store.set_status(user, self.problem_id, "solved")

    def test_progress_store_removes_unseen_status_and_reads_saved_data(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {self.problem_id})
        store.set_status("Ada", self.problem_id, "solved")

        result = store.set_status("Ada", self.problem_id, "unseen")

        self.assertEqual(result, {})
        self.assertEqual(store.get_user("Ada"), {})
        self.assertEqual(json.loads(path.read_text())["users"]["Ada"]["problems"], {})

    def test_progress_store_records_utc_timestamp_and_reloads(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {self.problem_id})

        result = store.set_status("Ada", self.problem_id, "revisit")
        timestamp = result[self.problem_id]["updated_at"]

        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        self.assertIsNotNone(parsed.utcoffset())
        self.assertEqual(parsed.utcoffset().total_seconds(), 0)
        self.assertEqual(ProgressStore(path, {self.problem_id}).get_user("Ada"), result)

    def test_progress_store_keeps_concurrent_updates(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {self.problem_id, self.second_problem_id})
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

    def test_progress_store_rejects_corrupt_nested_schema(self) -> None:
        path = self.root / "progress.json"
        store = ProgressStore(path, {self.problem_id})
        corrupted_documents = [
            {"users": []},
            {"users": {}, "version": 1},
            {"users": {"Ada": []}},
            {"users": {" Ada": {"problems": {}}}},
            {"users": {" ": {"problems": {}}}},
            {"users": {"Ada": {}}},
            {"users": {"Ada": {"problems": {}, "extra": True}}},
            {"users": {"Ada": {"problems": []}}},
            {"users": {"Ada": {"problems": {"unknown": {}}}}},
            {
                "users": {
                    "Ada": {
                        "problems": {
                            "200-basic-go-problems:24176/174139@1": {
                                "status": "unseen",
                                "updated_at": "2026-08-23T12:00:00Z",
                            }
                        }
                    }
                }
            },
            {
                "users": {
                    "Ada": {
                        "problems": {
                            "200-basic-go-problems:24176/174139@1": {
                                "status": "solved",
                                "updated_at": "not-a-timestamp",
                            }
                        }
                    }
                }
            },
        ]

        for data in corrupted_documents:
            with self.subTest(data=data):
                path.write_text(json.dumps(data))
                with self.assertRaises(StorageCorruptionError):
                    store.get_user("Ada")


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

    def test_collections_endpoint_returns_catalog_without_positions(self) -> None:
        response = self.get_json("/api/collections")

        self.assertIsInstance(response, list)
        catalog_entry = response[0]
        self.assertEqual(catalog_entry["slug"], "200-basic-go-problems")
        self.assertEqual(catalog_entry["title"], "200 Basic Go Problems")
        self.assertEqual(catalog_entry["problem_count"], 1)
        self.assertNotIn("problems", catalog_entry)

    def test_collection_reader_path_serves_reader_shell(self) -> None:
        with urlopen(f"{self.base_url}/collections/200-basic-go-problems") as response:
            body = response.read().decode("utf-8")

        self.assertEqual(response.status, 200)
        self.assertIn('id="collection-list"', body)

    def test_api_catalog_stays_json_and_nested_collection_path_is_not_reader_route(self) -> None:
        status, response = self.request_json("/api/collections")
        self.assertEqual(status, 200)
        self.assertIsInstance(response, list)

        request = Request(f"{self.base_url}/collections/one/two")
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
                "user": "Ada",
                "problem_id": "200-basic-go-problems:24176/174140@1",
                "status": "revisit",
            },
        )

        response = self.get_json("/api/progress?user=Ada")

        self.assertEqual(
            response["problems"]["200-basic-go-problems:24176/174140@1"]["status"], "revisit"
        )

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
                {
                    "user": "Ada",
                    "problem_id": "200-basic-go-problems:24176/174140@1",
                    "status": "solved",
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
        )

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_get_returns_server_error_for_malformed_nested_storage(self) -> None:
        progress_path = self.root / "reader-data/progress.json"
        progress_path.parent.mkdir(parents=True)
        progress_path.write_text(json.dumps({"users": {"Ada": {"problems": []}}}))

        status, response = self.request_json("/api/progress?user=Ada")

        self.assertEqual(status, 500)
        self.assertIn("error", response)

    def test_progress_put_returns_server_error_for_invalid_persisted_record(self) -> None:
        progress_path = self.root / "reader-data/progress.json"
        progress_path.parent.mkdir(parents=True)
        progress_path.write_text(
            json.dumps(
                {
                    "users": {
                        "Ada": {
                            "problems": {
                                "200-basic-go-problems:24176/174140@1": {
                                    "status": "unseen",
                                    "updated_at": "2026-08-23T12:00:00Z",
                                }
                            }
                        }
                    }
                }
            )
        )

        status, response = self.request_json(
            "/api/progress",
            method="PUT",
            data=json.dumps(
                {
                    "user": "Ada",
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
    ) -> tuple[int, dict[str, object] | list[dict[str, object]]]:
        request = Request(f"{self.base_url}{path}", data=data, headers=headers or {}, method=method)
        try:
            with urlopen(request) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def raw_put_progress(self, headers: list[str]) -> tuple[int, dict[str, object]]:
        request_lines = ["PUT /api/progress HTTP/1.1", "Host: 127.0.0.1", *headers, "", ""]
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
