import { expect, test } from 'vitest';

// Temporary issue #58 verification only. This PR must be closed without merging.
test('required CI failure blocks merging', () => {
  expect('intentional failure for issue #58').toBe('never merge this verification PR');
});
