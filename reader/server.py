import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar


@dataclass(frozen=True)
class Problem:
    number: int
    problem_id: str
    black: list[str]
    white: list[str]


class ProgressStore:
    _STATUSES: ClassVar[frozenset[str]] = frozenset(
        {"unseen", "solved", "revisit"}
    )

    def __init__(self, path: Path, problem_ids: set[str]) -> None:
        self.path = path
        self.problem_ids = problem_ids

    def get_user(self, user: str) -> dict[str, dict[str, str]]:
        user = self._validate_user(user)
        data = self._read()
        return dict(data["users"].get(user, {}).get("problems", {}))

    def set_status(
        self, user: str, problem_id: str, status: str
    ) -> dict[str, dict[str, str]]:
        user = self._validate_user(user)
        if status not in self._STATUSES:
            raise ValueError(f"Invalid status: {status}")
        if problem_id not in self.problem_ids:
            raise ValueError(f"Unknown problem: {problem_id}")

        data = self._read()
        users = data["users"]
        user_data = users.setdefault(user, {"problems": {}})
        problems = user_data.setdefault("problems", {})
        if status == "unseen":
            problems.pop(problem_id, None)
        else:
            problems[problem_id] = {
                "status": status,
                "updated_at": datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
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
        data = json.loads(self.path.read_text())
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
        sgf_path = (
            repository_root
            / "problems/200-basic-go-problems"
            / section
            / f"{problem}.sgf"
        )
        if not sgf_path.is_file():
            raise ValueError(f"Missing SGF: {sgf_path}")
        black, white = parse_initial_stones(sgf_path.read_text())
        problems.append(Problem(number, f"{section}/{problem}", black, white))

    return problems
