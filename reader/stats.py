"""Usage summary over the reader's own data directory.

Two sources answer two different questions and neither replaces the other:
`users/*.json` holds every problem ever marked, with durations, and reaches
back before the event log existed; `metrics/*.jsonl` is the only place sign-ins,
addresses and refused logins are recorded. Both are read read-only - nothing
here writes, so it is safe to run against the live tree while the service is up.

Days are bucketed in the machine's local zone by default: a session that ends at
23:30 belongs to that evening, not to the next UTC morning.
"""

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any

SIGN_IN_EVENTS = frozenset({"session.login", "session.created"})
BAR_WIDTH = 32


@dataclass(frozen=True)
class Mark:
    """One problem marked by one profile."""

    user: str
    problem_id: str
    collection: str
    status: str
    moment: datetime
    duration_seconds: int | None


@dataclass(frozen=True)
class ProfileWindow:
    user: str
    solved: int
    revisit: int
    seconds: int
    timed: int
    median_seconds: int | None
    active_days: int
    collections: int
    last_mark: datetime


@dataclass(frozen=True)
class ProfileLifetime:
    user: str
    solved: int
    revisit: int
    collections: int
    first_seen: datetime
    last_seen: datetime


@dataclass(frozen=True)
class DayCount:
    day: date
    count: int
    by_user: Counter[str]


@dataclass(frozen=True)
class Report:
    start: date
    end: date
    zone: tzinfo | None
    zone_label: str
    solved: int
    revisit: int
    seconds: int
    profiles: list[ProfileWindow]
    lifetime: list[ProfileLifetime]
    days: list[DayCount]
    collections: list[tuple[str, int]]
    hours: list[int]
    sign_ins: Counter[str] = field(default_factory=Counter)
    new_profiles: list[str] = field(default_factory=list)
    rejections: list[tuple[str, int, str]] = field(default_factory=list)


def build_report(
    data_directory: Path,
    days: int = 7,
    zone: tzinfo | None = None,
    now: datetime | None = None,
) -> Report:
    now = (now or datetime.now(timezone.utc)).astimezone(zone)
    end = now.date()
    start = end - timedelta(days=max(days, 1) - 1)

    marks = read_marks(data_directory)
    in_window = [mark for mark in marks if start <= mark.moment.astimezone(zone).date() <= end]
    events = [
        entry
        for entry in read_events(data_directory)
        if (moment := _parse(entry.get("timestamp")))
        and start <= moment.astimezone(zone).date() <= end
    ]

    return Report(
        start=start,
        end=end,
        zone=zone,
        zone_label=now.tzname() or "local",
        solved=sum(1 for mark in in_window if mark.status == "solved"),
        revisit=sum(1 for mark in in_window if mark.status == "revisit"),
        seconds=sum(mark.duration_seconds or 0 for mark in in_window),
        profiles=_profiles(in_window, zone),
        lifetime=_lifetime(marks),
        days=_days(in_window, start, end, zone),
        collections=Counter(mark.collection for mark in in_window).most_common(),
        hours=_hours(in_window, zone),
        sign_ins=Counter(
            str(entry.get("user"))
            for entry in events
            if entry.get("event") in SIGN_IN_EVENTS and entry.get("user")
        ),
        new_profiles=sorted(
            {
                str(entry["user"])
                for entry in events
                if entry.get("event") == "session.created" and entry.get("user")
            }
        ),
        rejections=_rejections(events),
    )


def read_marks(data_directory: Path) -> list[Mark]:
    marks: list[Mark] = []
    for path in sorted((data_directory / "users").glob("*.json")):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
            user = document["user"]
            events = document["events"]
        except (OSError, ValueError, KeyError, TypeError):
            # A profile we cannot read must not cost us the rest of the report.
            continue
        if not isinstance(user, str) or not isinstance(events, list):
            continue
        for event in events:
            mark = _mark(user, event)
            if mark is not None:
                marks.append(mark)
    marks.sort(key=lambda mark: mark.moment)
    return marks


def read_events(data_directory: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path in sorted((data_directory / "metrics").glob("*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                entries.append(entry)
    return entries


def _mark(user: str, event: Any) -> Mark | None:
    if not isinstance(event, dict):
        return None
    problem_id = event.get("problem_id")
    status = event.get("status")
    moment = _parse(event.get("timestamp"))
    if not isinstance(problem_id, str) or not isinstance(status, str) or moment is None:
        return None
    duration = event.get("duration_seconds")
    return Mark(
        user=user,
        problem_id=problem_id,
        collection=problem_id.split(":", 1)[0],
        status=status,
        moment=moment,
        duration_seconds=duration if isinstance(duration, int) else None,
    )


def _parse(timestamp: Any) -> datetime | None:
    if not isinstance(timestamp, str):
        return None
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _profiles(marks: list[Mark], zone: tzinfo | None) -> list[ProfileWindow]:
    grouped: dict[str, list[Mark]] = defaultdict(list)
    for mark in marks:
        grouped[mark.user].append(mark)

    profiles = [
        ProfileWindow(
            user=user,
            solved=sum(1 for mark in owned if mark.status == "solved"),
            revisit=sum(1 for mark in owned if mark.status == "revisit"),
            seconds=sum(mark.duration_seconds or 0 for mark in owned),
            timed=sum(1 for mark in owned if mark.duration_seconds is not None),
            median_seconds=_median(
                [mark.duration_seconds for mark in owned if mark.duration_seconds is not None]
            ),
            active_days=len({mark.moment.astimezone(zone).date() for mark in owned}),
            collections=len({mark.collection for mark in owned}),
            last_mark=max(mark.moment for mark in owned),
        )
        for user, owned in grouped.items()
    ]
    profiles.sort(key=lambda profile: (-profile.solved, -profile.revisit, profile.user))
    return profiles


def _lifetime(marks: list[Mark]) -> list[ProfileLifetime]:
    grouped: dict[str, list[Mark]] = defaultdict(list)
    for mark in marks:
        grouped[mark.user].append(mark)

    lifetimes = [
        ProfileLifetime(
            user=user,
            solved=sum(1 for mark in owned if mark.status == "solved"),
            revisit=sum(1 for mark in owned if mark.status == "revisit"),
            collections=len({mark.collection for mark in owned}),
            first_seen=min(mark.moment for mark in owned),
            last_seen=max(mark.moment for mark in owned),
        )
        for user, owned in grouped.items()
    ]
    lifetimes.sort(key=lambda profile: (-profile.solved, profile.user))
    return lifetimes


def _days(marks: list[Mark], start: date, end: date, zone: tzinfo | None) -> list[DayCount]:
    per_day: dict[date, Counter[str]] = defaultdict(Counter)
    for mark in marks:
        per_day[mark.moment.astimezone(zone).date()][mark.user] += 1

    days: list[DayCount] = []
    day = start
    while day <= end:
        by_user = per_day.get(day, Counter())
        days.append(DayCount(day=day, count=sum(by_user.values()), by_user=by_user))
        day += timedelta(days=1)
    return days


def _hours(marks: list[Mark], zone: tzinfo | None) -> list[int]:
    hours = [0] * 24
    for mark in marks:
        hours[mark.moment.astimezone(zone).hour] += 1
    return hours


def _rejections(events: list[dict[str, Any]]) -> list[tuple[str, int, str]]:
    refused = [entry for entry in events if entry.get("event") == "session.rejected"]
    by_address = Counter(str(entry.get("ip")) for entry in refused)
    rejections: list[tuple[str, int, str]] = []
    for address, count in by_address.most_common(10):
        reasons = Counter(
            str(entry.get("reason")) for entry in refused if str(entry.get("ip")) == address
        )
        detail = ", ".join(f"{reason} x{number}" for reason, number in reasons.most_common())
        rejections.append((address, count, detail))
    return rejections


def _median(values: list[int]) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) // 2


def render(report: Report) -> str:
    lines: list[str] = []
    span = (report.end - report.start).days + 1
    lines.append(
        f"Reader usage - {span} day{'s' if span != 1 else ''}, "
        f"{report.start} to {report.end} ({report.zone_label})"
    )

    marked = report.solved + report.revisit
    if not marked:
        lines.append("")
        lines.append("  No problems marked in this window.")
    else:
        lines.append("")
        lines.append(
            f"  {len(report.profiles)} profile{'s' if len(report.profiles) != 1 else ''} active, "
            f"{marked} marked ({report.solved} solved, {report.revisit} revisit), "
            f"{format_duration(report.seconds)} recorded"
        )
        lines.extend(_render_profiles(report))
        lines.extend(_render_days(report))
        lines.extend(_render_collections(report))
        lines.extend(_render_hours(report))

    lines.extend(_render_sessions(report))
    lines.extend(_render_lifetime(report))
    return "\n".join(lines)


def _render_profiles(report: Report) -> list[str]:
    header = (
        f"{'profile':<16}{'solved':>7}{'revisit':>8}{'time':>9}{'days':>6}{'median':>8}  last mark"
    )
    lines = ["", header, "-" * len(header)]
    for profile in report.profiles:
        median = format_duration(profile.median_seconds) if profile.median_seconds else "-"
        lines.append(
            f"{_clip(profile.user, 15):<16}"
            f"{profile.solved:>7}{profile.revisit:>8}"
            f"{format_duration(profile.seconds):>9}"
            f"{profile.active_days:>6}{median:>8}"
            f"  {profile.last_mark.astimezone(report.zone).strftime('%m-%d %H:%M')}"
        )
    return lines


def _render_days(report: Report) -> list[str]:
    lines = ["", "by day"]
    busiest = max((day.count for day in report.days), default=0)
    for day in report.days:
        who = ", ".join(f"{user} {count}" for user, count in day.by_user.most_common(3))
        bar = _bar(day.count, busiest)
        lines.append(
            f"  {day.day.strftime('%a %m-%d')}{day.count:>5}  {bar:<{BAR_WIDTH}}  {who}".rstrip()
        )
    return lines


def _render_collections(report: Report) -> list[str]:
    lines = ["", "collections"]
    for slug, count in report.collections[:10]:
        lines.append(f"  {count:>5}  {slug}")
    if len(report.collections) > 10:
        lines.append(f"         ... and {len(report.collections) - 10} more")
    return lines


def _render_hours(report: Report) -> list[str]:
    busiest = max(report.hours)
    lines = ["", f"time of day ({report.zone_label})"]
    for hour, count in enumerate(report.hours):
        if count:
            lines.append(f"  {hour:02d}:00{count:>5}  {_bar(count, busiest)}")
    return lines


def _render_sessions(report: Report) -> list[str]:
    lines = ["", "sessions"]
    if report.sign_ins:
        who = ", ".join(f"{user} {count}" for user, count in report.sign_ins.most_common())
        lines.append(f"  sign-ins{sum(report.sign_ins.values()):>6}  {who}")
    else:
        lines.append("  sign-ins     0")
    if report.new_profiles:
        lines.append(f"  new{len(report.new_profiles):>11}  {', '.join(report.new_profiles)}")
    refused = sum(count for _, count, _ in report.rejections)
    if refused:
        lines.append(f"  refused{refused:>7}")
        width = max(len(address) for address, _, _ in report.rejections)
        for address, count, detail in report.rejections:
            lines.append(f"           {address:<{width}}{count:>5}  {detail}")
    return lines


def _render_lifetime(report: Report) -> list[str]:
    if not report.lifetime:
        return []
    lines = ["", "all time"]
    for profile in report.lifetime:
        lines.append(
            f"  {_clip(profile.user, 15):<16}{profile.solved:>6} solved, "
            f"{profile.revisit} revisit, {_plural(profile.collections, 'collection')}, "
            f"since {profile.first_seen.astimezone(report.zone).date()}"
        )
    return lines


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'s' if count != 1 else ''}"


def _bar(count: int, busiest: int) -> str:
    if count <= 0 or busiest <= 0:
        return ""
    return "#" * max(1, round(BAR_WIDTH * count / busiest))


def _clip(text: str, width: int) -> str:
    return text if len(text) <= width else text[: width - 1] + "…"


def format_duration(seconds: int | None) -> str:
    if not seconds:
        return "0s"
    hours, remainder = divmod(int(seconds), 3600)
    minutes, rest = divmod(remainder, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{rest:02d}s"
    return f"{rest}s"
