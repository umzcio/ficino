import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';

/** Renders as `{"detail": detail}` with the given status (FastAPI HTTPException). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = 'HttpError';
  }
}

const PG_INVALID_TEXT_REPRESENTATION = '22P02';

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Error contract (C §0): HttpError -> {detail}; malformed JSON body -> pydantic-shaped 422;
 * a non-UUID string reaching a uuid column (22P02) -> 404 {"detail":"Not Found"}
 * (deliberate divergence: Python returned 500); anything else -> 500 text/plain.
 */
export function errorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof HttpError) {
      return c.json({ detail: err.detail }, err.status as ContentfulStatusCode);
    }
    if (err instanceof HTTPException) {
      if (err.status === 400 && err.message === 'Malformed JSON in request body') {
        return c.json(
          { detail: [{ type: 'json_invalid', loc: ['body'], msg: 'JSON decode error', input: {} }] },
          422,
        );
      }
      return c.json({ detail: err.message }, err.status as ContentfulStatusCode);
    }
    if (pgCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      return c.json({ detail: 'Not Found' }, 404);
    }
    logger.error({ err, method: c.req.method, path: c.req.path }, 'unhandled_exception');
    return c.text('Internal Server Error', 500);
  };
}
