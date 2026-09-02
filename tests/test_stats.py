import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from reader.stats import build_report, read_marks, render


def _stamp(day: int, hour: int = 12, minute: int = 0) -> str:
    return (
        datetime(2026, 9, day, hour, minute, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    )


class StatsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        (self.root / "users").mkdir()
        (self.root / "metrics").mkdir()
        self.now = datetime(2026, 9, 10, 20, 0, tzinfo=timezone.utc)

    def write_profile(self, user: str, events: list[dict[str, object]]) -> None:
        problems = {
            str(event["problem_id"]): {
                "status": event["status"],
                "updated_at": event["timestamp"],
            }
            for event in events
        }
        document = {"user": user, "problems": problems, "events": events}
        path = self.root / "users" / f"{user}.json"
        path.write_text(json.dumps(document), encoding="utf-8")

    def write_metrics(self, day: str, entries: list[dict[str, object]]) -> None:
        lines = "".join(json.dumps(entry) + "\n" for entry in entries)
        (self.root / "metrics" / f"{day}.jsonl").write_text(lines, encoding="utf-8")

    def report(self, days: int = 7):
        return build_report(self.root, days=days, zone=timezone.utc, now=self.now)


class MarkReadingTests(StatsTestCase):
    def test_marks_are_collected_from_every_profile_and_tagged_with_its_user(self) -> None:
        self.write_profile(
            "ada",
            [{"problem_id": "book-a:1/2@1", "status": "solved", "timestamp": _stamp(9)}],
        )
        self.write_profile(
            "bob",
            [{"problem_id": "book-b:1/2@1", "status": "revisit", "timestamp": _stamp(9)}],
        )

        marks = read_marks(self.root)

        self.assertEqual({mark.user for mark in marks}, {"ada", "bob"})
        self.assertEqual({mark.collection for mark in marks}, {"book-a", "book-b"})

    def test_a_corrupted_profile_does_not_hide_the_others(self) -> None:
        self.write_profile(
            "ada",
            [{"problem_id": "book-a:1/2@1", "status": "solved", "timestamp": _stamp(9)}],
        )
        (self.root / "users" / "broken.json").write_text("{not json", encoding="utf-8")

        self.assertEqual([mark.user for mark in read_marks(self.root)], ["ada"])

    def test_an_event_without_a_usable_timestamp_is_skipped_rather_than_raising(self) -> None:
        self.write_profile(
            "ada",
            [
                {"problem_id": "book-a:1/2@1", "status": "solved", "timestamp": "yesterday"},
                {"problem_id": "book-a:1/3@1", "status": "solved", "timestamp": _stamp(9)},
            ],
        )

        self.assertEqual(len(read_marks(self.root)), 1)

    def test_a_missing_data_directory_reads_as_no_marks(self) -> None:
        self.assertEqual(read_marks(self.root / "absent"), [])


class WindowTests(StatsTestCase):
    def test_the_window_ends_today_and_spans_the_requested_number_of_days(self) -> None:
        report = self.report(days=7)

        self.assertEqual(str(report.start), "2026-09-04")
        self.assertEqual(str(report.end), "2026-09-10")

    def test_marks_older_than_the_window_are_left_out_of_the_totals(self) -> None:
        self.write_profile(
            "ada",
            [
                {"problem_id": "book-a:1/1@1", "status": "solved", "timestamp": _stamp(3)},
                {"problem_id": "book-a:1/2@1", "status": "solved", "timestamp": _stamp(9)},
            ],
        )

        report = self.report(days=7)

        self.assertEqual(report.solved, 1)
        self.assertEqual(report.profiles[0].solved, 1)

    def test_every_day_of_the_window_is_reported_so_a_quiet_day_is_visible(self) -> None:
        self.write_profile(
            "ada",
            [{"problem_id": "book-a:1/1@1", "status": "solved", "timestamp": _stamp(10)}],
        )

        report = self.report(days=7)

        self.assertEqual(len(report.days), 7)
        self.assertEqual([day.count for day in report.days], [0, 0, 0, 0, 0, 0, 1])


class ProfileTests(StatsTestCase):
    def test_profiles_are_ranked_by_what_they_solved(self) -> None:
        self.write_profile(
            "quiet",
            [{"problem_id": "book-a:1/1@1", "status": "solved", "timestamp": _stamp(9)}],
        )
        self.write_profile(
            "busy",
            [
                {"problem_id": "book-b:1/1@1", "status": "solved", "timestamp": _stamp(9)},
                {"problem_id": "book-b:1/2@1", "status": "solved", "timestamp": _stamp(9)},
            ],
        )

        report = self.report()

        self.assertEqual([profile.user for profile in report.profiles], ["busy", "quiet"])

    def test_solved_and_revisit_are_counted_apart(self) -> None:
        self.write_profile(
            "ada",
            [
                {"problem_id": "book-a:1/1@1", "status": "solved", "timestamp": _stamp(9)},
                {"problem_id": "book-a:1/2@1", "status": "revisit", "timestamp": _stamp(9)},
            ],
        )

        (profile,) = self.report().profiles

        self.assertEqual((profile.solved, profile.revisit), (1, 1))

    def test_untimed_marks_are_excluded_from_the_median_instead_of_counting_as_zero(self) -> None:
        self.write_profile(
            "ada",
            [
                {"problem_id": "book-a:1/1@1", "status": "solved", "timestamp": _stamp(9)},
                {
                    "problem_id": "book-a:1/2@1",
                    "status": "solved",
                    "timestamp": _stamp(9),
                    "duration_seconds": 60,
                },
                {
                    "problem_id": "book-a:1/3@1",
                    "status": "solved",
                    "timestamp": _stamp(9),
                    "duration_seconds": 100,
                },
            ],
        )

        (profile,) = self.report().profiles

        self.assertEqual(profile.timed, 2)
        self.assertEqual(profile.median_seconds, 80)
        self.assertEqual(profile.seconds, 160)

    def test_active_days_count_distinct_days_not_marks(self) -> None:
        self.write_profile(
            "ada",
            [
                {"problem_id": "book-a:1/1@1", "status": "solved", "timestamp": _stamp(9, 8)},
                {"problem_id": "book-a:1/2@1", "status": "solved", "timestamp": _stamp(9, 21)},
                {"problem_id": "book-a:1/3@1", "status": "solved", "timestamp": _stamp(10)},
            ],
        )

        (profile,) = self.report().profiles

        self.assertEqual(profile.active_days, 2)

    def test_all_time_totals_survive_the_window_that_hides_them(self) -> None:
        self.write_profile(
            "ada",
            [
                {"problem_id": "book-a:1/1@1", "status": "solved", "timestamp": _stamp(1)},
                {"problem_id": "book-b:1/2@1", "status": "solved", "timestamp": _stamp(9)},
            ],
        )

        (lifetime,) = self.report().lifetime

        self.assertEqual(lifetime.solved, 2)
        self.assertEqual(lifetime.collections, 2)
        self.assertEqual(str(lifetime.first_seen.date()), "2026-09-01")


class CollectionTests(StatsTestCase):
    def test_collections_are_counted_by_the_slug_in_front_of_the_problem_id(self) -> None:
        self.write_profile(
            "ada",
            [
                {"problem_id": "tesuji-4:1/1@1", "status": "solved", "timestamp": _stamp(9)},
                {"problem_id": "tesuji-4:1/2@1", "status": "solved", "timestamp": _stamp(9)},
                {"problem_id": "endgame:1/1@1", "status": "solved", "timestamp": _stamp(9)},
            ],
        )

        report = self.report()

        self.assertEqual(report.collections[0], ("tesuji-4", 2))
        self.assertEqual(report.collections[1], ("endgame", 1))


class SessionTests(StatsTestCase):
    def test_sign_ins_new_profiles_and_rejections_come_from_the_event_log(self) -> None:
        self.write_metrics(
            "2026-09-09",
            [
                {"timestamp": _stamp(9), "event": "session.login", "user": "ada"},
                {"timestamp": _stamp(9), "event": "session.created", "user": "bob"},
                {
                    "timestamp": _stamp(9),
                    "event": "session.rejected",
                    "user": "root",
                    "ip": "203.0.113.4",
                    "reason": "UnknownProfileError",
                },
            ],
        )

        report = self.report()

        self.assertEqual(report.sign_ins["ada"], 1)
        self.assertEqual(report.sign_ins["bob"], 1)
        self.assertEqual(report.new_profiles, ["bob"])
        self.assertEqual(report.rejections[0][:2], ("203.0.113.4", 1))

    def test_events_outside_the_window_are_ignored(self) -> None:
        self.write_metrics(
            "2026-09-01",
            [{"timestamp": _stamp(1), "event": "session.login", "user": "ada"}],
        )

        self.assertEqual(self.report().sign_ins, {})


class RenderTests(StatsTestCase):
    def test_an_empty_window_renders_a_readable_note_rather_than_an_empty_table(self) -> None:
        text = render(self.report())

        self.assertIn("No problems marked", text)

    def test_every_timestamp_is_rendered_in_the_zone_the_header_names(self) -> None:
        # 22:40Z is the next day locally in CEST; a report headed (UTC) that
        # renders it as 09-02 contradicts its own day chart.
        self.write_profile(
            "ada",
            [
                {
                    "problem_id": "book-a:1/1@1",
                    "status": "solved",
                    "timestamp": _stamp(9, 22, 40),
                }
            ],
        )

        text = render(self.report())

        self.assertIn("09-09 22:40", text)
        self.assertIn("since 2026-09-09", text)

    def test_the_report_names_the_profiles_and_their_counts(self) -> None:
        self.write_profile(
            "ada",
            [
                {
                    "problem_id": "book-a:1/1@1",
                    "status": "solved",
                    "timestamp": _stamp(9),
                    "duration_seconds": 95,
                }
            ],
        )

        text = render(self.report())

        self.assertIn("ada", text)
        self.assertIn("book-a", text)
        self.assertIn("2026-09-04", text)


if __name__ == "__main__":
    unittest.main()
