import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from reader.stats import (
    build_profile_report,
    build_report,
    read_marks,
    render,
    render_profile,
    report_payload,
)


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

    def test_the_clock_defaults_to_now_the_way_the_command_line_calls_it(self) -> None:
        # The CLI passes no `now`; every other test does, which is how a crash
        # on the default path reached a release.
        for zone in (timezone.utc, None):
            with self.subTest(zone=zone):
                report = build_report(self.root, days=7, zone=zone)

                self.assertTrue(report.zone_label)
                self.assertEqual((report.end - report.start).days, 6)

    def test_offset_stamps_are_read_alongside_the_older_utc_ones(self) -> None:
        # The event log moved to Prague time mid-history; both spellings of the
        # same evening have to land on the same day.
        self.write_profile(
            "ada",
            [
                {
                    "problem_id": "book-a:1/1@1",
                    "status": "solved",
                    "timestamp": "2026-09-09T12:00:00.000000Z",
                },
                {
                    "problem_id": "book-a:1/2@1",
                    "status": "solved",
                    "timestamp": "2026-09-09T23:30:00.000000+02:00",
                },
            ],
        )

        report = self.report(days=7)

        self.assertEqual(report.solved, 2)
        self.assertEqual(report.days[-2].count, 2)


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


class AllTimeWindowTests(StatsTestCase):
    def test_days_zero_starts_at_the_first_day_with_data_rather_than_at_today(self) -> None:
        self.write_profile(
            "ada",
            [{"problem_id": "book-a:1/1@1", "status": "solved", "timestamp": _stamp(2)}],
        )

        report = self.report(days=0)

        self.assertEqual(str(report.start), "2026-09-02")
        self.assertEqual(str(report.end), "2026-09-10")

    def test_an_empty_data_directory_still_yields_a_single_day_window(self) -> None:
        report = self.report(days=0)

        self.assertEqual(report.start, report.end)


class ProfileReportTests(StatsTestCase):
    def solving(self, day: int, hour: int, minute: int, number: int, duration: int = 60):
        return {
            "problem_id": f"book-a:1/{number}@1",
            "status": "solved",
            "timestamp": _stamp(day, hour, minute),
            "duration_seconds": duration,
        }

    def profile_report(self, user: str = "ada", days: int = 7):
        return build_profile_report(self.root, user, days=days, zone=timezone.utc, now=self.now)

    def test_an_unknown_name_is_reported_rather_than_rendered_as_an_empty_page(self) -> None:
        self.write_profile("ada", [self.solving(9, 12, 0, 1)])

        self.assertIsNone(self.profile_report("nobody"))

    def test_a_name_typed_in_the_wrong_case_still_finds_the_profile(self) -> None:
        self.write_profile("Magic", [self.solving(9, 12, 0, 1)])

        report = self.profile_report("magic")

        self.assertIsNotNone(report)
        self.assertEqual(report.user, "Magic")

    def test_a_refused_sign_in_in_another_case_does_not_make_the_real_name_ambiguous(
        self,
    ) -> None:
        self.write_profile("Magic", [self.solving(9, 12, 0, 1)])
        self.write_metrics(
            "2026-09-09",
            [
                {
                    "timestamp": _stamp(9),
                    "event": "session.rejected",
                    "user": "magic",
                    "ip": "203.0.113.4",
                }
            ],
        )

        report = self.profile_report("MAGIC")

        self.assertIsNotNone(report)
        self.assertEqual(report.user, "Magic")

    def test_marks_close_together_are_one_sitting_and_a_long_gap_starts_another(self) -> None:
        self.write_profile(
            "ada",
            [
                self.solving(9, 12, 0, 1),
                self.solving(9, 12, 20, 2),
                self.solving(9, 18, 0, 3),
            ],
        )

        report = self.profile_report()

        self.assertEqual([sitting.count for sitting in report.sittings], [2, 1])
        self.assertEqual(report.sittings[0].seconds, 120)

    def test_the_window_hides_older_marks_but_the_lifetime_line_keeps_them(self) -> None:
        self.write_profile("ada", [self.solving(2, 12, 0, 1), self.solving(9, 12, 0, 2)])

        report = self.profile_report(days=7)

        self.assertEqual(len(report.marks), 1)
        self.assertEqual(report.lifetime.solved, 2)

    def test_the_fastest_and_slowest_marks_ignore_the_untimed_ones(self) -> None:
        self.write_profile(
            "ada",
            [
                {"problem_id": "book-a:1/9@1", "status": "solved", "timestamp": _stamp(9, 9, 0)},
                self.solving(9, 12, 0, 1, duration=30),
                self.solving(9, 12, 1, 2, duration=200),
            ],
        )

        report = self.profile_report()

        self.assertEqual((report.fastest, report.slowest), (30, 200))

    def test_the_rendered_page_names_the_profile_its_marks_and_its_sittings(self) -> None:
        self.write_profile("ada", [self.solving(9, 12, 0, 7)])

        text = render_profile(self.profile_report())

        self.assertIn("ada", text)
        self.assertIn("book-a:1/7@1", text)
        self.assertIn("sittings", text)


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


class PayloadTests(StatsTestCase):
    """The shape the admin panel is rendered from."""

    def solved(self, day: int, hour: int, problem: int, seconds: int) -> dict[str, object]:
        return {
            "problem_id": f"book-a:1/{problem}@1",
            "status": "solved",
            "timestamp": _stamp(day, hour),
            "duration_seconds": seconds,
        }

    def payload(self, days: int = 7) -> dict[str, object]:
        return report_payload(self.report(days=days))

    def test_the_window_totals_and_profiles_are_carried_over(self) -> None:
        self.write_profile("ada", [self.solved(9, 12, 1, 30), self.solved(10, 9, 2, 90)])

        payload = self.payload()

        self.assertEqual(payload["window"]["start"], "2026-09-04")
        self.assertEqual(payload["window"]["end"], "2026-09-10")
        self.assertEqual(payload["window"]["days"], 7)
        self.assertEqual(payload["totals"]["solved"], 2)
        self.assertEqual(payload["totals"]["profiles"], 1)
        self.assertEqual(payload["profiles"][0]["user"], "ada")
        self.assertEqual(payload["profiles"][0]["solved"], 2)
        self.assertEqual(payload["profiles"][0]["duration"], "2m00s")

    def test_nothing_about_sessions_or_addresses_is_exposed(self) -> None:
        # The panel reports usage; sign-ins, refused logins and the addresses
        # they came from stay in the terminal report.
        self.write_profile("ada", [self.solved(9, 12, 1, 30)])
        self.write_metrics(
            "2026-09-09",
            [
                {"event": "session.login", "user": "ada", "timestamp": _stamp(9), "ip": "1.2.3.4"},
                {
                    "event": "session.rejected",
                    "user": "mallory",
                    "timestamp": _stamp(9),
                    "ip": "9.9.9.9",
                    "reason": "AuthError",
                },
            ],
        )

        serialized = json.dumps(self.payload())

        self.assertNotIn("9.9.9.9", serialized)
        self.assertNotIn("rejected", serialized)
        self.assertNotIn("sign_ins", serialized)

    def test_every_day_of_the_window_is_labelled_for_display(self) -> None:
        self.write_profile("ada", [self.solved(10, 12, 1, 30)])

        days = self.payload()["days"]

        self.assertEqual(len(days), 7)
        self.assertEqual(days[-1]["date"], "2026-09-10")
        self.assertEqual(days[-1]["label"], "Thu 09-10")
        self.assertEqual(days[-1]["count"], 1)
        self.assertEqual(days[-1]["by_user"], [{"user": "ada", "count": 1}])

    def test_the_hour_histogram_keeps_all_twenty_four_slots(self) -> None:
        self.write_profile("ada", [self.solved(9, 12, 1, 30)])

        hours = self.payload()["hours"]

        self.assertEqual(len(hours), 24)
        self.assertEqual(hours[12], 1)
        self.assertEqual(sum(hours), 1)

    def test_collections_and_lifetime_totals_are_included(self) -> None:
        self.write_profile("ada", [self.solved(9, 12, 1, 30)])

        payload = self.payload()

        self.assertEqual(payload["collections"], [{"slug": "book-a", "count": 1}])
        self.assertEqual(payload["lifetime"][0]["user"], "ada")
        self.assertEqual(payload["lifetime"][0]["since"], "2026-09-09")

    def test_timestamps_are_formatted_in_the_zone_the_window_names(self) -> None:
        self.write_profile("ada", [self.solved(9, 22, 1, 30)])

        payload = self.payload()

        self.assertEqual(payload["window"]["zone"], "UTC")
        self.assertEqual(payload["profiles"][0]["last_mark"], "09-09 22:00")

    def test_an_empty_window_still_yields_every_section(self) -> None:
        payload = self.payload()

        self.assertEqual(payload["totals"]["solved"], 0)
        self.assertEqual(payload["profiles"], [])
        self.assertEqual(len(payload["days"]), 7)
        self.assertEqual(payload["collections"], [])
        self.assertEqual(payload["lifetime"], [])


if __name__ == "__main__":
    unittest.main()
