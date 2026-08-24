"""File logging for the reader.

The service writes to journald, which is fine until you want to read it without
sudo, or keep it past a journal rotation, or hand it to someone. Everything the
server logs - uvicorn's access and error lines and the reader's own - is
mirrored into `<data-dir>/logs/reader.log`, next to the progress and the event
log it belongs with.

Deliberately best effort: a data directory that cannot be written to costs the
log file, never the request.
"""

import logging
import logging.handlers
import time
from pathlib import Path

LOG_FILE_NAME = "reader.log"
# The access log holds visitors' addresses, so it is as sensitive as the rest of
# the data directory and gets the same permissions.
LOG_DIRECTORY_MODE = 0o700
LOG_FILE_MODE = 0o600
MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 5
LOG_FORMAT = "%(asctime)s %(levelname)-8s %(name)s %(message)s"
# UTC, like every other timestamp the reader writes down.
DATE_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def configure_logging(data_directory: Path, level: int = logging.INFO) -> Path | None:
    """Send the root logger to stderr and to a rotating file under `data_directory`.

    Returns the log file's path, or None when it could not be opened.

    Replaces the handlers a previous call installed rather than adding to them,
    so that starting several servers in one process - which the tests do - does
    not write every line once per server.
    """
    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)
    formatter.converter = time.gmtime

    root = logging.getLogger()
    root.setLevel(level)
    for existing in [handler for handler in root.handlers if _is_ours(handler)]:
        root.removeHandler(existing)
        existing.close()

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    root.addHandler(_tag(console))

    log_path = data_directory / "logs" / LOG_FILE_NAME
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.parent.chmod(LOG_DIRECTORY_MODE)
        file_handler = logging.handlers.RotatingFileHandler(
            log_path, maxBytes=MAX_LOG_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
        )
        log_path.chmod(LOG_FILE_MODE)
    except OSError:
        logging.getLogger(__name__).warning("Could not open %s; logging to stderr only", log_path)
        return None
    file_handler.setFormatter(formatter)
    root.addHandler(_tag(file_handler))
    return log_path


def _tag(handler: logging.Handler) -> logging.Handler:
    handler.set_name("reader")
    return handler


def _is_ours(handler: logging.Handler) -> bool:
    return handler.get_name() == "reader"
