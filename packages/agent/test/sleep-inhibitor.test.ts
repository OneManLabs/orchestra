import { describe, expect, it } from 'vitest';
import { inhibitorInvocation } from '../src/sleep-inhibitor.js';

describe('sleep inhibition', () => {
  it('selects an OS-native, reversible inhibitor process', () => {
    const invocation = inhibitorInvocation();
    if (['darwin', 'linux', 'win32'].includes(process.platform)) {
      expect(invocation?.command).toBeTruthy();
      expect(invocation?.args.length).toBeGreaterThan(0);
    } else {
      expect(invocation).toBeUndefined();
    }
  });
});
