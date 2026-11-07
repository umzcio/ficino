# Goldens

The files in this directory were produced by the Python implementation (the `api/`, `worker/` and `shared/`
services) during the TypeScript port. Each was written by a generator script under
`server/test/fixtures/goldens/gen/` that ran the real Python code with its I/O patched; the tests in `server/test`
pin the TypeScript modules to them byte for byte or value for value.

The Python services and the generators were removed at the git tag `python-final`. To read or re-run a generator
(its README there has the commands), recover them in a scratch checkout:

```bash
git checkout python-final -- api worker shared server/test/fixtures/goldens/gen
```

The goldens are frozen. A golden that changes is a deliberate behaviour change, and the plan that changes it lists
it in its deliberate-changes section. `test/fixtures/sample.pdf` is still built by
`test/fixtures/build-sample-pdf.ts`; the `sample.*` goldens are the Python extractor's output for it.
