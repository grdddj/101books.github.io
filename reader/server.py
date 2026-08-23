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
    properties = re.compile(r"\b(AB|AW)((?:\[[^\]]*\])+)")
    values = re.compile(r"\[([^\]]*)\]")

    for match in properties.finditer(source):
        property_name, property_values = match.groups()
        for coordinate in values.findall(property_values):
            if not re.fullmatch(r"[a-s]{2}", coordinate):
                raise ValueError(f"Invalid SGF coordinate: {coordinate}")
            stones[property_name].append(coordinate)

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
