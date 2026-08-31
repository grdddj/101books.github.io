import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from reader.auth import (
    AuthError,
    AuthStore,
    ProfileNeedsClaimError,
    UnknownProfileError,
    hash_password,
    verify_password,
)

PASSWORD = "correct horse battery"


class PasswordHashTests(unittest.TestCase):
    def test_password_round_trips(self) -> None:
        record = hash_password(PASSWORD)

        self.assertTrue(verify_password(PASSWORD, record))
        self.assertFalse(verify_password("something else", record))

    def test_each_profile_gets_its_own_random_salt(self) -> None:
        first = hash_password(PASSWORD)
        second = hash_password(PASSWORD)

        # The salt is never derived from the name: a predictable salt lets an
        # attacker precompute tables before ever seeing the file.
        self.assertNotEqual(first["salt"], second["salt"])
        self.assertNotEqual(first["hash"], second["hash"])
        self.assertTrue(verify_password(PASSWORD, first))
        self.assertTrue(verify_password(PASSWORD, second))

    def test_the_stored_record_never_contains_the_password(self) -> None:
        record = hash_password(PASSWORD)

        self.assertNotIn(PASSWORD, str(record))
        self.assertEqual(record["kdf"], "scrypt")

    def test_a_corrupt_record_fails_closed(self) -> None:
        for record in [{}, {"kdf": "md5"}, {"kdf": "scrypt", "salt": "!!", "hash": "!!"}]:
            with self.subTest(record=record):
                self.assertFalse(verify_password(PASSWORD, record))


class AuthStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.store = AuthStore(self.root)

    def test_logging_in_with_an_unused_name_creates_the_profile(self) -> None:
        result = self.store.log_in("ada", PASSWORD, create=True, has_progress=False)

        self.assertTrue(result.created)
        self.assertEqual(result.user, "ada")
        self.assertTrue(self.store.has_credential("ada"))

    def test_an_unused_name_is_reported_rather_than_created_without_consent(self) -> None:
        with self.assertRaises(UnknownProfileError):
            self.store.log_in("ada", PASSWORD, create=False, has_progress=False)

        self.assertFalse(self.store.has_credential("ada"))

    def test_a_profile_with_progress_but_no_password_must_be_claimed_first(self) -> None:
        # Otherwise the first stranger to guess the name inherits the progress.
        with self.assertRaises(ProfileNeedsClaimError):
            self.store.log_in("jirka", PASSWORD, create=True, has_progress=True)

        self.assertFalse(self.store.has_credential("jirka"))

    def test_a_claimed_profile_accepts_only_its_own_password(self) -> None:
        self.store.write_credential("jirka", PASSWORD)

        result = self.store.log_in("jirka", PASSWORD, create=False, has_progress=True)
        self.assertFalse(result.created)

        with self.assertRaises(AuthError) as error:
            self.store.log_in("jirka", "guessing", create=False, has_progress=True)
        self.assertEqual(error.exception.status, 401)

    def test_repeated_failures_are_throttled(self) -> None:
        self.store.write_credential("ada", PASSWORD)
        for _ in range(6):
            with self.assertRaises(AuthError):
                self.store.log_in("ada", "wrong password guess", create=False, has_progress=False)

        with self.assertRaises(AuthError) as error:
            self.store.log_in("ada", PASSWORD, create=False, has_progress=False)

        self.assertEqual(error.exception.status, 429)

    def test_a_short_password_is_refused_when_creating_a_profile(self) -> None:
        with self.assertRaises(AuthError) as error:
            self.store.log_in("ada", "no", create=True, has_progress=False)

        self.assertEqual(error.exception.status, 400)
        self.assertFalse(self.store.has_credential("ada"))

    def test_a_short_guess_against_a_real_profile_counts_as_a_failure(self) -> None:
        # Otherwise a short guess is refused before the credential is consulted
        # and costs the attacker nothing.
        self.store.write_credential("ada", PASSWORD)

        with self.assertRaises(AuthError) as error:
            self.store.log_in("ada", "no", create=False, has_progress=False)

        self.assertEqual(error.exception.status, 401)

    def test_credentials_and_the_session_secret_are_private(self) -> None:
        self.store.write_credential("ada", PASSWORD)

        self.assertEqual(self.store.credential_path("ada").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.store.secret_path.stat().st_mode & 0o777, 0o600)


class SessionTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.store = AuthStore(self.root)

    def test_a_token_round_trips_to_its_user(self) -> None:
        token = self.store.issue_token("ada")

        self.assertEqual(self.store.user_for_token(token), "ada")

    def test_a_token_carries_no_readable_password_and_resists_tampering(self) -> None:
        token = self.store.issue_token("ada")
        head, expiry, signature = token.rsplit(".", maxsplit=2)

        forged = f"{head}.{int(expiry) + 10_000}.{signature}"
        self.assertIsNone(self.store.user_for_token(forged))
        self.assertIsNone(self.store.user_for_token(f"{head}.{expiry}.{signature[:-2]}AA"))
        self.assertIsNone(self.store.user_for_token("not-a-token"))
        self.assertIsNone(self.store.user_for_token(None))

    def test_an_expired_token_is_rejected(self) -> None:
        token = self.store.issue_token("ada", now=time.time() - 100 * 24 * 60 * 60)

        self.assertIsNone(self.store.user_for_token(token))

    def test_tokens_survive_a_restart_but_not_a_new_secret(self) -> None:
        token = self.store.issue_token("ada")

        self.assertEqual(AuthStore(self.root).user_for_token(token), "ada")

        self.store.secret_path.unlink()
        self.assertIsNone(AuthStore(self.root).user_for_token(token))


if __name__ == "__main__":
    unittest.main()
