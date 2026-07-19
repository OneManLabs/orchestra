export class JsonLineDecoder {
  private buffer = '';

  constructor(private readonly onLine: (value: unknown, raw: string) => void, private readonly onInvalid?: (raw: string) => void) {}

  push(chunk: string | Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.decode(line);
  }

  flush(): void {
    if (this.buffer) this.decode(this.buffer);
    this.buffer = '';
  }

  private decode(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    try {
      this.onLine(JSON.parse(line), line);
    } catch {
      this.onInvalid?.(line);
    }
  }
}
