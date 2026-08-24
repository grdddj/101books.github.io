"""Administrative commands for the reader's profiles.

Existing progress predates passwords, so a profile that already holds progress
is refused at login until it is claimed here. That keeps the first stranger to
guess a name from inheriting somebody's solved problems.
"""

import argparse
import getpass
import json
import sys
from pathlib import Path

from reader.auth import AuthError, AuthStore, validate_password


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

    arguments = parser.parse_args(argv)
    if arguments.command == "set-password":
        return set_password(arguments.data_dir, arguments.user, arguments.password)
    return list_profiles(arguments.data_dir)


if __name__ == "__main__":
    raise SystemExit(main())
