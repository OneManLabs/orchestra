import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AuditRecord, FleetPolicy } from '@fleet/shared';
import type { FleetStore } from '../store.js';

export function issueCredential(prefix = 'fl_'): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function hashCredential(value: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(value, salt, 32);
  return `scrypt:${salt.toString('base64url')}:${digest.toString('base64url')}`;
}

export function verifyCredential(value: string, encoded: string | undefined): boolean {
  if (!encoded) return false;
  const [algorithm, saltText, digestText] = encoded.split(':');
  if (algorithm !== 'scrypt' || !saltText || !digestText) return false;
  try {
    const digest = Buffer.from(digestText, 'base64url');
    const candidate = scryptSync(value, Buffer.from(saltText, 'base64url'), digest.length);
    return digest.length === candidate.length && timingSafeEqual(digest, candidate);
  } catch { return false; }
}

export function encryptValue(value: string, masterSecret: string): { iv: string; authTag: string; ciphertext: string } {
  if (!masterSecret) throw Object.assign(new Error('A Fleet token or FLEET_VAULT_KEY is required for the secrets vault.'), { statusCode: 503 });
  const key = createHash('sha256').update(masterSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), authTag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

export function decryptValue(value: { iv: string; authTag: string; ciphertext: string }, masterSecret: string): string {
  const key = createHash('sha256').update(masterSecret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export type AuditRecordInput = Omit<AuditRecord, 'id' | 'sequence' | 'at' | 'previousHash' | 'hash'>;

/** Append a valid hash-chain entry to an arbitrary persistent audit array. */
export function appendAuditRecord(records: AuditRecord[], input: AuditRecordInput): AuditRecord {
  const previous = records.at(-1);
  const recordBase = { id: cryptoRandomId(), sequence: (previous?.sequence ?? 0) + 1, at: new Date().toISOString(), ...input, previousHash: previous?.hash ?? 'GENESIS' };
  const record: AuditRecord = { ...recordBase, hash: createHash('sha256').update(stable(recordBase)).digest('hex') };
  records.push(record);
  return record;
}

export function appendAudit(store: FleetStore, input: AuditRecordInput): AuditRecord {
  const record = appendAuditRecord(store.state.v2.audit, input);
  store.markDirty();
  return record;
}

export function verifyAudit(records: AuditRecord[]): { valid: boolean; invalidSequence?: number } {
  let previousHash = 'GENESIS';
  for (const record of records) {
    const { hash, ...base } = record;
    const expected = createHash('sha256').update(stable(base)).digest('hex');
    if (record.previousHash !== previousHash || hash !== expected) return { valid: false, invalidSequence: record.sequence };
    previousHash = hash;
  }
  return { valid: true };
}

export interface FleetPolicyContext {
  action: string;
  actorType: 'user' | 'agent' | 'mcp' | 'api' | 'system';
  actorId: string;
  method?: string;
  sourceIp?: string;
  projectId?: string;
  deviceId?: string;
  deviceGroupIds?: string[];
  workspaceId?: string;
  environment?: string;
  dataClassification?: string;
}

export interface FleetPolicyDecision {
  effect: FleetPolicy['effect'];
  policy?: FleetPolicy;
}

/**
 * Evaluate the highest-priority policy whose action, scope, and supported
 * conditions match. Unknown conditions fail closed for that policy instead of
 * silently broadening its reach.
 */
export function evaluateFleetPolicies(policies: FleetPolicy[], input: FleetPolicyContext): FleetPolicyDecision {
  const policy = policies
    .filter((candidate) => candidate.enabled && actionMatches(candidate.actions, input.action) && scopeMatches(candidate, input) && conditionsMatch(candidate.conditions, input))
    .sort((left, right) => right.priority - left.priority || right.version - left.version)[0];
  return { effect: policy?.effect ?? 'allow', policy };
}

function normalizeAction(value: string): string { return value.trim().toLowerCase().replace(/:/g, '.'); }

function actionMatches(actions: string[], action: string): boolean {
  const actual = normalizeAction(action);
  return actions.some((candidate) => {
    const expected = normalizeAction(candidate);
    return expected === '*' || expected === actual || (expected.endsWith('.*') && actual.startsWith(expected.slice(0, -1)));
  });
}

function scopeMatches(policy: FleetPolicy, input: FleetPolicyContext): boolean {
  if (policy.scope === 'organization') return true;
  if (!policy.scopeId) return false;
  if (policy.scope === 'workspace') return input.workspaceId === policy.scopeId;
  if (policy.scope === 'project') return input.projectId === policy.scopeId;
  return Boolean(input.deviceGroupIds?.includes(policy.scopeId));
}

function conditionsMatch(conditions: Record<string, unknown>, input: FleetPolicyContext): boolean {
  const matchOne = (condition: unknown, actual: string | undefined, normalize: (value: string) => string = (value) => value): boolean => {
    if (typeof condition === 'string') return Boolean(actual && normalize(actual) === normalize(condition));
    return Array.isArray(condition) && condition.every((value) => typeof value === 'string') && Boolean(actual && condition.some((value) => normalize(value) === normalize(actual)));
  };
  for (const [key, condition] of Object.entries(conditions)) {
    if (key === 'actorType' || key === 'actorTypes') { if (!matchOne(condition, input.actorType)) return false; continue; }
    if (key === 'actorId' || key === 'actorIds') { if (!matchOne(condition, input.actorId)) return false; continue; }
    if (key === 'method' || key === 'methods') { if (!matchOne(condition, input.method, (value) => value.toUpperCase())) return false; continue; }
    if (key === 'sourceIp' || key === 'sourceIps') { if (!matchOne(condition, input.sourceIp)) return false; continue; }
    if (key === 'projectId' || key === 'projectIds') { if (!matchOne(condition, input.projectId)) return false; continue; }
    if (key === 'deviceId' || key === 'deviceIds') { if (!matchOne(condition, input.deviceId)) return false; continue; }
    if (key === 'environment' || key === 'environments') { if (!matchOne(condition, input.environment)) return false; continue; }
    if (key === 'dataClassification' || key === 'dataClassifications') { if (!matchOne(condition, input.dataClassification)) return false; continue; }
    // A misspelled or unsupported security condition must never match broadly.
    return false;
  }
  return true;
}

function cryptoRandomId(): string { return randomBytes(16).toString('hex'); }
