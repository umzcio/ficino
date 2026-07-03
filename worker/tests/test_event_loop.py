"""Tests for the shared background event-loop helper (R10 DUP-5)."""


def test_loop_runner_recovers_from_a_dead_but_unclosed_loop_thread():
    """R10 wave-3 final review: run_forever() can return (its thread exits)
    without the loop ever being closed — is_closed() alone would then miss
    a dead thread and _ensure_loop would hand back a loop nothing is
    driving, so a subsequent run() would hang forever on .result(). Kill
    the loop's thread directly (loop.stop() from inside the loop, the same
    effect an uncaught run_forever exit would have) and assert the next
    run() recovers instead of hanging."""
    import time
    from lib.event_loop import LoopRunner

    r = LoopRunner("test-loop-recovery")

    async def value(n):
        return n

    assert r.run(value(1)) == 1
    dead_thread = r._thread
    assert dead_thread is not None and dead_thread.is_alive()

    # Stop the loop from within itself — same effect as run_forever exiting
    # on its own (thread ends, loop object is left open/unclosed).
    r._loop.call_soon_threadsafe(r._loop.stop)
    dead_thread.join(timeout=2)
    assert not dead_thread.is_alive(), "loop thread should have exited after stop()"
    assert not r._loop.is_closed(), "stop() alone must not close the loop (that's the gap)"

    start = time.monotonic()
    assert r.run(value(2)) == 2, "run() must recover from a dead thread, not hang"
    assert time.monotonic() - start < 2, "recovery should be immediate, not a timeout-driven hang"
    assert r._thread is not dead_thread, "a fresh thread should have been spawned"
    assert r._thread.is_alive()


def test_loop_runner_concurrent_submissions_dont_serialize():
    import asyncio
    import threading
    import time
    from lib.event_loop import LoopRunner
    r = LoopRunner("test-loop")
    async def sleeper():
        await asyncio.sleep(0.2)
        return threading.current_thread().name
    start = time.monotonic()
    results = []
    threads = [threading.Thread(target=lambda: results.append(r.run(sleeper()))) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.monotonic() - start
    assert elapsed < 0.6, f"4 concurrent 0.2s coroutines took {elapsed:.2f}s — serialized?"
    assert all(name == "test-loop" for name in results)
