import argparse
import copy
import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from urllib.parse import parse_qs, unquote, urlsplit

MAX_PROGRESS_REQUEST_BODY_BYTES = 16 * 1024


@dataclass(frozen=True)
class Problem:
    number: int
    problem_id: str
    black: list[str]
    white: list[str]


@dataclass(frozen=True)
class Collection:
    slug: str
    title: str
    category: str
    level: str
    rank: int
    problems: list[Problem]


class StorageCorruptionError(Exception):
    """Raised when the persisted progress document does not match its schema."""


class ProgressStore:
    _STATUSES: ClassVar[frozenset[str]] = frozenset({"unseen", "solved", "revisit"})

    def __init__(self, path: Path, problem_ids: set[str]) -> None:
        self.path = path
        self.problem_ids = problem_ids
        self._lock = threading.Lock()

    def get_user(self, user: str) -> dict[str, dict[str, str]]:
        user = self._validate_user(user)
        with self._lock:
            data = self._read()
            return dict(data["users"].get(user, {}).get("problems", {}))

    def set_status(self, user: str, problem_id: str, status: str) -> dict[str, dict[str, str]]:
        user = self._validate_user(user)
        if status not in self._STATUSES:
            raise ValueError(f"Invalid status: {status}")
        if problem_id not in self.problem_ids:
            raise ValueError(f"Unknown problem: {problem_id}")

        with self._lock:
            data = self._read()
            users = data["users"]
            user_data = users.setdefault(user, {"problems": {}})
            problems = user_data.setdefault("problems", {})
            if status == "unseen":
                problems.pop(problem_id, None)
            else:
                problems[problem_id] = {
                    "status": status,
                    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                }
            self._write(data)
            return dict(problems)

    def _validate_user(self, user: str) -> str:
        normalized = user.strip()
        if not normalized or len(normalized) > 80:
            raise ValueError("Invalid user")
        return normalized

    def _read(self) -> dict[str, dict[str, object]]:
        if not self.path.exists():
            return {"users": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as error:
            raise StorageCorruptionError("Progress storage is corrupted") from error

        proposed_data = copy.deepcopy(data)
        if self._migrate_legacy_200_basic_records(proposed_data):
            self._validate_data(proposed_data)
            self._write(proposed_data)
            return proposed_data
        self._validate_data(data)
        return data

    def _migrate_legacy_200_basic_records(self, data: object) -> bool:
        if not isinstance(data, dict) or set(data) != {"users"}:
            return False
        users = data["users"]
        if not isinstance(users, dict):
            return False

        prefix = "200-basic-go-problems:"
        legacy_ids = {
            problem_id.removeprefix(prefix).removesuffix("@1")
            for problem_id in self.problem_ids
            if problem_id.startswith(prefix) and problem_id.endswith("@1")
        }
        migrated = False
        for user_data in users.values():
            if not isinstance(user_data, dict) or set(user_data) != {"problems"}:
                continue
            problems = user_data["problems"]
            if not isinstance(problems, dict):
                continue
            for problem_id in list(problems):
                if not isinstance(problem_id, str):
                    continue
                if ":" in problem_id:
                    continue
                if problem_id not in legacy_ids:
                    raise StorageCorruptionError("Progress storage is corrupted")
                namespaced_id = collection_problem_id("200-basic-go-problems", problem_id, 1)
                if namespaced_id in problems:
                    raise StorageCorruptionError("Progress storage is corrupted")
                self._validate_record_data(problems[problem_id])
                problems[namespaced_id] = problems.pop(problem_id)
                migrated = True
        return migrated

    def _validate_data(self, data: object) -> None:
        if not isinstance(data, dict) or set(data) != {"users"}:
            raise StorageCorruptionError("Progress storage is corrupted")
        users = data["users"]
        if not isinstance(users, dict):
            raise StorageCorruptionError("Progress storage is corrupted")

        for user, user_data in users.items():
            if not isinstance(user, str) or not user or user != user.strip() or len(user) > 80:
                raise StorageCorruptionError("Progress storage is corrupted")
            if not isinstance(user_data, dict) or set(user_data) != {"problems"}:
                raise StorageCorruptionError("Progress storage is corrupted")
            problems = user_data["problems"]
            if not isinstance(problems, dict):
                raise StorageCorruptionError("Progress storage is corrupted")
            for problem_id, record in problems.items():
                self._validate_record(problem_id, record)

    def _validate_record(self, problem_id: object, record: object) -> None:
        if not isinstance(problem_id, str) or problem_id not in self.problem_ids:
            raise StorageCorruptionError("Progress storage is corrupted")
        self._validate_record_data(record)

    def _validate_record_data(self, record: object) -> None:
        if not isinstance(record, dict) or set(record) != {"status", "updated_at"}:
            raise StorageCorruptionError("Progress storage is corrupted")
        status = record["status"]
        timestamp = record["updated_at"]
        if not isinstance(status, str) or status not in self._STATUSES - {"unseen"}:
            raise StorageCorruptionError("Progress storage is corrupted")
        if not isinstance(timestamp, str) or not self._is_utc_timestamp(timestamp):
            raise StorageCorruptionError("Progress storage is corrupted")

    @staticmethod
    def _is_utc_timestamp(timestamp: str) -> bool:
        if not timestamp.endswith("Z"):
            return False
        try:
            parsed = datetime.fromisoformat(f"{timestamp[:-1]}+00:00")
        except ValueError:
            return False
        return parsed.tzinfo is not None and parsed.utcoffset() == timezone.utc.utcoffset(parsed)

    def _write(self, data: dict[str, dict[str, object]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                delete=False,
            ) as temporary_file:
                temporary_path = temporary_file.name
                json.dump(data, temporary_file, indent=2)
                temporary_file.write("\n")
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            Path(temporary_path).replace(self.path)
        finally:
            if temporary_path is not None:
                temporary_file_path = Path(temporary_path)
                if temporary_file_path.exists():
                    temporary_file_path.unlink()


def parse_initial_stones(source: str) -> tuple[list[str], list[str]]:
    root_properties = _parse_sgf_root_properties(source)
    stones: dict[str, list[str]] = {"AB": [], "AW": []}

    for property_name, coordinates in stones.items():
        coordinates.extend(root_properties.get(property_name, []))

    return stones["AB"], stones["AW"]


def _parse_sgf_root_properties(source: str) -> dict[str, list[str]]:
    index = 0

    def skip_whitespace() -> None:
        nonlocal index
        while index < len(source) and source[index].isspace():
            index += 1

    def read_value() -> str:
        nonlocal index
        value: list[str] = []
        index += 1
        while index < len(source):
            character = source[index]
            if character == "\\":
                if index + 1 == len(source):
                    raise ValueError("Invalid SGF escape")
                value.append(source[index + 1])
                index += 2
                continue
            if character == "]":
                index += 1
                return "".join(value)
            value.append(character)
            index += 1
        raise ValueError("Unterminated SGF property value")

    def validate_coordinates(property_name: str, values: list[str]) -> None:
        if property_name not in {"AB", "AW", "AE", "B", "W"}:
            return
        for value in values:
            if property_name in {"B", "W"} and value in {"", "tt"}:
                continue
            if not re.fullmatch(r"[a-s]{2}", value):
                raise ValueError(f"Invalid SGF coordinate: {value}")

    def parse_node() -> dict[str, list[str]]:
        nonlocal index
        index += 1
        properties: dict[str, list[str]] = {}
        while True:
            skip_whitespace()
            if index == len(source) or source[index] in ";()":
                return properties
            if source[index] not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                raise ValueError("Invalid SGF property identifier")
            property_start = index
            while index < len(source) and source[index] in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                index += 1
            property_name = source[property_start:index]
            skip_whitespace()
            if index == len(source) or source[index] != "[":
                raise ValueError("Missing SGF property value")
            values: list[str] = []
            while index < len(source) and source[index] == "[":
                values.append(read_value())
                skip_whitespace()
            validate_coordinates(property_name, values)
            properties.setdefault(property_name, []).extend(values)

    def parse_game_tree() -> dict[str, list[str]]:
        nonlocal index
        if index == len(source) or source[index] != "(":
            raise ValueError("Missing SGF game tree")
        index += 1
        skip_whitespace()
        if index == len(source) or source[index] != ";":
            raise ValueError("Missing SGF root node")
        root_properties = parse_node()
        skip_whitespace()
        while index < len(source) and source[index] == ";":
            parse_node()
            skip_whitespace()
        while index < len(source) and source[index] == "(":
            parse_game_tree()
            skip_whitespace()
        if index == len(source) or source[index] != ")":
            raise ValueError("Missing SGF closing game tree")
        index += 1
        return root_properties

    skip_whitespace()
    root_properties = parse_game_tree()
    skip_whitespace()
    if index != len(source):
        raise ValueError("Trailing content after SGF game tree")
    return root_properties


def source_collection_slug(booklet_slug: str) -> str:
    return re.sub(r"-part-\d+$", "", booklet_slug)


def collection_problem_id(slug: str, source_id: str, occurrence: int) -> str:
    return f"{slug}:{source_id}@{occurrence}"


def load_collections(repository_root: Path) -> list[Collection]:
    collections = [
        _load_collection(tex_path, repository_root)
        for tex_path in (repository_root / "books").glob("*.tex")
        if tex_path.name != "header.tex"
    ]
    return sorted(
        collections, key=lambda collection: (collection.rank, collection.title, collection.slug)
    )


def _load_collection(tex_path: Path, repository_root: Path) -> Collection:
    source = tex_path.read_text(encoding="utf-8")
    slug = tex_path.stem
    category = _required_tex_value(source, r"^%([a-z]+)\s*$", "category")
    title = _display_tex_value(_required_tex_value(source, r"^\\def\\entitle\{(.+)\}$", "title"))
    level = _display_tex_value(_required_tex_value(source, r"^\\def\\level\{(.+)\}$", "level"))
    rank = _level_rank(level)
    source_slug = source_collection_slug(slug)
    problems: list[Problem] = []
    source_occurrences: dict[str, int] = {}
    uncommented_source = "\n".join(line.split("%", maxsplit=1)[0] for line in source.splitlines())

    for number, (section, problem) in enumerate(
        re.findall(r"\\p\{(\d+)\}\{(\d+)\}", uncommented_source), start=1
    ):
        sgf_path = repository_root / "problems" / source_slug / section / f"{problem}.sgf"
        if not sgf_path.is_file():
            raise ValueError(f"Missing SGF: {sgf_path}")
        try:
            black, white = parse_initial_stones(sgf_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as error:
            raise ValueError(f"Invalid SGF: {sgf_path}") from error
        source_id = f"{section}/{problem}"
        occurrence = source_occurrences.get(source_id, 0) + 1
        source_occurrences[source_id] = occurrence
        problems.append(
            Problem(number, collection_problem_id(slug, source_id, occurrence), black, white)
        )

    return Collection(slug, title, category, level, rank, problems)


def _required_tex_value(source: str, pattern: str, name: str) -> str:
    match = re.search(pattern, source, flags=re.MULTILINE)
    if match is None:
        raise ValueError(f"Missing collection {name}")
    return match.group(1)


def _display_tex_value(value: str) -> str:
    return value.replace("~", " ").replace(r"\&", "&").replace(r"\=u", "u")


def _level_rank(level: str) -> int:
    match = re.fullmatch(r"(\d+) (kyu|dan)", level)
    if match is None:
        raise ValueError(f"Invalid collection level: {level}")
    value = int(match.group(1))
    return 20 - value if match.group(2) == "kyu" else 20 + value


class ReaderRequestHandler(SimpleHTTPRequestHandler):
    collections: list[Collection]
    progress_store: ProgressStore

    def do_GET(self) -> None:
        request = urlsplit(self.path)
        if request.path == "/api/collections":
            self._send_json(HTTPStatus.OK, self._catalog())
            return
        if request.path.startswith("/api/collections/"):
            self._get_collection(request.path.removeprefix("/api/collections/"))
            return
        if request.path == "/api/progress":
            self._get_progress(parse_qs(request.query))
            return
        if request.path.startswith("/api/"):
            self._send_error(HTTPStatus.NOT_FOUND, "Unknown route")
            return
        if re.fullmatch(r"/collections/(?:[^/]+)?", unquote(request.path)):
            self.path = "/"
        super().do_GET()

    def _catalog(self) -> list[dict[str, str | int]]:
        return [
            {
                "slug": collection.slug,
                "title": collection.title,
                "category": collection.category,
                "level": collection.level,
                "rank": collection.rank,
                "problem_count": len(collection.problems),
            }
            for collection in self.collections
        ]

    def _get_collection(self, slug: str) -> None:
        collection = next((item for item in self.collections if item.slug == slug), None)
        if collection is None:
            self._send_error(HTTPStatus.NOT_FOUND, "Unknown collection")
            return
        self._send_collection(collection)

    def _send_collection(self, collection: Collection) -> None:
        self._send_json(
            HTTPStatus.OK,
            {
                "slug": collection.slug,
                "title": collection.title,
                "problems": [
                    {
                        "number": problem.number,
                        "id": problem.problem_id,
                        "black": problem.black,
                        "white": problem.white,
                    }
                    for problem in collection.problems
                ],
            },
        )

    def do_PUT(self) -> None:
        if urlsplit(self.path).path != "/api/progress":
            self._send_error(HTTPStatus.NOT_FOUND, "Unknown route")
            return

        try:
            content_length = self._content_length()
            payload = json.loads(self.rfile.read(content_length))
            if not isinstance(payload, dict) or not all(
                isinstance(payload.get(key), str) for key in ("user", "problem_id", "status")
            ):
                raise ValueError("Invalid progress payload")
        except OverflowError:
            self._send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large")
            return
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            self._send_error(HTTPStatus.BAD_REQUEST, str(error))
            return

        try:
            problems = self.progress_store.set_status(
                payload["user"], payload["problem_id"], payload["status"]
            )
        except ValueError as error:
            self._send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except (OSError, StorageCorruptionError):
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Progress storage is unavailable")
            return

        self._send_json(HTTPStatus.OK, {"problems": problems})

    def _get_progress(self, query: dict[str, list[str]]) -> None:
        users = query.get("user", [])
        if len(users) != 1:
            self._send_error(HTTPStatus.BAD_REQUEST, "Missing user")
            return
        try:
            problems = self.progress_store.get_user(users[0])
        except ValueError as error:
            self._send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except (OSError, StorageCorruptionError):
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Progress storage is unavailable")
            return
        self._send_json(HTTPStatus.OK, {"problems": problems})

    def _content_length(self) -> int:
        header_value = self.headers.get("Content-Length")
        if header_value is None or not re.fullmatch(r"[0-9]+", header_value):
            raise ValueError("Content-Length must be a non-negative decimal integer")
        content_length = int(header_value)
        if content_length > MAX_PROGRESS_REQUEST_BODY_BYTES:
            raise OverflowError
        return content_length

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        self.log_message('"%s %s %s"', self.command, urlsplit(self.path).path, str(code))

    def _send_error(self, status: HTTPStatus, message: str) -> None:
        self._send_json(status, {"error": message})

    def _send_json(self, status: HTTPStatus, body: object) -> None:
        encoded_body = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded_body)))
        self.end_headers()
        self.wfile.write(encoded_body)


def create_server(
    repository_root: Path,
    progress_path: Path,
    host: str = "127.0.0.1",
    port: int = 0,
) -> ThreadingHTTPServer:
    collections = load_collections(repository_root)
    progress_store = ProgressStore(
        progress_path,
        {problem.problem_id for collection in collections for problem in collection.problems},
    )
    static_directory = Path(__file__).parent / "static"

    class ConfiguredReaderRequestHandler(ReaderRequestHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=static_directory, **kwargs)

    ConfiguredReaderRequestHandler.collections = collections
    ConfiguredReaderRequestHandler.progress_store = progress_store
    return ThreadingHTTPServer((host, port), ConfiguredReaderRequestHandler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--progress-file", type=Path)
    arguments = parser.parse_args()

    repository_root = Path(__file__).resolve().parents[1]
    progress_path = arguments.progress_file or repository_root / "reader-data/progress.json"
    server = create_server(repository_root, progress_path, arguments.host, arguments.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
