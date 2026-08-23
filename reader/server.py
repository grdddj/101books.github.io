import argparse
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
from urllib.parse import parse_qs, urlsplit


@dataclass(frozen=True)
class Problem:
    number: int
    problem_id: str
    black: list[str]
    white: list[str]


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
        if not self.path.is_file():
            return {"users": {}}
        data = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("users"), dict):
            raise TypeError("Invalid progress data")
        return data

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
    stones: dict[str, list[str]] = {"AB": [], "AW": []}

    def read_value(start: int) -> tuple[str, int]:
        value: list[str] = []
        index = start + 1
        while index < len(source):
            character = source[index]
            if character == "\\" and index + 1 < len(source):
                value.extend((character, source[index + 1]))
                index += 2
                continue
            if character == "]":
                return "".join(value), index + 1
            value.append(character)
            index += 1
        raise ValueError("Unterminated SGF property value")

    index = 0
    while index < len(source):
        if source[index] == "[":
            _, index = read_value(index)
            continue
        if source[index].isupper():
            property_start = index
            while index < len(source) and source[index].isupper():
                index += 1
            property_name = source[property_start:index]
            if index < len(source) and source[index] == "[":
                while index < len(source) and source[index] == "[":
                    coordinate, index = read_value(index)
                    if property_name in stones:
                        if not re.fullmatch(r"[a-s]{2}", coordinate):
                            raise ValueError(f"Invalid SGF coordinate: {coordinate}")
                        stones[property_name].append(coordinate)
                continue
        index += 1

    return stones["AB"], stones["AW"]


def load_collection(repository_root: Path) -> list[Problem]:
    source = (repository_root / "books/200-basic-go-problems.tex").read_text()
    identifiers = re.findall(r"\\p\{(\d+)\}\{(\d+)\}", source)
    problems: list[Problem] = []

    for number, (section, problem) in enumerate(identifiers, start=1):
        sgf_path = repository_root / "problems/200-basic-go-problems" / section / f"{problem}.sgf"
        if not sgf_path.is_file():
            raise ValueError(f"Missing SGF: {sgf_path}")
        black, white = parse_initial_stones(sgf_path.read_text())
        problems.append(Problem(number, f"{section}/{problem}", black, white))

    return problems


class ReaderRequestHandler(SimpleHTTPRequestHandler):
    collection: list[Problem]
    progress_store: ProgressStore

    def do_GET(self) -> None:
        request = urlsplit(self.path)
        if request.path == "/api/collection":
            self._send_json(
                HTTPStatus.OK,
                {
                    "title": "200 Basic Go Problems",
                    "problems": [
                        {
                            "number": problem.number,
                            "id": problem.problem_id,
                            "black": problem.black,
                            "white": problem.white,
                        }
                        for problem in self.collection
                    ],
                },
            )
            return
        if request.path == "/api/progress":
            self._get_progress(parse_qs(request.query))
            return
        if request.path.startswith("/api/"):
            self._send_error(HTTPStatus.NOT_FOUND, "Unknown route")
            return
        super().do_GET()

    def do_PUT(self) -> None:
        if urlsplit(self.path).path != "/api/progress":
            self._send_error(HTTPStatus.NOT_FOUND, "Unknown route")
            return

        try:
            content_length = int(self.headers.get("Content-Length", ""))
            payload = json.loads(self.rfile.read(content_length))
            if not isinstance(payload, dict) or not all(
                isinstance(payload.get(key), str) for key in ("user", "problem_id", "status")
            ):
                raise ValueError("Invalid progress payload")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            self._send_error(HTTPStatus.BAD_REQUEST, str(error))
            return

        try:
            problems = self.progress_store.set_status(
                payload["user"], payload["problem_id"], payload["status"]
            )
        except UnicodeDecodeError as error:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))
            return
        except json.JSONDecodeError as error:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))
            return
        except ValueError as error:
            self._send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except (OSError, TypeError) as error:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))
            return

        self._send_json(HTTPStatus.OK, {"problems": problems})

    def _get_progress(self, query: dict[str, list[str]]) -> None:
        users = query.get("user", [])
        if len(users) != 1:
            self._send_error(HTTPStatus.BAD_REQUEST, "Missing user")
            return
        try:
            problems = self.progress_store.get_user(users[0])
        except UnicodeDecodeError as error:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))
            return
        except json.JSONDecodeError as error:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))
            return
        except ValueError as error:
            self._send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except (OSError, TypeError) as error:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))
            return
        self._send_json(HTTPStatus.OK, {"problems": problems})

    def _send_error(self, status: HTTPStatus, message: str) -> None:
        self._send_json(status, {"error": message})

    def _send_json(self, status: HTTPStatus, body: dict[str, object]) -> None:
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
    collection = load_collection(repository_root)
    progress_store = ProgressStore(progress_path, {problem.problem_id for problem in collection})
    static_directory = Path(__file__).parent / "static"

    class ConfiguredReaderRequestHandler(ReaderRequestHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=static_directory, **kwargs)

    ConfiguredReaderRequestHandler.collection = collection
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
