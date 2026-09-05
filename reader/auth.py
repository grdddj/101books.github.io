"""Password-gated profiles for the reader.

Logging in creates the profile when the name is free, so there is no separate
registration step. Sessions are carried by a signed token rather than by
resending the password on every request.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import threading
import time
from _thread import LockType
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar

# scrypt with these parameters costs roughly 16 MB and ~50 ms per attempt, which
# is the point: it is the only thing standing between a weak password and a
# stolen credentials file.
SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SALT_BYTES = 16

MIN_PASSWORD_LENGTH = 3
MAX_PASSWORD_LENGTH = 200
SESSION_LIFETIME_SECONDS = 90 * 24 * 60 * 60

# Guessing a friend's password is a likelier attack than cracking the file, so
# failures back off per name.
MAX_FAILURES_BEFORE_DELAY = 3
BASE_LOCKOUT_SECONDS = 2
MAX_LOCKOUT_SECONDS = 300

_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_=-]+\.[0-9]+\.[A-Za-z0-9_=-]+$")


class AuthError(Exception):
    """Login could not be completed."""

    def __init__(self, reason: str, status: int) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


class UnknownProfileError(AuthError):
    def __init__(self) -> None:
        super().__init__("No profile with that name", 404)


class ProfileNeedsClaimError(AuthError):
    def __init__(self) -> None:
        super().__init__(
            "This profile has progress but no password. Claim it with reader.admin.", 409
        )


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(password: str, salt: bytes | None = None) -> dict[str, Any]:
    # A random salt per profile, never the name: a name is public and
    # predictable, so an attacker could build tables before ever seeing the
    # file, and reuse them across every deployment.
    salt = os.urandom(SALT_BYTES) if salt is None else salt
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN
    )
    return {
        "kdf": "scrypt",
        "n": SCRYPT_N,
        "r": SCRYPT_R,
        "p": SCRYPT_P,
        "salt": _encode(salt),
        "hash": _encode(derived),
    }


def verify_password(password: str, record: dict[str, Any]) -> bool:
    if record.get("kdf") != "scrypt":
        return False
    try:
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_decode(record["salt"]),
            n=int(record["n"]),
            r=int(record["r"]),
            p=int(record["p"]),
            dklen=SCRYPT_DKLEN,
        )
        expected = _decode(record["hash"])
    except (KeyError, ValueError, TypeError):
        return False
    return hmac.compare_digest(derived, expected)


def validate_password(password: object) -> str:
    if not isinstance(password, str):
        raise AuthError("Password must be text", 400)
    if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
        raise AuthError(
            f"Password must be {MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH} characters", 400
        )
    return password


@dataclass(frozen=True)
class LoginResult:
    user: str
    token: str
    created: bool


class _Throttle:
    def __init__(self) -> None:
        self._failures: dict[str, tuple[int, float]] = {}
        self._guard: LockType = threading.Lock()

    def check(self, key: str, now: float) -> None:
        with self._guard:
            _, blocked_until = self._failures.get(key, (0, 0.0))
            if now < blocked_until:
                raise AuthError(
                    f"Too many attempts. Try again in {int(blocked_until - now) + 1} seconds",
                    429,
                )

    def record_failure(self, key: str, now: float) -> None:
        with self._guard:
            failures, _ = self._failures.get(key, (0, 0.0))
            failures += 1
            delay = 0.0
            if failures > MAX_FAILURES_BEFORE_DELAY:
                delay = min(
                    BASE_LOCKOUT_SECONDS * 2 ** (failures - MAX_FAILURES_BEFORE_DELAY - 1),
                    MAX_LOCKOUT_SECONDS,
                )
            self._failures[key] = (failures, now + delay)

    def clear(self, key: str) -> None:
        with self._guard:
            self._failures.pop(key, None)


class AuthStore:
    _CREDENTIAL_KEYS: ClassVar[set[str]] = {"user", "kdf", "n", "r", "p", "salt", "hash"}

    def __init__(self, data_directory: Path) -> None:
        self.data_directory = data_directory
        self.credentials_directory = data_directory / "credentials"
        self.secret_path = data_directory / "session-secret"
        self._guard: LockType = threading.Lock()
        self._throttle = _Throttle()
        self._secret = self._load_or_create_secret()

    # -- credentials ----------------------------------------------------

    def credential_path(self, user: str) -> Path:
        digest = hashlib.sha256(user.encode("utf-8")).hexdigest()
        return self.credentials_directory / f"{digest}.json"

    def has_credential(self, user: str) -> bool:
        return self.credential_path(user).exists()

    def read_credential(self, user: str) -> dict[str, Any] | None:
        path = self.credential_path(user)
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
            raise AuthError("Credential storage is unavailable", 500) from error
        if not isinstance(record, dict) or not self._CREDENTIAL_KEYS <= set(record):
            raise AuthError("Credential storage is corrupted", 500)
        if record.get("user") != user:
            raise AuthError("Credential storage is corrupted", 500)
        return record

    def write_credential(self, user: str, password: str) -> None:
        record = {"user": user, **hash_password(password)}
        self.credentials_directory.mkdir(parents=True, exist_ok=True)
        os.chmod(self.credentials_directory, 0o700)
        path = self.credential_path(user)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)

    # -- sessions -------------------------------------------------------

    def _load_or_create_secret(self) -> bytes:
        try:
            secret = self.secret_path.read_bytes()
            if len(secret) >= 32:
                return secret
        except FileNotFoundError:
            pass
        except OSError as error:
            raise AuthError("Session secret is unavailable", 500) from error
        secret = os.urandom(32)
        self.data_directory.mkdir(parents=True, exist_ok=True)
        temporary = self.secret_path.with_suffix(".tmp")
        temporary.write_bytes(secret)
        os.chmod(temporary, 0o600)
        temporary.replace(self.secret_path)
        return secret

    def issue_token(self, user: str, now: float | None = None) -> str:
        now = time.time() if now is None else now
        expiry = int(now + SESSION_LIFETIME_SECONDS)
        payload = f"{_encode(user.encode('utf-8'))}.{expiry}"
        signature = hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest()
        return f"{payload}.{_encode(signature)}"

    def user_for_token(self, token: object, now: float | None = None) -> str | None:
        if not isinstance(token, str) or not _TOKEN_PATTERN.match(token):
            return None
        encoded_user, encoded_expiry, encoded_signature = token.rsplit(".", maxsplit=2)
        payload = f"{encoded_user}.{encoded_expiry}"
        expected = hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest()
        try:
            signature = _decode(encoded_signature)
        except ValueError:
            return None
        if not hmac.compare_digest(signature, expected):
            return None
        now = time.time() if now is None else now
        if int(encoded_expiry) <= now:
            return None
        try:
            return _decode(encoded_user).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None

    # -- login ----------------------------------------------------------

    def log_in(self, user: str, password: str, *, create: bool, has_progress: bool) -> LoginResult:
        now = time.time()
        self._throttle.check(user, now)
        if not isinstance(password, str):
            raise AuthError("Password must be text", 400)

        with self._guard:
            record = self.read_credential(user)
            if record is None:
                # The length rule applies to choosing a password, not to
                # offering one: enforcing it at login would let a short guess
                # skip the throttle, and would lock out any profile whose
                # password predates the rule.
                # Existing progress without a password must be claimed
                # deliberately, or the first stranger to guess the name inherits
                # it.
                if has_progress:
                    raise ProfileNeedsClaimError()
                if not create:
                    raise UnknownProfileError()
                validate_password(password)
                self.write_credential(user, password)
                self._throttle.clear(user)
                return LoginResult(user=user, token=self.issue_token(user, now), created=True)

        if not verify_password(password, record):
            self._throttle.record_failure(user, now)
            raise AuthError("Incorrect password", 401)
        self._throttle.clear(user)
        return LoginResult(user=user, token=self.issue_token(user, now), created=False)
