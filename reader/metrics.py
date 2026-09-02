"""Append-only event log for the reader.

Every entry is one JSON object on its own line, in a file per day. A line is
either complete or absent, so a crash mid-write costs at most the last event,
and pruning is a matter of deleting whole files.

Timestamps - and therefore the day each file covers - are Prague time, because
this log is read by a person: an evening of solving belongs to that evening's
file rather than being split across two UTC days at 02:00.

Recording is best effort by design: a failure here must never turn into a failed
request for the person using the reader.
"""

import json
import os
import threading
from _thread import LockType
from pathlib import Path
from typing import Any

from reader.clock import stamp


class EventLog:
    def __init__(self, data_directory: Path) -> None:
        self.directory = data_directory / "metrics"
        self._guard: LockType = threading.Lock()

    def record(self, event: str, **fields: Any) -> None:
        entry: dict[str, Any] = {"timestamp": self._now(), "event": event}
        # Passwords and tokens are never fields; the callers pass outcomes.
        entry.update({key: value for key, value in fields.items() if value is not None})
        line = json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n"
        try:
            with self._guard:
                self.directory.mkdir(parents=True, exist_ok=True)
                os.chmod(self.directory, 0o700)
                path = self.directory / f"{entry['timestamp'][:10]}.jsonl"
                with path.open("a", encoding="utf-8") as log_file:
                    log_file.write(line)
        except OSError:
            # Losing a metric is always preferable to losing the request.
            pass

    def read(self, days: int | None = None) -> list[dict[str, Any]]:
        paths = sorted(self.directory.glob("*.jsonl")) if self.directory.exists() else []
        if days is not None:
            paths = paths[-days:]
        entries: list[dict[str, Any]] = []
        for path in paths:
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict):
                    entries.append(entry)
        return entries

    @staticmethod
    def _now() -> str:
        return stamp()
