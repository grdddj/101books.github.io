"""One clock for everything a person reads.

Everybody who uses this reader is in Czechia, so writing the log file and the
event log in UTC meant subtracting two hours in your head before a line said
anything about when it happened - and getting it wrong twice a year. Both are
written in Prague time instead.

The offset is always spelled out (`+02:00` in summer, `+01:00` in winter), so
the hour that happens twice when summer time ends stays unambiguous and every
stamp is still a valid ISO 8601 instant that `datetime.fromisoformat` and
`new Date()` read back correctly.

What deliberately does *not* use this: `reader-data/users/*.json`. Those
timestamps are a storage format, validated as UTC on the way in, never shown
raw - the client renders them through `toLocaleString()`. Moving them would
mean a migration of every stored event to gain nothing a reader would see.
"""

from datetime import datetime, timezone, tzinfo

ZONE_NAME = "Europe/Prague"


def _zone() -> tzinfo:
    """Prague, or UTC if this machine has no zone database.

    A reader logging in the wrong zone is a nuisance; one that refuses to start
    because of a missing tzdata package is an outage.
    """
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    except ImportError:  # pragma: no cover - zoneinfo is stdlib since 3.9
        return timezone.utc
    try:
        return ZoneInfo(ZONE_NAME)
    except ZoneInfoNotFoundError:  # pragma: no cover - depends on the host
        return timezone.utc


ZONE: tzinfo = _zone()


def now() -> datetime:
    return datetime.now(ZONE)


def stamp(moment: datetime | None = None) -> str:
    """`moment` as an ISO 8601 string in Prague time, microseconds included.

    A naive `moment` is read as UTC, which is what the standard library hands
    back from `utcnow()` and what older stored timestamps mean.
    """
    if moment is None:
        moment = now()
    elif moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(ZONE).isoformat(timespec="microseconds")
