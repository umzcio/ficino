import { createHash } from 'node:crypto';

export const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** RFC 4122 v5 (sha1) UUID, as Python `uuid.uuid5`. */
export function uuid5(name: string, namespace: string = NAMESPACE_DNS): string {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
