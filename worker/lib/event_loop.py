"""Shared background event-loop helper (R10 DUP-5).

Each subsystem gets a named daemon thread running an asyncio loop forever;
sync wrappers submit via run_coroutine_threadsafe so concurrent Celery
threads don't serialize behind a single run_until_complete (the round-4
bug this pattern fixed — worker/lib/db.py documented it first)."""
import asyncio
import threading


class LoopRunner:
    def __init__(self, name: str) -> None:
        self._name = name
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            # A dead-but-not-closed loop is possible: run_forever() returns
            # (and the thread exits) if the loop's stop() is ever called
            # (e.g. an uncaught exception unwinding run_forever, or a
            # coroutine mistakenly calling loop.stop()) without also
            # calling loop.close() — is_closed() alone would then miss it
            # and every subsequent run() would submit to a loop no thread is
            # driving, hanging forever waiting on .result(). Track the
            # thread explicitly and recreate whenever it isn't alive, not
            # just when the loop reports closed.
            if (
                self._loop is None
                or self._loop.is_closed()
                or self._thread is None
                or not self._thread.is_alive()
            ):
                self._loop = asyncio.new_event_loop()
                self._thread = threading.Thread(
                    target=self._loop.run_forever, name=self._name, daemon=True
                )
                self._thread.start()
            return self._loop

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._ensure_loop()).result()
