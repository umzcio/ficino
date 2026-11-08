// A fake PDF thread for pdfIsolated tests: it opens any document, then never answers another request.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (req) => {
  if (req.op === 'open') {
    parentPort.postMessage({ id: req.id, ok: true, value: { pages: 1 }, warnings: [] });
    return;
  }
  // A page that never finishes: the thread's event loop never turns again.
  for (;;);
});
parentPort.postMessage({ ready: true });
