export interface FleetLogger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

function write(method: 'debug' | 'info' | 'warn' | 'error', message: string, details?: unknown): void {
  const suffix = details === undefined ? '' : ` ${formatDetails(details)}`;
  console[method](`[fleet-agent] ${message}${suffix}`);
}

function formatDetails(details: unknown): string {
  if (details instanceof Error) return details.stack ?? details.message;
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

export const consoleLogger: FleetLogger = {
  debug: (message, details) => write('debug', message, details),
  info: (message, details) => write('info', message, details),
  warn: (message, details) => write('warn', message, details),
  error: (message, details) => write('error', message, details),
};
