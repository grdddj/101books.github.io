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

from reader.admins import AdminStore
from reader.auth import AuthError, AuthStore, validate_password
from reader.metrics import EventLog
from reader.stats import build_profile_report, build_report, profile_names, render, render_profile


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
    admins = AdminStore(data_directory)
    for path in sorted(users_directory.glob("*.json")):
        try:
            user = json.loads(path.read_text(encoding="utf-8"))["user"]
        except (OSError, ValueError, KeyError):
            continue
        names.append((user, store.has_credential(user)))

    if not names:
        print("No profiles found.")
    for user, claimed in names:
        role = "  admin" if admins.is_admin(user) else ""
        print(f"{'claimed  ' if claimed else 'UNCLAIMED'}  {user}{role}")

    # A grant for a profile that does not exist yet is worth seeing: it is
    # either a name still to be created or, more likely, a typo that will never
    # take effect.
    listed = {user for user, _ in names}
    for name in admins.names():
        if name not in listed:
            print(f"admin      {name}  (no profile of that name yet)")
    return 0


def set_admin(data_directory: Path, user: str, granted: bool) -> int:
    """Grant or revoke the role that opens the usage panel in the reader."""
    admins = AdminStore(data_directory)
    if granted and not _profile_exists(data_directory, user):
        # Names are matched exactly, so `Jirka` would be a different profile
        # than `jirka` and the grant would silently do nothing.
        print(
            f"Warning: no profile named {user!r} yet - the grant applies "
            "only to that exact spelling.",
            file=sys.stderr,
        )
    changed = admins.grant(user) if granted else admins.revoke(user)
    if not changed:
        print(f"{user!r} was already {'an admin' if granted else 'not an admin'}.")
        return 0
    print(f"{'Granted' if granted else 'Revoked'} admin for {user!r}.")
    return 0


def _profile_exists(data_directory: Path, user: str) -> bool:
    if AuthStore(data_directory).has_credential(user):
        return True
    return any(
        json.loads(path.read_text(encoding="utf-8")).get("user") == user
        for path in (data_directory / "users").glob("*.json")
        if path.is_file()
    )


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


def report_stats(data_directory: Path, days: int, use_utc: bool, profile: str | None) -> int:
    zone = timezone.utc if use_utc else None
    if profile is None:
        print(render(build_report(data_directory, days=days, zone=zone)))
        return 0

    report = build_profile_report(data_directory, profile, days=days, zone=zone)
    if report is None:
        known = profile_names(data_directory)
        print(f"No profile named {profile!r}.", file=sys.stderr)
        if known:
            print(f"Known profiles: {', '.join(known)}", file=sys.stderr)
        return 1
    print(render_profile(report))
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

    commands.add_parser("list", help="show profiles, their passwords and who is an admin")

    grant_command = commands.add_parser(
        "grant-admin", help="let a profile see the usage panel in the reader"
    )
    grant_command.add_argument("user")

    revoke_command = commands.add_parser("revoke-admin", help="take that back")
    revoke_command.add_argument("user")

    stats_command = commands.add_parser("stats", help="who solved how much, over the last N days")
    stats_command.add_argument(
        "--days",
        type=int,
        default=7,
        help="window ending today, in days (default 7); 0 for all of it",
    )
    stats_command.add_argument(
        "--profile", help="one profile in detail, with its sittings and its marks"
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
        return report_stats(arguments.data_dir, arguments.days, arguments.utc, arguments.profile)
    if arguments.command == "metrics":
        return report_metrics(arguments.data_dir, arguments.days)
    if arguments.command in {"grant-admin", "revoke-admin"}:
        return set_admin(arguments.data_dir, arguments.user, arguments.command == "grant-admin")
    return list_profiles(arguments.data_dir)


if __name__ == "__main__":
    raise SystemExit(main())
