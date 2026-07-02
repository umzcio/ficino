"""Tests for the shared background event-loop helper (R10 DUP-5)."""


def test_loop_runner_concurrent_submissions_dont_serialize():
    import asyncio, time, threading
    from lib.event_loop import LoopRunner
    r = LoopRunner("test-loop")
    async def sleeper():
        await asyncio.sleep(0.2)
        return threading.current_thread().name
    start = time.monotonic()
    results = []
    threads = [threading.Thread(target=lambda: results.append(r.run(sleeper()))) for _ in range(4)]
    [t.start() for t in threads]; [t.join() for t in threads]
    elapsed = time.monotonic() - start
    assert elapsed < 0.6, f"4 concurrent 0.2s coroutines took {elapsed:.2f}s — serialized?"
    assert all(name == "test-loop" for name in results)
