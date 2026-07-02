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
        self._lock = threading.Lock()

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._loop is None or self._loop.is_closed():
                self._loop = asyncio.new_event_loop()
                t = threading.Thread(target=self._loop.run_forever, name=self._name, daemon=True)
                t.start()
            return self._loop

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._ensure_loop()).result()
