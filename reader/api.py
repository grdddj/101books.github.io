"""The reader's HTTP surface.

`reader.server` owns the catalog, the progress store and the CLI; this module is
only routing. The response shapes are deliberately hand-written rather than
generated: the client was built against `{"error": ...}` bodies, `no-store` on
anything user-specific and `no-cache` on the unversioned assets, and none of
that should drift because a framework default changed.
"""

import json
import logging
import mimetypes
import re
from collections.abc import Callable
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from reader.admins import AdminStore
from reader.auth import AuthError, AuthStore
from reader.metrics import EventLog

if TYPE_CHECKING:
    from reader.server import Collection, ProgressStore

# `/collections/<slug>` and `/collections/<slug>/<problem-number>` are client
# routes: the server has no opinion on them beyond serving the shell.
COLLECTION_ROUTE = re.compile(r"(?:[^/]+(?:/\d+)?)?")
DEFAULT_ACTIVITY_LIMIT = 50
DEFAULT_STATS_DAYS = 7
MAX_STATS_DAYS = 365

logger = logging.getLogger(__name__)


class ReaderRequest(BaseModel):
    """Base for the two request bodies the reader accepts.

    Strict, so that a JSON `"1"` is not quietly read as the number 1 and a
    `"yes"` is not read as true - this is a private API with one client, and a
    request that does not say what it means is a bug worth reporting. Strictness
    also rejects a bool where an int is wanted, which the hand-written checks
    had to special-case because bool subclasses int.

    Unknown keys are still ignored: an older client sending a field this version
    dropped should keep working.
    """

    model_config = ConfigDict(strict=True)


class SessionRequest(ReaderRequest):
    user: str
    password: str
    # Creating a profile takes a second, explicit request, so a mistyped name
    # reports "no such profile" instead of silently starting an empty one.
    create: bool = False


class ProgressRequest(ReaderRequest):
    problem_id: str
    status: str
    duration_seconds: int | None = None


def validation_message(exception: ValidationError) -> str:
    """Describe a rejected body without repeating any of it back.

    Pydantic's own rendering includes the offending value, and one of these
    bodies carries a password.
    """
    first = exception.errors()[0]
    location = ".".join(str(part) for part in first["loc"]) or "body"
    return f"{location}: {first['msg']}"


class UnhandledErrorMiddleware:
    """Turn anything the routes did not predict into one logged JSON 500.

    A plain `@app.exception_handler(Exception)` would do most of this, but
    Starlette re-raises afterwards, so the traceback is logged a second time by
    the server - after the client already has its answer, which makes the log
    racy to read. Catching here instead gives exactly one record, written before
    the response goes out.

    Once a response has started there is nothing left to send, so the exception
    is passed on for the server to deal with.
    """

    def __init__(self, app: ASGIApp, *, on_error: "Callable[[Request, Exception], Response]"):
        self.app = app
        self.on_error = on_error

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = False

        async def watch(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, watch)
        except Exception as exception:
            if started:
                raise
            response = self.on_error(Request(scope, receive), exception)
            await response(scope, receive, send)


def create_app(
    *,
    collections: "list[Collection]",
    activity_context: dict[str, tuple[str, str, int]],
    progress_store: "ProgressStore",
    auth_store: AuthStore,
    admin_store: AdminStore,
    usage_report: Callable[[int], dict[str, object]],
    event_log: EventLog,
    base_path: str,
    static_directory: Path,
    max_request_body_bytes: int,
) -> FastAPI:
    from reader.server import StorageCorruptionError

    static_root = static_directory.resolve()
    catalog = [
        {
            "slug": collection.slug,
            "title": collection.title,
            "category": collection.category,
            "level": collection.level,
            "rank": collection.rank,
            "problem_count": len(collection.problems),
        }
        for collection in collections
    ]
    collections_by_slug = {collection.slug: collection for collection in collections}

    # Redirects are off so that an unknown path is a 404 rather than a bounce to
    # a trailing-slash variant; the base path itself is registered explicitly.
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)

    def route(path: str) -> str:
        return f"{base_path}{path}"

    def readable(path: str):
        """Register a read route.

        FastAPI's `@app.get` answers GET only - unlike the plain server this
        replaced, where HEAD came free - and the service worker and monitoring
        both use HEAD.
        """
        return app.api_route(path, methods=["GET", "HEAD"])

    def json_response(
        status: HTTPStatus, body: object, *, cache_control: str | None = None
    ) -> JSONResponse:
        headers = {} if cache_control is None else {"Cache-Control": cache_control}
        return JSONResponse(body, status_code=int(status), headers=headers)

    def error(status: HTTPStatus, message: str) -> JSONResponse:
        return json_response(status, {"error": message})

    def client_ip(request: Request) -> str:
        for header in ("CF-Connecting-IP", "X-Forwarded-For"):
            value = request.headers.get(header)
            if value:
                return value.split(",")[0].strip()
        return request.client.host if request.client else ""

    def record(request: Request, event: str, **fields: object) -> None:
        event_log.record(event, ip=client_ip(request), **fields)

    def authenticated_user(request: Request) -> str | None:
        header = request.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return None
        return auth_store.user_for_token(header[len(prefix) :])

    def is_admin(user: str | None) -> bool:
        # Read per request rather than cached, so `reader.admin grant-admin`
        # takes effect against the running service without a restart.
        return user is not None and admin_store.is_admin(user)

    async def read_json_body(request: Request) -> object:
        """Parse a request body, refusing an oversized one before reading it.

        Raises ValueError for anything malformed and OverflowError for a body
        larger than the cap, which the callers turn into 400 and 413.
        """
        declared = request.headers.get("Content-Length")
        if declared is None or not re.fullmatch(r"[0-9]+", declared):
            raise ValueError("Content-Length must be a non-negative decimal integer")
        if int(declared) > max_request_body_bytes:
            raise OverflowError
        return json.loads(await request.body())

    @app.exception_handler(StarletteHTTPException)
    async def _json_errors(_request: Request, exception: StarletteHTTPException) -> JSONResponse:
        # Nothing here answers to a browser directly, so even a framework-level
        # 404 should look like the reader's own errors.
        return JSONResponse({"error": exception.detail}, status_code=exception.status_code)

    def handle_unhandled(request: Request, exception: Exception) -> JSONResponse:
        """Answer anything nobody predicted with JSON, and write it down.

        Every failure a route expects already has its own status, so reaching
        here means a bug. The client is told nothing about it - the message
        could be anything, including something it should not see - while the log
        gets the traceback and the request that produced it.
        """
        logger.error(
            "Unhandled %s from %s %s (client %s)",
            type(exception).__name__,
            request.method,
            request.url.path,
            client_ip(request),
            exc_info=exception,
        )
        record(
            request,
            "request.failed",
            route=request.url.path,
            method=request.method,
            error=type(exception).__name__,
        )
        return error(HTTPStatus.INTERNAL_SERVER_ERROR, "The reader failed to handle that request.")

    app.add_middleware(UnhandledErrorMiddleware, on_error=handle_unhandled)

    def reader_shell() -> Response:
        try:
            source = (static_directory / "index.html").read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return error(HTTPStatus.INTERNAL_SERVER_ERROR, "Reader shell is unavailable")
        return Response(
            source.replace("__READER_BASE_PATH__", base_path),
            media_type="text/html",
            headers={"Cache-Control": "no-cache"},
        )

    if base_path:
        # The PWA start URL, and what Apache's redirect lands on.
        @readable(base_path)
        def _base(_request: Request) -> Response:
            return reader_shell()

    @readable(route("/"))
    @readable(route("/index.html"))
    def _shell(_request: Request) -> Response:
        return reader_shell()

    @readable(route("/healthz"))
    def _healthz(_request: Request) -> Response:
        return json_response(HTTPStatus.OK, {"status": "ok"})

    @readable(route("/api/collections"))
    def _catalog(_request: Request) -> Response:
        return json_response(HTTPStatus.OK, catalog)

    @readable(route("/api/collections/{slug}"))
    def _collection(_request: Request, slug: str) -> Response:
        collection = collections_by_slug.get(slug)
        if collection is None:
            return error(HTTPStatus.NOT_FOUND, "Unknown collection")
        return json_response(
            HTTPStatus.OK,
            {
                "slug": collection.slug,
                "title": collection.title,
                "problems": [
                    {
                        "number": problem.number,
                        "id": problem.problem_id,
                        "black": problem.black,
                        "white": problem.white,
                        "solution": [
                            {"color": move.color, "at": move.at} for move in problem.solution
                        ],
                    }
                    for problem in collection.problems
                ],
            },
        )

    @readable(route("/api/progress"))
    def _get_progress(request: Request) -> Response:
        if request.query_params:
            return error(HTTPStatus.BAD_REQUEST, "Unexpected query")
        user = authenticated_user(request)
        if user is None:
            record(request, "session.unauthenticated", route="/api/progress")
            return error(HTTPStatus.UNAUTHORIZED, "Sign in required")
        try:
            problems = progress_store.get_user(user)
        except ValueError as failure:
            return error(HTTPStatus.BAD_REQUEST, str(failure))
        except (OSError, StorageCorruptionError):
            return error(HTTPStatus.INTERNAL_SERVER_ERROR, "Progress storage is unavailable")
        return json_response(HTTPStatus.OK, {"problems": problems}, cache_control="no-store")

    @app.put(route("/api/progress"))
    async def _set_progress(request: Request) -> Response:
        try:
            body = ProgressRequest.model_validate(await read_json_body(request))
        except OverflowError:
            return error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large")
        # ValidationError subclasses ValueError, so it has to be caught first.
        except ValidationError as failure:
            return error(HTTPStatus.BAD_REQUEST, validation_message(failure))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as failure:
            return error(HTTPStatus.BAD_REQUEST, str(failure))

        user = authenticated_user(request)
        if user is None:
            return error(HTTPStatus.UNAUTHORIZED, "Sign in required")

        try:
            problems = progress_store.set_status(
                user, body.problem_id, body.status, body.duration_seconds
            )
            record(
                request,
                "progress.set",
                user=user,
                problem_id=body.problem_id,
                status=body.status,
                duration_seconds=body.duration_seconds,
            )
        except ValueError as failure:
            return error(HTTPStatus.BAD_REQUEST, str(failure))
        except (OSError, StorageCorruptionError):
            return error(HTTPStatus.INTERNAL_SERVER_ERROR, "Progress storage is unavailable")

        return json_response(HTTPStatus.OK, {"problems": problems}, cache_control="no-store")

    @readable(route("/api/activity"))
    def _activity(request: Request) -> Response:
        if not set(request.query_params) <= {"limit"}:
            return error(HTTPStatus.BAD_REQUEST, "Invalid activity query")
        limits = request.query_params.getlist("limit")
        if len(limits) > 1:
            return error(HTTPStatus.BAD_REQUEST, "Invalid activity limit")
        user = authenticated_user(request)
        if user is None:
            return error(HTTPStatus.UNAUTHORIZED, "Sign in required")
        try:
            limit = DEFAULT_ACTIVITY_LIMIT if not limits else parse_activity_limit(limits[0])
            events = progress_store.get_activity(user, limit)
        except ValueError as failure:
            return error(HTTPStatus.BAD_REQUEST, str(failure))
        except (OSError, StorageCorruptionError):
            return error(HTTPStatus.INTERNAL_SERVER_ERROR, "Progress storage is unavailable")

        enriched_events: list[dict[str, str | int]] = []
        for event in events:
            collection_slug, collection_title, problem_number = activity_context[
                str(event["problem_id"])
            ]
            enriched_events.append(
                {
                    **event,
                    "collection_slug": collection_slug,
                    "collection_title": collection_title,
                    "problem_number": problem_number,
                }
            )
        record(request, "activity.viewed", user=user, count=len(enriched_events))
        return json_response(HTTPStatus.OK, {"events": enriched_events}, cache_control="no-store")

    @readable(route("/api/stats"))
    def _stats(request: Request) -> Response:
        if not set(request.query_params) <= {"days"}:
            return error(HTTPStatus.BAD_REQUEST, "Invalid stats query")
        windows = request.query_params.getlist("days")
        if len(windows) > 1:
            return error(HTTPStatus.BAD_REQUEST, "Invalid stats window")
        user = authenticated_user(request)
        if user is None:
            record(request, "session.unauthenticated", route="/api/stats")
            return error(HTTPStatus.UNAUTHORIZED, "Sign in required")
        if not is_admin(user):
            # Deliberately a 403 naming no route detail: a signed-in visitor may
            # know the endpoint exists, they simply may not read it.
            record(request, "stats.refused", user=user)
            return error(HTTPStatus.FORBIDDEN, "Not permitted")
        try:
            days = DEFAULT_STATS_DAYS if not windows else parse_stats_days(windows[0])
        except ValueError as failure:
            return error(HTTPStatus.BAD_REQUEST, str(failure))
        try:
            payload = usage_report(days)
        except OSError:
            return error(HTTPStatus.INTERNAL_SERVER_ERROR, "Usage data is unavailable")
        record(request, "stats.viewed", user=user, days=days)
        return json_response(HTTPStatus.OK, payload, cache_control="no-store")

    @readable(route("/api/session"))
    def _session(request: Request) -> Response:
        """Who the caller is, and whether the admin panel is theirs to open.

        The client stores its token across reloads, so without this it would
        have to remember the role too - and a stale flag either hides the panel
        from an admin or shows a button that only ever 403s.
        """
        user = authenticated_user(request)
        if user is None:
            return error(HTTPStatus.UNAUTHORIZED, "Sign in required")
        return json_response(
            HTTPStatus.OK, {"user": user, "admin": is_admin(user)}, cache_control="no-store"
        )

    @app.post(route("/api/session"))
    async def _log_in(request: Request) -> Response:
        try:
            body = SessionRequest.model_validate(await read_json_body(request))
        except OverflowError:
            return error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large")
        # ValidationError subclasses ValueError, so it has to be caught first.
        except ValidationError as failure:
            return error(HTTPStatus.BAD_REQUEST, validation_message(failure))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as failure:
            return error(HTTPStatus.BAD_REQUEST, str(failure))

        try:
            user = progress_store.normalize_user(body.user)
        except ValueError:
            return error(HTTPStatus.BAD_REQUEST, "Invalid name")

        try:
            result = auth_store.log_in(
                user,
                body.password,
                create=body.create,
                has_progress=progress_store.has_user(user),
            )
        except AuthError as failure:
            record(
                request,
                "session.rejected",
                user=user,
                status=failure.status,
                reason=type(failure).__name__,
            )
            return json_response(
                HTTPStatus(failure.status), {"error": failure.reason}, cache_control="no-store"
            )
        except OSError:
            return error(HTTPStatus.INTERNAL_SERVER_ERROR, "Credential storage is unavailable")

        record(request, "session.created" if result.created else "session.login", user=result.user)
        return json_response(
            HTTPStatus.OK,
            {
                "user": result.user,
                "token": result.token,
                "created": result.created,
                "admin": is_admin(result.user),
            },
            cache_control="no-store",
        )

    @app.delete(route("/api/session"))
    def _log_out(request: Request) -> Response:
        # Tokens are stateless, so there is nothing to revoke: this exists so
        # that signing out is visible at all. Without it the server cannot know
        # a session ended, because sign-out is otherwise pure localStorage.
        record(request, "session.logout", user=authenticated_user(request))
        return json_response(HTTPStatus.OK, {"signed_out": True}, cache_control="no-store")

    # Registered after every real API route so that only unknown ones land here,
    # and so a wrong method on a known route reads as an unknown route rather
    # than a 405 the client has no handling for.
    @app.api_route(
        route("/api/{unknown:path}"),
        methods=["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    )
    def _unknown_api(_request: Request, unknown: str) -> Response:
        return error(HTTPStatus.NOT_FOUND, "Unknown route")

    @readable(route("/collections/{client_route:path}"))
    def _client_route(_request: Request, client_route: str) -> Response:
        if not COLLECTION_ROUTE.fullmatch(client_route):
            return error(HTTPStatus.NOT_FOUND, "Unknown route")
        return reader_shell()

    @readable(route("/{asset:path}"))
    def _asset(_request: Request, asset: str) -> Response:
        candidate = (static_directory / asset).resolve()
        if not candidate.is_relative_to(static_root) or not candidate.is_file():
            return error(HTTPStatus.NOT_FOUND, "Unknown route")
        return FileResponse(
            candidate,
            # Assets are unversioned, so any shared cache in front of the reader
            # must revalidate; without this a CDN pins a stale app.js and the
            # service worker then caches that stale copy too.
            headers={"Cache-Control": "no-cache"},
            media_type=mimetypes.guess_type(candidate.name)[0] or "application/octet-stream",
        )

    return app


def parse_stats_days(value: str) -> int:
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError("Invalid stats window")
    days = int(value)
    if not 1 <= days <= MAX_STATS_DAYS:
        raise ValueError(f"Stats window must be between 1 and {MAX_STATS_DAYS} days")
    return days


def parse_activity_limit(value: str) -> int:
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError("Invalid activity limit")
    limit = int(value)
    if not 1 <= limit <= 100:
        raise ValueError("Activity limit must be between 1 and 100")
    return limit
