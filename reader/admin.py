"""Administrative commands for the reader's profiles.

Existing progress predates passwords, so a profile that already holds progress
is refused at login until it is claimed here. That keeps the first stranger to
guess a name from inheriting somebody's solved problems.
"""

import argparse
import getpass
import json
import sys
from collections import Counter
from datetime import timezone
from pathlib import Path

from reader.auth import AuthError, AuthStore, validate_password
from reader.metrics import EventLog
from reader.stats import build_report, render


def set_password(data_directory: Path, user: str, password: str | None) -> int:
    store = AuthStore(data_directory)
    if password is None:
        password = getpass.getpass(f"Password for {user}: ")
        if password != getpass.getpass("Repeat password: "):
            print("Passwords did not match.", file=sys.stderr)
            return 1
    try:
        validate_password(password)
    except AuthError as error:
        print(error.reason, file=sys.stderr)
        return 1

    existed = store.has_credential(user)
    store.write_credential(user, password)
    print(f"{'Updated' if existed else 'Claimed'} profile {user!r}.")
    return 0


def list_profiles(data_directory: Path) -> int:
    users_directory = data_directory / "users"
    names: list[tuple[str, bool]] = []
    store = AuthStore(data_directory)
    for path in sorted(users_directory.glob("*.json")):
        try:
            user = json.loads(path.read_text(encoding="utf-8"))["user"]
        except (OSError, ValueError, KeyError):
            continue
        names.append((user, store.has_credential(user)))

    if not names:
        print("No profiles found.")
        return 0
    for user, claimed in names:
        print(f"{'claimed  ' if claimed else 'UNCLAIMED'}  {user}")
    return 0


def report_metrics(data_directory: Path, days: int | None) -> int:
    entries = EventLog(data_directory).read(days)
    if not entries:
        print("No events recorded yet.")
        return 0

    print(
        f"{len(entries)} events from {entries[0]['timestamp'][:10]} to {entries[-1]['timestamp'][:10]}\n"
    )

    print("by event")
    for event, count in Counter(entry.get("event") for entry in entries).most_common():
        print(f"  {count:6}  {event}")

    logins = [
        entry for entry in entries if entry.get("event") in {"session.login", "session.created"}
    ]
    if logins:
        print("\nsign-ins by profile")
        for user, count in Counter(entry.get("user") for entry in logins).most_common():
            print(f"  {count:6}  {user}")

    rejected = [entry for entry in entries if entry.get("event") == "session.rejected"]
    if rejected:
        print("\nrejected sign-ins by address")
        for ip, count in Counter(entry.get("ip") for entry in rejected).most_common(10):
            reasons = Counter(entry.get("reason") for entry in rejected if entry.get("ip") == ip)
            detail = ", ".join(f"{reason}x{n}" for reason, n in reasons.most_common())
            print(f"  {count:6}  {ip}  ({detail})")

    solved = [entry for entry in entries if entry.get("event") == "progress.set"]
    if solved:
        durations = [entry["duration_seconds"] for entry in solved if "duration_seconds" in entry]
        print(f"\nproblems marked: {len(solved)}")
        if durations:
            ordered = sorted(durations)
            print(f"  median time: {ordered[len(ordered) // 2]}s over {len(durations)} timed")

    print("\nby day")
    for day, count in sorted(Counter(entry["timestamp"][:10] for entry in entries).items()):
        print(f"  {day}  {count}")
    return 0


def report_stats(data_directory: Path, days: int, use_utc: bool) -> int:
    zone = timezone.utc if use_utc else None
    print(render(build_report(data_directory, days=days, zone=zone)))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m reader.admin")
    parser.add_argument("--data-dir", type=Path, default=Path("reader-data"))
    commands = parser.add_subparsers(dest="command", required=True)

    set_password_command = commands.add_parser(
        "set-password", help="claim a profile or change its password"
    )
    set_password_command.add_argument("user")
    set_password_command.add_argument(
        "--password",
        help="read from the terminal when omitted, which keeps it out of shell history",
    )

    commands.add_parser("list", help="show profiles and whether each has a password")

    stats_command = commands.add_parser("stats", help="who solved how much, over the last N days")
    stats_command.add_argument(
        "--days", type=int, default=7, help="window ending today, in days (default 7)"
    )
    stats_command.add_argument(
        "--utc",
        action="store_true",
        help="bucket days in UTC; by default an evening session counts as that evening",
    )

    metrics_command = commands.add_parser("metrics", help="summarise the recorded events")
    metrics_command.add_argument("--days", type=int, help="only the most recent N daily files")

    arguments = parser.parse_args(argv)
    if arguments.command == "set-password":
        return set_password(arguments.data_dir, arguments.user, arguments.password)
    if arguments.command == "stats":
        return report_stats(arguments.data_dir, arguments.days, arguments.utc)
    if arguments.command == "metrics":
        return report_metrics(arguments.data_dir, arguments.days)
    return list_profiles(arguments.data_dir)


if __name__ == "__main__":
    raise SystemExit(main())
