import hashlib
import json
import os
import re
import socket
import tempfile
import threading
from _thread import LockType
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, ClassVar

import typer
import uvicorn

from reader.auth import AuthStore
from reader.logs import configure_logging
from reader.metrics import EventLog

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MAX_PROGRESS_REQUEST_BODY_BYTES = 16 * 1024
# A problem left open overnight says nothing about how long it was worked on,
# so anything beyond an hour is rejected rather than recorded.
MAX_PROBLEM_DURATION_SECONDS = 3600
BASE_PATH_PATTERN = re.compile(r"(?:/[A-Za-z0-9._~-]+)+")


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


@dataclass
class _UserLockEntry:
    lock: LockType
    references: int = 0


class ProgressStore:
    """One JSON document per profile, under `<data-directory>/users/`."""

    _STATUSES: ClassVar[frozenset[str]] = frozenset({"unseen", "solved", "revisit"})

    def __init__(self, data_directory: Path, problem_ids: set[str]) -> None:
        self.data_directory: Path = data_directory
        self.users_directory: Path = data_directory / "users"
        self.problem_ids: set[str] = problem_ids
        self._user_locks: dict[str, _UserLockEntry] = {}
        self._user_locks_guard: LockType = threading.Lock()

    def get_user(self, user: str) -> dict[str, dict[str, str]]:
        user = self._validate_user(user)
        with self._locked_user(user):
            data = self._read_user_document(user)
            problems = data["problems"]
            if not isinstance(problems, dict):
                raise StorageCorruptionError("Progress storage is corrupted")
            return dict(problems)

    def set_status(
        self,
        user: str,
        problem_id: str,
        status: str,
        duration_seconds: int | None = None,
    ) -> dict[str, dict[str, str]]:
        user = self._validate_user(user)
        if status not in self._STATUSES:
            raise ValueError(f"Invalid status: {status}")
        if problem_id not in self.problem_ids:
            raise ValueError(f"Unknown problem: {problem_id}")
        if (
            duration_seconds is not None
            and not 0 <= duration_seconds <= MAX_PROBLEM_DURATION_SECONDS
        ):
            raise ValueError("Invalid duration")

        with self._locked_user(user):
            data = self._read_user_document(user)
            problems = data["problems"]
            events = data["events"]
            if not isinstance(problems, dict) or not isinstance(events, list):
                raise StorageCorruptionError("Progress storage is corrupted")
            if status == "unseen":
                problems.pop(problem_id, None)
            else:
                timestamp = self._utc_now()
                problems[problem_id] = {
                    "status": status,
                    "updated_at": timestamp,
                }
                event: dict[str, str | int] = {
                    "problem_id": problem_id,
                    "status": status,
                    "timestamp": timestamp,
                }
                # Older events predate timing and stay without the key rather
                # than claiming a duration of zero.
                if duration_seconds is not None:
                    event["duration_seconds"] = duration_seconds
                events.append(event)
            self._write_user_document(user, data)
            return dict(problems)

    def get_activity(self, user: str, limit: int) -> list[dict[str, str | int]]:
        user = self._validate_user(user)
        if not 1 <= limit <= 100:
            raise ValueError("Activity limit must be between 1 and 100")
        with self._locked_user(user):
            data = self._read_user_document(user)
            events = data["events"]
            if not isinstance(events, list):
                raise StorageCorruptionError("Progress storage is corrupted")
            return [dict(event) for event in reversed(events[-limit:])]

    def normalize_user(self, user: object) -> str:
        # An empty name is invalid, so a non-string reaches the same rejection.
        return self._validate_user(user if isinstance(user, str) else "")

    def _validate_user(self, user: str) -> str:
        normalized = user.strip()
        if not self._is_valid_persisted_user(normalized):
            raise ValueError("Invalid user")
        return normalized

    @contextmanager
    def _locked_user(self, user: str) -> Generator[None, None, None]:
        with self._user_locks_guard:
            entry = self._user_locks.get(user)
            if entry is None:
                entry = _UserLockEntry(threading.Lock())
                self._user_locks[user] = entry
            entry.references += 1
        try:
            with entry.lock:
                yield
        finally:
            with self._user_locks_guard:
                entry.references -= 1
                if entry.references == 0:
                    del self._user_locks[user]

    def has_user(self, user: str) -> bool:
        return self._user_path(self._validate_user(user)).exists()

    def _user_path(self, user: str) -> Path:
        digest = hashlib.sha256(user.encode("utf-8")).hexdigest()
        return self.users_directory / f"{digest}.json"

    def _read_user_document(self, user: str) -> dict[str, object]:
        path = self._user_path(user)
        if not path.exists():
            return {"user": user, "problems": {}, "events": []}
        data = self._read_json(path)
        self._validate_user_document(data, user)
        if not isinstance(data, dict):
            raise StorageCorruptionError("Progress storage is corrupted")
        return data

    def _read_json(self, path: Path) -> object:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as error:
            raise StorageCorruptionError("Progress storage is corrupted") from error

    def _validate_user_document(self, data: object, expected_user: str) -> None:
        if not isinstance(data, dict) or set(data) != {"user", "problems", "events"}:
            raise StorageCorruptionError("Progress storage is corrupted")
        if data["user"] != expected_user:
            raise StorageCorruptionError("Progress storage is corrupted")
        problems = data["problems"]
        events = data["events"]
        if not isinstance(problems, dict) or not isinstance(events, list):
            raise StorageCorruptionError("Progress storage is corrupted")
        for problem_id, record in problems.items():
            self._validate_record(problem_id, record)
        for event in events:
            self._validate_event(event)

    _REQUIRED_EVENT_KEYS: ClassVar[set[str]] = {"problem_id", "status", "timestamp"}

    def _validate_event(self, event: object) -> None:
        if not isinstance(event, dict):
            raise StorageCorruptionError("Progress storage is corrupted")
        # duration_seconds is optional because events recorded before timing
        # existed do not carry it.
        keys = set(event)
        if (
            not self._REQUIRED_EVENT_KEYS
            <= keys
            <= self._REQUIRED_EVENT_KEYS | {"duration_seconds"}
        ):
            raise StorageCorruptionError("Progress storage is corrupted")
        if "duration_seconds" in event:
            duration = event["duration_seconds"]
            if (
                isinstance(duration, bool)
                or not isinstance(duration, int)
                or not 0 <= duration <= MAX_PROBLEM_DURATION_SECONDS
            ):
                raise StorageCorruptionError("Progress storage is corrupted")
        problem_id = event["problem_id"]
        status = event["status"]
        timestamp = event["timestamp"]
        if not isinstance(problem_id, str) or problem_id not in self.problem_ids:
            raise StorageCorruptionError("Progress storage is corrupted")
        if not isinstance(status, str) or status not in self._STATUSES - {"unseen"}:
            raise StorageCorruptionError("Progress storage is corrupted")
        if not isinstance(timestamp, str) or not self._is_utc_timestamp(timestamp):
            raise StorageCorruptionError("Progress storage is corrupted")

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
            parsed = ProgressStore._parse_utc_timestamp(timestamp)
        except ValueError:
            return False
        return parsed.tzinfo is not None and parsed.utcoffset() == timezone.utc.utcoffset(parsed)

    @staticmethod
    def _parse_utc_timestamp(timestamp: str) -> datetime:
        return datetime.fromisoformat(f"{timestamp[:-1]}+00:00")

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _is_valid_persisted_user(user: str) -> bool:
        if not user or user != user.strip() or len(user) > 80:
            return False
        try:
            user.encode("utf-8")
        except UnicodeEncodeError:
            return False
        return True

    def _write_user_document(self, user: str, data: dict[str, object]) -> None:
        self._atomic_write_json(self._user_path(user), data)

    def _atomic_write_json(self, path: Path, data: object) -> None:
        self._ensure_directory(path.parent)
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=path.parent,
                prefix=f".{path.name}.",
                delete=False,
            ) as temporary_file:
                temporary_path = temporary_file.name
                json.dump(data, temporary_file, indent=2)
                temporary_file.write("\n")
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            Path(temporary_path).replace(path)
            self._sync_directory(path.parent)
        finally:
            if temporary_path is not None:
                temporary_file_path = Path(temporary_path)
                if temporary_file_path.exists():
                    temporary_file_path.unlink()

    def _ensure_directory(self, path: Path) -> None:
        missing_directories: list[Path] = []
        current = path
        while not current.exists():
            missing_directories.append(current)
            current = current.parent
        path.mkdir(parents=True, exist_ok=True)
        for directory in reversed(missing_directories):
            self._sync_directory(directory.parent)

    @staticmethod
    def _sync_directory(path: Path) -> None:
        directory_descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)


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


def normalize_base_path(base_path: str) -> str:
    normalized = base_path.strip()
    if normalized in {"", "/"}:
        return ""
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    normalized = normalized.rstrip("/")
    if not BASE_PATH_PATTERN.fullmatch(normalized):
        raise ValueError("Base path must contain only safe URL path segments")
    if any(segment in {".", ".."} for segment in normalized.split("/")):
        raise ValueError("Base path cannot contain dot segments")
    return normalized


class ReaderServer:
    """Uvicorn behind the small server surface the reader was built against.

    The listening socket is bound here rather than by uvicorn so that `port=0`
    still tells the caller which port it was given before anything serves, and
    so `shutdown()` can wait for the loop to actually stop.
    """

    def __init__(
        self,
        app: object,
        host: str,
        port: int,
        event_log: EventLog,
        progress_store: "ProgressStore",
    ) -> None:
        # The log and the store are the server's state; everything else about a
        # request lives inside the app.
        self.event_log = event_log
        self.progress_store = progress_store
        self._socket = socket.create_server((host, port))
        self.server_address: tuple[str, int] = self._socket.getsockname()
        # log_config=None: uvicorn's own dictConfig detaches its loggers from
        # the root logger, which is exactly where the file handler lives.
        self._server = uvicorn.Server(uvicorn.Config(app, log_level="info", log_config=None))
        self._stopped = threading.Event()

    def serve_forever(self) -> None:
        try:
            self._server.run(sockets=[self._socket])
        finally:
            self._stopped.set()

    def shutdown(self) -> None:
        self._server.should_exit = True
        self._stopped.wait(timeout=30)

    def server_close(self) -> None:
        self._socket.close()


def create_server(
    repository_root: Path,
    data_directory: Path,
    host: str = "127.0.0.1",
    port: int = 0,
    base_path: str = "",
) -> ReaderServer:
    # Imported here because reader.api reads the catalog and storage types out
    # of this module; at module scope the two would import each other.
    from reader.api import create_app

    normalized_base_path = normalize_base_path(base_path)
    configure_logging(data_directory)
    collections = load_collections(repository_root)
    progress_store = ProgressStore(
        data_directory,
        {problem.problem_id for collection in collections for problem in collection.problems},
    )
    event_log = EventLog(data_directory)
    app = create_app(
        collections=collections,
        activity_context={
            problem.problem_id: (collection.slug, collection.title, problem.number)
            for collection in collections
            for problem in collection.problems
        },
        progress_store=progress_store,
        auth_store=AuthStore(data_directory),
        event_log=event_log,
        base_path=normalized_base_path,
        static_directory=Path(__file__).parent / "static",
        max_request_body_bytes=MAX_PROGRESS_REQUEST_BODY_BYTES,
    )
    return ReaderServer(app, host, port, event_log, progress_store)


# One command, so typer collapses it: `python -m reader.server --port 8123`
# stays the invocation, with no subcommand to name.
cli = typer.Typer(add_completion=False)


def checked_base_path(value: str) -> str:
    """Reject an unsafe prefix while parsing, rather than after the scan."""
    try:
        return normalize_base_path(value)
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error


@cli.command()
def serve(
    host: Annotated[str, typer.Option(help="Address to listen on.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port to listen on.")] = 8000,
    data_dir: Annotated[
        Path,
        typer.Option(help="Profiles, credentials, the event log and the log file."),
    ] = REPOSITORY_ROOT / "reader-data",
    base_path: Annotated[
        str,
        typer.Option(
            callback=checked_base_path,
            help="URL prefix to serve under, with or without its slashes.",
        ),
    ] = "",
) -> None:
    """Serve the Go problem reader."""
    server = create_server(REPOSITORY_ROOT, data_dir, host, port, base_path)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    cli()


if __name__ == "__main__":
    main()
