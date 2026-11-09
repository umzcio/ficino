// Model output is untrusted (a paper can steer it), and the web client renders some of its fields as text. A field
// stored for that is kept only as a string: a string as is, a finite number as its decimal string, anything else
// (null, a boolean, an object, an array) dropped.

/** A model value as stored text, or undefined when it is not a string or a finite number. */
export function modelString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}
