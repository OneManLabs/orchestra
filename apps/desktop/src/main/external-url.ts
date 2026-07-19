const externalProtocols = new Set(['https:', 'rdp:', 'vnc:', 'moonlight:']);

export function isTailscaleHttpHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255)
      && octets[0] === 100
      && (octets[1] ?? -1) >= 64
      && (octets[1] ?? 256) <= 127;
  }
  return host === 'fd7a:115c:a1e0::' || host.startsWith('fd7a:115c:a1e0:');
}

export function validatedExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4_096) throw new Error('Invalid external URL');
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    if (/[\u0000-\u001f\u007f]/.test(decoded)) throw new Error('External URL contains control characters');
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      throw new Error('External URL is malformed');
    }
  }
  const parsed = new URL(value);
  const privateTailscaleHttp = parsed.protocol === 'http:' && isTailscaleHttpHost(parsed.hostname);
  if (!externalProtocols.has(parsed.protocol) && !privateTailscaleHttp) {
    throw new Error(`External protocol ${parsed.protocol} is not allowed`);
  }
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in external URLs');
  if (!parsed.hostname) throw new Error('External URL must have a hostname');
  return parsed.toString();
}
