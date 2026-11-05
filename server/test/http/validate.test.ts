import { describe, expect, it } from 'vitest';
import { pyBool, pyUuid } from '../../src/http/validate.js';

const U = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
describe('pyUuid', () => {
  it.each(['{6BA7B810-9DAD-11D1-80B4-00C04FD430C8}', '6ba7b8109dad11d180b400c04fd430c8', `urn:uuid:${U}`, U.toUpperCase()])(
    'accepts %s',
    (v) => expect(pyUuid.parse(v)).toBe(U),
  );
  it.each(['6ba7b810', '', 'zba7b810-9dad-11d1-80b4-00c04fd430c8'])('rejects %j', (v) =>
    expect(pyUuid.safeParse(v).success).toBe(false),
  );
});
describe('pyBool', () => {
  it('accepts lax strings and booleans', () => {
    expect(pyBool.parse('Yes')).toBe(true);
    expect(pyBool.parse('0')).toBe(false);
    expect(pyBool.parse('OFF')).toBe(false);
    expect(pyBool.parse(true)).toBe(true);
  });
  it.each(['', 'maybe'])('rejects %j', (v) => expect(pyBool.safeParse(v).success).toBe(false));
});
