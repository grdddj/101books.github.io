import unittest
from datetime import datetime, timezone

from reader import clock


class ClockTests(unittest.TestCase):
    def test_stamps_are_written_in_prague_time(self) -> None:
        midsummer = datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)

        self.assertEqual(clock.stamp(midsummer), "2026-07-01T12:00:00.000000+02:00")

    def test_the_winter_offset_is_an_hour_not_two(self) -> None:
        midwinter = datetime(2026, 1, 15, 10, 0, tzinfo=timezone.utc)

        self.assertEqual(clock.stamp(midwinter), "2026-01-15T11:00:00.000000+01:00")

    def test_the_offset_is_always_written_out_so_the_repeated_hour_stays_readable(self) -> None:
        # 2026-10-25 02:30 happens twice in Prague; only the offset tells them apart.
        before = datetime(2026, 10, 25, 0, 30, tzinfo=timezone.utc)
        after = datetime(2026, 10, 25, 1, 30, tzinfo=timezone.utc)

        self.assertEqual(clock.stamp(before)[:19], clock.stamp(after)[:19])
        self.assertNotEqual(clock.stamp(before)[-6:], clock.stamp(after)[-6:])

    def test_a_naive_moment_is_read_as_utc_rather_than_as_wall_clock_time(self) -> None:
        self.assertEqual(
            clock.stamp(datetime(2026, 7, 1, 10, 0)),  # noqa: DTZ001 - naive is the point
            clock.stamp(datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)),
        )

    def test_now_carries_the_zone_so_arithmetic_cannot_silently_mix_zones(self) -> None:
        moment = clock.now()

        self.assertIsNotNone(moment.tzinfo)
        self.assertIn(moment.utcoffset().total_seconds(), (3600.0, 7200.0))

    def test_the_day_a_stamp_starts_with_is_the_prague_day(self) -> None:
        # 22:30 UTC is already tomorrow in Prague, and the event log files by it.
        late = datetime(2026, 7, 1, 22, 30, tzinfo=timezone.utc)

        self.assertEqual(clock.stamp(late)[:10], "2026-07-02")


if __name__ == "__main__":
    unittest.main()
