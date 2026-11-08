// A fake PDF thread for pdfIsolated tests: it opens any document, then allocates until its heap limit stops it.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (req) => {
  if (req.op === 'open') {
    parentPort.postMessage({ id: req.id, ok: true, value: { pages: 1 }, warnings: [] });
    return;
  }
  const held = [];
  for (;;) held.push({ c: 'a', bbox: [held.length, 0, 1, 1] });
});
parentPort.postMessage({ ready: true });
