import { describe, expect, it } from 'vitest';
import { fleetCoreRequestError } from '../src/core-request-error.js';

describe('Fleet Core request errors', () => {
  it('turns a missing Codex RPC route into an actionable version error', () => {
    expect(fleetCoreRequestError('/api/sessions/session-1/rpc', 404, {
      error: 'Not Found', message: 'Route POST:/api/sessions/session-1/rpc not found', statusCode: 404,
    })).toMatch(/older than this Desktop build/);
  });

  it('preserves real Core and app-server errors', () => {
    expect(fleetCoreRequestError('/api/sessions/session-1/rpc', 500, { error: 'Model is unavailable.' })).toBe('Model is unavailable.');
    expect(fleetCoreRequestError('/api/sessions/missing/rpc', 404, { error: 'Codex session not found.' })).toBe('Codex session not found.');
  });
});
