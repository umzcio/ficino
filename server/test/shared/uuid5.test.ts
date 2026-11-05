import { expect, it } from 'vitest';
import { NAMESPACE_DNS, uuid5 } from '../../src/shared/uuid5.js';

// Values printed by python3 -I -c "import uuid;print(uuid.uuid5(uuid.NAMESPACE_DNS, ...))".
it('matches Python uuid5', () => {
  expect(NAMESPACE_DNS).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
  expect(uuid5('ficino:feed:3f1c2b9e-0000-4000-8000-000000000001')).toBe('000ea75f-d3b4-547f-84fe-96c2b2ce1d6a');
  expect(uuid5('ficino:feed:é-😀')).toBe('fe5db0f1-a16f-5e26-b633-9c896f5f7c93');
});
