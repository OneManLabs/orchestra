import { describe, expect, it } from 'vitest';
import { isTranscriptNearBottom, transcriptDistanceFromBottom } from '../src/renderer/lib/transcript-scroll';

describe('transcript auto-follow', () => {
  it('follows when the reader is already at or near the bottom', () => {
    expect(isTranscriptNearBottom({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isTranscriptNearBottom({ scrollHeight: 1_000, scrollTop: 530, clientHeight: 400 })).toBe(true);
  });

  it('detaches when the reader scrolls up beyond the bottom threshold', () => {
    expect(transcriptDistanceFromBottom({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 400 })).toBe(300);
    expect(isTranscriptNearBottom({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 400 })).toBe(false);
  });
});
