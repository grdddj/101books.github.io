import argparse
import copy
import hashlib
import json
import os
import re
import tempfile
import threading
from _thread import LockType
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, ClassVar
from urllib.parse import parse_qs, unquote, urlsplit

MAX_PROGRESS_REQUEST_BODY_BYTES = 16 * 1024
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
    _STATUSES: ClassVar[frozenset[str]] = frozenset({"unseen", "solved", "revisit"})
    _MIGRATION_VERSION: ClassVar[int] = 1

    def __init__(self, path: Path, problem_ids: set[str]) -> None:
        self.legacy_path: Path = path
        self.data_directory: Path = path.parent
        self.users_directory: Path = self.data_directory / "users"
        self.migration_marker_path: Path = self.data_directory / "progress-migration.json"
        self.problem_ids: set[str] = problem_ids
        self._user_locks: dict[str, _UserLockEntry] = {}
        self._user_locks_guard: LockType = threading.Lock()
        self._migrate_legacy_store()

    def get_user(self, user: str) -> dict[str, dict[str, str]]:
        user = self._validate_user(user)
        with self._locked_user(user):
            data = self._read_user_document(user)
            problems = data["problems"]
            if not isinstance(problems, dict):
                raise StorageCorruptionError("Progress storage is corrupted")
            return dict(problems)

    def set_status(self, user: str, problem_id: str, status: str) -> dict[str, dict[str, str]]:
        user = self._validate_user(user)
        if status not in self._STATUSES:
            raise ValueError(f"Invalid status: {status}")
        if problem_id not in self.problem_ids:
            raise ValueError(f"Unknown problem: {problem_id}")

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
                events.append({"problem_id": problem_id, "status": status, "timestamp": timestamp})
            self._write_user_document(user, data)
            return dict(problems)

    def get_activity(self, user: str, limit: int) -> list[dict[str, str]]:
        user = self._validate_user(user)
        if not 1 <= limit <= 100:
            raise ValueError("Activity limit must be between 1 and 100")
        with self._locked_user(user):
            data = self._read_user_document(user)
            events = data["events"]
            if not isinstance(events, list):
                raise StorageCorruptionError("Progress storage is corrupted")
            return [dict(event) for event in reversed(events[-limit:])]

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

    def _migrate_legacy_problem_ids(self, data: object) -> None:
        if not isinstance(data, dict) or set(data) != {"users"}:
            return
        users = data["users"]
        if not isinstance(users, dict):
            return

        prefix = "200-basic-go-problems:"
        legacy_ids = {
            problem_id.removeprefix(prefix).removesuffix("@1")
            for problem_id in self.problem_ids
            if problem_id.startswith(prefix) and problem_id.endswith("@1")
        }
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

    def _validate_legacy_data(self, data: object) -> None:
        if not isinstance(data, dict) or set(data) != {"users"}:
            raise StorageCorruptionError("Progress storage is corrupted")
        users = data["users"]
        if not isinstance(users, dict):
            raise StorageCorruptionError("Progress storage is corrupted")

        for user, user_data in users.items():
            if not isinstance(user, str) or not self._is_valid_persisted_user(user):
                raise StorageCorruptionError("Progress storage is corrupted")
            if not isinstance(user_data, dict) or set(user_data) != {"problems"}:
                raise StorageCorruptionError("Progress storage is corrupted")
            problems = user_data["problems"]
            if not isinstance(problems, dict):
                raise StorageCorruptionError("Progress storage is corrupted")
            for problem_id, record in problems.items():
                self._validate_record(problem_id, record)

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

    def _validate_event(self, event: object) -> None:
        if not isinstance(event, dict) or set(event) != {"problem_id", "status", "timestamp"}:
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

    def _migrate_legacy_store(self) -> None:
        if self.migration_marker_path.exists():
            self._resume_migration()
            return
        if not self.legacy_path.exists():
            return

        source_bytes, user_documents = self._preflight_legacy_source()
        for user in user_documents:
            if self._user_path(user).exists():
                raise StorageCorruptionError(f"Per-user progress target already exists for {user}")

        backup_path = self._write_legacy_backup(source_bytes)
        marker: dict[str, object] = {
            "version": self._MIGRATION_VERSION,
            "state": "in_progress",
            "source": self.legacy_path.name,
            "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
            "backup": backup_path.name,
            "targets": {user: self._user_path(user).name for user in user_documents},
        }
        self._atomic_write_json(self.migration_marker_path, marker)
        self._finish_migration(marker, user_documents)

    def _resume_migration(self) -> None:
        marker = self._read_json(self.migration_marker_path)
        self._validate_migration_marker(marker)
        if not isinstance(marker, dict):
            raise StorageCorruptionError("Progress storage is corrupted")
        if marker["source"] != self.legacy_path.name:
            raise StorageCorruptionError(
                "Migration marker belongs to a different legacy progress file"
            )
        if marker["state"] == "complete":
            self._validate_completed_migration_targets(marker)
            return

        source_bytes, user_documents = self._preflight_legacy_source()
        if hashlib.sha256(source_bytes).hexdigest() != marker["source_sha256"]:
            raise StorageCorruptionError("Legacy progress changed during migration")
        backup_name = marker["backup"]
        targets = marker["targets"]
        if not isinstance(backup_name, str) or not isinstance(targets, dict):
            raise StorageCorruptionError("Progress storage is corrupted")
        backup_path = self.data_directory / backup_name
        try:
            backup_bytes = backup_path.read_bytes()
        except OSError as error:
            raise StorageCorruptionError("Legacy progress backup is unavailable") from error
        if backup_bytes != source_bytes:
            raise StorageCorruptionError("Legacy progress backup does not match its source")
        expected_targets = {user: self._user_path(user).name for user in user_documents}
        if targets != expected_targets:
            raise StorageCorruptionError("Progress storage is corrupted")
        self._finish_migration(marker, user_documents)

    def _preflight_legacy_source(self) -> tuple[bytes, dict[str, dict[str, object]]]:
        try:
            source_bytes = self.legacy_path.read_bytes()
            data = json.loads(source_bytes.decode("utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as error:
            raise StorageCorruptionError("Legacy progress storage is corrupted") from error
        proposed_data = copy.deepcopy(data)
        self._migrate_legacy_problem_ids(proposed_data)
        self._validate_legacy_data(proposed_data)
        if not isinstance(proposed_data, dict) or not isinstance(proposed_data["users"], dict):
            raise StorageCorruptionError("Legacy progress storage is corrupted")

        user_documents: dict[str, dict[str, object]] = {}
        for user, legacy_user_data in proposed_data["users"].items():
            if not isinstance(user, str) or not isinstance(legacy_user_data, dict):
                raise StorageCorruptionError("Legacy progress storage is corrupted")
            problems = legacy_user_data["problems"]
            if not isinstance(problems, dict):
                raise StorageCorruptionError("Legacy progress storage is corrupted")
            events: list[dict[str, str]] = []
            for problem_id, record in problems.items():
                if not isinstance(problem_id, str) or not isinstance(record, dict):
                    raise StorageCorruptionError("Legacy progress storage is corrupted")
                status = record["status"]
                timestamp = record["updated_at"]
                if not isinstance(status, str) or not isinstance(timestamp, str):
                    raise StorageCorruptionError("Legacy progress storage is corrupted")
                events.append({"problem_id": problem_id, "status": status, "timestamp": timestamp})
            events.sort(
                key=lambda event: (
                    self._parse_utc_timestamp(event["timestamp"]),
                    event["problem_id"],
                )
            )
            user_documents[user] = {
                "user": user,
                "problems": copy.deepcopy(problems),
                "events": events,
            }
        return source_bytes, user_documents

    def _write_legacy_backup(self, source_bytes: bytes) -> Path:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        backup_path = self.data_directory / f"progress.{timestamp}.backup.json"
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=self.data_directory,
                prefix=f".{backup_path.name}.",
                delete=False,
            ) as backup_file:
                temporary_path = backup_file.name
                backup_file.write(source_bytes)
                backup_file.flush()
                os.fsync(backup_file.fileno())
            os.link(temporary_path, backup_path)
            self._sync_directory(self.data_directory)
        finally:
            if temporary_path is not None:
                Path(temporary_path).unlink(missing_ok=True)
        return backup_path

    def _validate_completed_migration_targets(self, marker: dict[str, object]) -> None:
        backup_name = marker["backup"]
        source_digest = marker["source_sha256"]
        if not isinstance(backup_name, str) or not isinstance(source_digest, str):
            raise StorageCorruptionError("Progress storage is corrupted")
        try:
            backup_bytes = (self.data_directory / backup_name).read_bytes()
        except OSError as error:
            raise StorageCorruptionError("Legacy progress backup is unavailable") from error
        if hashlib.sha256(backup_bytes).hexdigest() != source_digest:
            raise StorageCorruptionError("Legacy progress backup is corrupted")

        targets = marker["targets"]
        if not isinstance(targets, dict):
            raise StorageCorruptionError("Progress storage is corrupted")
        for user in targets:
            if not isinstance(user, str):
                raise StorageCorruptionError("Progress storage is corrupted")
            target = self._user_path(user)
            if not target.exists():
                raise StorageCorruptionError(f"Migrated progress target is missing for {user}")
            self._validate_user_document(self._read_json(target), user)

    def _finish_migration(
        self, marker: dict[str, object], user_documents: dict[str, dict[str, object]]
    ) -> None:
        for user, expected_document in user_documents.items():
            target = self._user_path(user)
            if target.exists():
                existing_document = self._read_json(target)
                self._validate_user_document(existing_document, user)
                if existing_document != expected_document:
                    raise StorageCorruptionError(
                        f"Per-user progress target does not match migration source for {user}"
                    )
                continue
            self._write_user_document(user, expected_document)
        marker["state"] = "complete"
        self._atomic_write_json(self.migration_marker_path, marker)

    def _validate_migration_marker(self, marker: object) -> None:
        if not isinstance(marker, dict) or set(marker) != {
            "version",
            "state",
            "source",
            "source_sha256",
            "backup",
            "targets",
        }:
            raise StorageCorruptionError("Progress storage is corrupted")
        if marker["version"] != self._MIGRATION_VERSION:
            raise StorageCorruptionError("Progress storage is corrupted")
        if marker["state"] not in {"in_progress", "complete"}:
            raise StorageCorruptionError("Progress storage is corrupted")
        source_name = marker["source"]
        source_digest = marker["source_sha256"]
        backup_name = marker["backup"]
        targets = marker["targets"]
        if (
            not isinstance(source_name, str)
            or not source_name
            or Path(source_name).name != source_name
        ):
            raise StorageCorruptionError("Progress storage is corrupted")
        if not isinstance(source_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", source_digest):
            raise StorageCorruptionError("Progress storage is corrupted")
        if (
            not isinstance(backup_name, str)
            or Path(backup_name).name != backup_name
            or not re.fullmatch(r"progress\.\d{8}T\d{6}\.\d{6}Z\.backup\.json", backup_name)
        ):
            raise StorageCorruptionError("Progress storage is corrupted")
        if not isinstance(targets, dict):
            raise StorageCorruptionError("Progress storage is corrupted")
        for user, filename in targets.items():
            if not isinstance(user, str) or not self._is_valid_persisted_user(user):
                raise StorageCorruptionError("Progress storage is corrupted")
            if not isinstance(filename, str) or filename != self._user_path(user).name:
                raise StorageCorruptionError("Progress storage is corrupted")


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


class ReaderRequestHandler(SimpleHTTPRequestHandler):
    collections: ClassVar[list[Collection]]
    activity_context: ClassVar[dict[str, tuple[str, str, int]]]
    progress_store: ClassVar[ProgressStore]
    base_path: ClassVar[str]
    static_directory: ClassVar[Path]
    send_response_body = True

    def do_GET(self) -> None:
        self._handle_read()

    def do_HEAD(self) -> None:
        self.send_response_body = False
        self._handle_read()

    def _handle_read(self) -> None:
        request = urlsplit(self.path)
        path = self._strip_base_path(request.path)
        if path is None:
            self._send_error(HTTPStatus.NOT_FOUND, "Unknown route")
            return
        if path == "/healthz":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if path == "/api/collections":
            self._send_json(HTTPStatus.OK, self._catalog())
            return
        if path.startswith("/api/collections/"):
            self._get_collection(path.removeprefix("/api/collections/"))
            return
        if path == "/api/progress":
            self._get_progress(parse_qs(request.query, keep_blank_values=True))
            return
        if path == "/api/activity":
            self._get_activity(parse_qs(request.query, keep_blank_values=True))
            return
        if path.startswith("/api/"):
            self._send_error(HTTPStatus.NOT_FOUND, "Unknown route")
            return
        if (
            path == "/"
            or path == "/index.html"
            or re.fullmatch(r"/collections/(?:[^/]+)?", unquote(path))
        ):
            self._send_reader_shell()
            return
        self.path = path
        if self.send_response_body:
            super().do_GET()
        else:
            super().do_HEAD()

    def _strip_base_path(self, path: str) -> str | None:
        if not self.base_path:
            return path
        if path == self.base_path:
            return "/"
        if not path.startswith(f"{self.base_path}/"):
            return None
        return path.removeprefix(self.base_path)

    def _send_reader_shell(self) -> None:
        try:
            source = (self.static_directory / "index.html").read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Reader shell is unavailable")
            return
        encoded_body = source.replace("__READER_BASE_PATH__", self.base_path).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded_body)))
        self.end_headers()
        if self.send_response_body:
            self.wfile.write(encoded_body)

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
        request_path = urlsplit(self.path).path
        if self._strip_base_path(request_path) != "/api/progress":
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

        self._send_json(HTTPStatus.OK, {"problems": problems}, cache_control="no-store")

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
        self._send_json(HTTPStatus.OK, {"problems": problems}, cache_control="no-store")

    def _get_activity(self, query: dict[str, list[str]]) -> None:
        if not set(query) <= {"user", "limit"}:
            self._send_error(HTTPStatus.BAD_REQUEST, "Invalid activity query")
            return
        users = query.get("user", [])
        limits = query.get("limit", [])
        if len(users) != 1:
            self._send_error(HTTPStatus.BAD_REQUEST, "Missing user")
            return
        if len(limits) > 1:
            self._send_error(HTTPStatus.BAD_REQUEST, "Invalid activity limit")
            return
        try:
            limit = 50 if not limits else self._parse_activity_limit(limits[0])
            events = self.progress_store.get_activity(users[0], limit)
        except ValueError as error:
            self._send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except (OSError, StorageCorruptionError):
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Progress storage is unavailable")
            return

        enriched_events: list[dict[str, str | int]] = []
        for event in events:
            collection_slug, collection_title, problem_number = self.activity_context[
                event["problem_id"]
            ]
            enriched_events.append(
                {
                    **event,
                    "collection_slug": collection_slug,
                    "collection_title": collection_title,
                    "problem_number": problem_number,
                }
            )
        self._send_json(HTTPStatus.OK, {"events": enriched_events}, cache_control="no-store")

    @staticmethod
    def _parse_activity_limit(value: str) -> int:
        if not re.fullmatch(r"[0-9]+", value):
            raise ValueError("Invalid activity limit")
        limit = int(value)
        if not 1 <= limit <= 100:
            raise ValueError("Activity limit must be between 1 and 100")
        return limit

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

    def _send_json(
        self, status: HTTPStatus, body: object, *, cache_control: str | None = None
    ) -> None:
        encoded_body = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded_body)))
        if cache_control is not None:
            self.send_header("Cache-Control", cache_control)
        self.end_headers()
        if self.send_response_body:
            self.wfile.write(encoded_body)


def create_server(
    repository_root: Path,
    progress_path: Path,
    host: str = "127.0.0.1",
    port: int = 0,
    base_path: str = "",
) -> ThreadingHTTPServer:
    normalized_base_path = normalize_base_path(base_path)
    collections = load_collections(repository_root)
    progress_store = ProgressStore(
        progress_path,
        {problem.problem_id for collection in collections for problem in collection.problems},
    )
    static_directory = Path(__file__).parent / "static"

    class ConfiguredReaderRequestHandler(ReaderRequestHandler):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, directory=static_directory, **kwargs)

    ConfiguredReaderRequestHandler.collections = collections
    ConfiguredReaderRequestHandler.activity_context = {
        problem.problem_id: (collection.slug, collection.title, problem.number)
        for collection in collections
        for problem in collection.problems
    }
    ConfiguredReaderRequestHandler.progress_store = progress_store
    ConfiguredReaderRequestHandler.base_path = normalized_base_path
    ConfiguredReaderRequestHandler.static_directory = static_directory
    return ThreadingHTTPServer((host, port), ConfiguredReaderRequestHandler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    storage_arguments = parser.add_mutually_exclusive_group()
    storage_arguments.add_argument("--progress-file", type=Path)
    storage_arguments.add_argument("--data-dir", type=Path)
    parser.add_argument("--base-path", default="")
    arguments = parser.parse_args()

    repository_root = Path(__file__).resolve().parents[1]
    progress_path = (
        arguments.progress_file
        or (arguments.data_dir / "progress.json" if arguments.data_dir else None)
        or repository_root / "reader-data/progress.json"
    )
    try:
        base_path = normalize_base_path(arguments.base_path)
    except ValueError as error:
        parser.error(str(error))
    server = create_server(
        repository_root,
        progress_path,
        arguments.host,
        arguments.port,
        base_path,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
