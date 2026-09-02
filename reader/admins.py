"""Which profiles may read the whole reader's usage.

Deliberately its own file rather than a flag inside a credential record: a
password record is rewritten whenever somebody changes their password, while a
grant is an operator's decision about somebody else's profile. Keeping it apart
also means the list can be read on every request, so `grant-admin` takes effect
against the running service without a restart.

Standard library only, like `reader.auth` - this is read on a request path.
"""

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


class AdminStore:
    def __init__(self, data_directory: Path) -> None:
        self.data_directory = data_directory
        self.path = data_directory / "admins.json"

    def names(self) -> list[str]:
        """The granted names, sorted. An unreadable list grants nobody."""
        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            logger.warning("Admin list at %s could not be read; nobody is an admin", self.path)
            return []
        if not isinstance(document, dict):
            logger.warning("Admin list at %s is not an object; nobody is an admin", self.path)
            return []
        entries = document.get("admins")
        if not isinstance(entries, list):
            return []
        return sorted({entry for entry in entries if isinstance(entry, str) and entry})

    def is_admin(self, user: str) -> bool:
        # Exact, case-sensitive: `Magic` and `magic` are two different profiles
        # anybody may create, so a loose match would hand one person's role to
        # whoever registers the other spelling.
        return user in set(self.names())

    def grant(self, user: str) -> bool:
        """Add a name. Returns whether the list actually changed."""
        names = self.names()
        if user in names:
            return False
        self._write(sorted([*names, user]))
        return True

    def revoke(self, user: str) -> bool:
        """Remove a name. Returns whether the list actually changed."""
        names = self.names()
        if user not in names:
            return False
        self._write([name for name in names if name != user])
        return True

    def _write(self, names: list[str]) -> None:
        self.data_directory.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"admins": names}, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)
