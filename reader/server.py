import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Problem:
    number: int
    problem_id: str
    black: list[str]
    white: list[str]


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
