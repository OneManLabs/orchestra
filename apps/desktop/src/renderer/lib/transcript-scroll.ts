export interface TranscriptScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function transcriptDistanceFromBottom(metrics: TranscriptScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export function isTranscriptNearBottom(metrics: TranscriptScrollMetrics, threshold = 80): boolean {
  return transcriptDistanceFromBottom(metrics) <= threshold;
}
