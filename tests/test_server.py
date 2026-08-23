import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from reader.server import load_collection, parse_initial_stones


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
        source = r"(;C[hint: AB[tt] AW[uu] and escaped \[brackets\]]AB[aa][bb]AW[cc][dd])"

        black, white = parse_initial_stones(source)

        self.assertEqual(black, ["aa", "bb"])
        self.assertEqual(white, ["cc", "dd"])

    def test_parse_initial_stones_rejects_invalid_setup_coordinate(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid SGF coordinate: tt"):
            parse_initial_stones("(;AB[tt])")
