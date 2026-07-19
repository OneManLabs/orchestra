import type { ArtifactLocation, ArtifactVersion, FleetArtifact } from '@fleet/shared';
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  Eye,
  FileArchive,
  FileBox,
  FileCode2,
  FileImage,
  FileText,
  Film,
  GitBranch,
  HardDrive,
  History,
  Layers3,
  Link2,
  MapPin,
  PackageCheck,
  Pin,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Star,
  UploadCloud,
  X
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { apiV2 } from '../lib/api';
import { formatBytes, relativeTime, titleCase } from '../lib/format';
import { useFleet } from '../state/FleetContext';
import { EmptyState } from './EmptyState';
import { StatePill, useEscape } from './V2Ui';
import './ArtifactBrowser.css';

type LibraryFilter = 'active' | 'all' | 'favorites' | 'pinned' | 'archived';
type LocationTarget = 'core' | 'device' | 'storage' | 'url';

interface LocationDraft {
  key: string;
  target: LocationTarget;
  targetId: string;
  path: string;
  status: ArtifactLocation['status'];
  cached: boolean;
  verified: boolean;
}

export function ArtifactLibrary({ onCreate }: { onCreate(): void }) {
  const { snapshot, request } = useFleet();
  const allArtifacts = snapshot?.v2.artifacts ?? [];
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const artifacts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allArtifacts
      .filter((artifact) => {
        if (filter === 'active' && artifact.archived) return false;
        if (filter === 'favorites' && !artifact.favorite) return false;
        if (filter === 'pinned' && !artifact.pinned) return false;
        if (filter === 'archived' && !artifact.archived) return false;
        if (!needle) return true;
        const versions = artifact.versions.flatMap((version) => [
          version.mimeType ?? '',
          version.checksumSha256,
          ...version.locations.map((location) => location.path),
          JSON.stringify(version.metadata)
        ]);
        return [artifact.name, artifact.description, artifact.kind, artifact.classification, ...artifact.tags, ...versions]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      })
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || Number(right.favorite) - Number(left.favorite) || right.updatedAt.localeCompare(left.updatedAt));
  }, [allArtifacts, filter, query]);

  const selected = selectedId ? allArtifacts.find((artifact) => artifact.id === selectedId) ?? null : null;
  const indexedBytes = allArtifacts.reduce((sum, artifact) => sum + (artifact.versions.at(-1)?.sizeBytes ?? 0), 0);
  const updateFlag = (artifact: FleetArtifact, field: 'favorite' | 'pinned' | 'archived') => request(() => apiV2.updateArtifact(artifact.id, { [field]: !artifact[field] }));

  return <>
    <div className="artifact-browser__toolbar">
      <label className="search artifact-browser__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names, tags, checksums, paths, or metadata" /></label>
      <label className="artifact-browser__filter">Show<select value={filter} onChange={(event) => setFilter(event.target.value as LibraryFilter)}><option value="active">Active</option><option value="all">All artifacts</option><option value="favorites">Favorites</option><option value="pinned">Pinned</option><option value="archived">Archived</option></select></label>
      <div className="artifact-browser__summary"><strong>{artifacts.length}</strong><span>shown</span><i /><strong>{formatBytes(indexedBytes)}</strong><span>latest versions</span></div>
    </div>
    {artifacts.length ? <div className="artifact-grid artifact-browser__grid">{artifacts.map((artifact) => <ArtifactCard
      key={artifact.id}
      artifact={artifact}
      onOpen={() => setSelectedId(artifact.id)}
      onToggle={(field) => void updateFlag(artifact, field).catch(() => undefined)}
    />)}</div> : <EmptyState icon={FileBox} title="No artifacts found" description={allArtifacts.length ? 'No real artifact records match this search and filter.' : 'Register a model, report, build, dataset, or other output to begin tracking lineage and versions.'} action={!allArtifacts.length ? <button className="primary-button" onClick={onCreate}><Plus size={15} />Register artifact</button> : undefined} />}
    {selected && <ArtifactDrawer artifact={selected} artifacts={allArtifacts} onClose={() => setSelectedId(null)} onNavigate={setSelectedId} />}
  </>;
}

function ArtifactCard({ artifact, onOpen, onToggle }: { artifact: FleetArtifact; onOpen(): void; onToggle(field: 'favorite' | 'pinned' | 'archived'): void }) {
  const latest = artifact.versions.at(-1);
  const Icon = artifactIcon(artifact);
  const handleKey = (event: KeyboardEvent<HTMLElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } };
  const quickAction = (event: MouseEvent, field: 'favorite' | 'pinned' | 'archived') => { event.stopPropagation(); onToggle(field); };
  return <article className={`artifact-card artifact-browser__card ${artifact.archived ? 'is-archived' : ''}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={handleKey}>
    <header><span className={`artifact-kind artifact-kind--${artifact.kind}`}><Icon size={18} /></span><div><strong>{artifact.name}</strong><small>{titleCase(artifact.kind)}{artifact.promotedEnvironment ? ` · ${artifact.promotedEnvironment}` : ''}</small></div><div className="artifact-browser__quick-actions"><button className={`icon-button ${artifact.pinned ? 'is-pinned' : ''}`} onClick={(event) => quickAction(event, 'pinned')} aria-label={artifact.pinned ? 'Unpin artifact' : 'Pin artifact'} title={artifact.pinned ? 'Unpin' : 'Pin'}><Pin size={14} fill={artifact.pinned ? 'currentColor' : 'none'} /></button><button className={`icon-button ${artifact.favorite ? 'is-favorite' : ''}`} onClick={(event) => quickAction(event, 'favorite')} aria-label={artifact.favorite ? 'Remove favorite' : 'Favorite artifact'} title={artifact.favorite ? 'Remove favorite' : 'Favorite'}><Star size={14} fill={artifact.favorite ? 'currentColor' : 'none'} /></button></div></header>
    <p>{artifact.description || 'No description provided.'}</p>
    <div className="artifact-tags">{artifact.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}{artifact.tags.length > 3 && <span>+{artifact.tags.length - 3}</span>}<span className={`classification classification--${artifact.classification}`}>{artifact.classification}</span>{artifact.archived && <span className="artifact-browser__archived-label">Archived</span>}</div>
    <div className="artifact-version"><div><strong>{latest ? `v${latest.version}` : '—'}</strong><span>{latest ? formatBytes(latest.sizeBytes) : 'No versions'}</span></div><div><strong>{latest?.locations.filter((location) => location.status === 'available').length ?? 0}</strong><span>available</span></div><div><strong>{artifact.parentArtifactIds.length}</strong><span>parents</span></div></div>
    <footer><span>Updated {relativeTime(artifact.updatedAt)}</span>{latest?.mimeType && <code>{latest.mimeType}</code>}<ChevronGlyph /></footer>
  </article>;
}

function ChevronGlyph() { return <span className="artifact-browser__chevron">›</span>; }

function ArtifactDrawer({ artifact, artifacts, onClose, onNavigate }: { artifact: FleetArtifact; artifacts: FleetArtifact[]; onClose(): void; onNavigate(id: string): void }) {
  const { snapshot, request } = useFleet();
  const [selectedVersionId, setSelectedVersionId] = useState(artifact.versions.at(-1)?.id ?? '');
  const [registering, setRegistering] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  useEscape(onClose, !registering && !promoting);

  useEffect(() => {
    if (!artifact.versions.some((version) => version.id === selectedVersionId)) setSelectedVersionId(artifact.versions.at(-1)?.id ?? '');
    setPreviewVisible(false);
  }, [artifact.id, artifact.versions, selectedVersionId]);

  const version = artifact.versions.find((candidate) => candidate.id === selectedVersionId) ?? artifact.versions.at(-1);
  const parents = artifact.parentArtifactIds.map((id) => artifacts.find((candidate) => candidate.id === id) ?? id);
  const children = artifacts.filter((candidate) => candidate.parentArtifactIds.includes(artifact.id));
  const project = snapshot?.projects.find((candidate) => candidate.id === artifact.projectId);
  const preview = version ? safePreview(version) : null;
  const updateFlag = (field: 'favorite' | 'pinned' | 'archived') => request(() => apiV2.updateArtifact(artifact.id, { [field]: !artifact[field] }));

  return <>
    <div className="artifact-drawer__scrim" onClick={onClose} aria-hidden="true" />
    <aside className="v2-drawer artifact-drawer" aria-label={`${artifact.name} details`}>
      <header className="artifact-drawer__header"><div className={`artifact-kind artifact-kind--${artifact.kind}`}>{(() => { const Icon = artifactIcon(artifact); return <Icon size={19} />; })()}</div><div><span className="eyebrow">Artifact registry</span><h2>{artifact.name}</h2><p>{titleCase(artifact.kind)} · {artifact.classification}</p></div><button className="icon-button" onClick={onClose} aria-label="Close artifact details"><X size={18} /></button></header>
      <div className="artifact-drawer__actions"><button className={`secondary-button ${artifact.favorite ? 'is-active' : ''}`} onClick={() => void updateFlag('favorite').catch(() => undefined)}><Star size={14} fill={artifact.favorite ? 'currentColor' : 'none'} />{artifact.favorite ? 'Favorited' : 'Favorite'}</button><button className={`secondary-button ${artifact.pinned ? 'is-active' : ''}`} onClick={() => void updateFlag('pinned').catch(() => undefined)}><Pin size={14} fill={artifact.pinned ? 'currentColor' : 'none'} />{artifact.pinned ? 'Pinned' : 'Pin'}</button><button className={`secondary-button ${artifact.archived ? 'is-active' : ''}`} onClick={() => void updateFlag('archived').catch(() => undefined)}>{artifact.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{artifact.archived ? 'Restore' : 'Archive'}</button></div>

      <section className="artifact-drawer__summary"><p>{artifact.description || 'No description has been recorded for this artifact.'}</p><div>{artifact.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><dl><div><dt>Project</dt><dd>{project?.name ?? 'Unassigned'}</dd></div><div><dt>Versions</dt><dd>{artifact.versions.length}</dd></div><div><dt>Created</dt><dd>{relativeTime(artifact.createdAt)}</dd></div><div><dt>Retention</dt><dd>{artifact.retentionDays ? `${artifact.retentionDays} days` : 'Not set'}</dd></div><div><dt>Promotion</dt><dd>{promotionLabel(artifact)}</dd></div><div><dt>Artifact ID</dt><dd><code>{compactId(artifact.id)}</code></dd></div></dl></section>

      <section className="artifact-drawer__section"><header><div><span><History size={15} /></span><div><h3>Version history</h3><p>Immutable checksums and physical locations</p></div></div><button className="secondary-button" onClick={() => setRegistering(true)}><Plus size={14} />Register version</button></header>
        {artifact.versions.length ? <><label className="artifact-version-select">Inspect version<select value={version?.id ?? ''} onChange={(event) => { setSelectedVersionId(event.target.value); setPreviewVisible(false); }}>{artifact.versions.slice().reverse().map((candidate) => <option key={candidate.id} value={candidate.id}>v{candidate.version} · {formatBytes(candidate.sizeBytes)} · {new Date(candidate.createdAt).toLocaleDateString()}</option>)}</select></label>{version && <VersionDetails version={version} artifact={artifact} preview={preview} previewVisible={previewVisible} onPreview={() => setPreviewVisible(true)} onPromote={() => setPromoting(true)} />}</> : <div className="artifact-drawer__empty"><FileArchive size={23} /><strong>No registered versions</strong><p>Add a checksum and at least one known location before promotion is possible.</p><button className="primary-button" onClick={() => setRegistering(true)}><Plus size={14} />Register first version</button></div>}
      </section>

      <section className="artifact-drawer__section"><header><div><span><GitBranch size={15} /></span><div><h3>Lineage</h3><p>Inputs and downstream outputs</p></div></div></header><LineageList label="Parents" values={parents} empty="No parent artifacts registered" onNavigate={onNavigate} /><LineageList label="Derived artifacts" values={children} empty="No downstream artifacts registered" onNavigate={onNavigate} /></section>
    </aside>
    {registering && <VersionDialog artifact={artifact} onClose={() => setRegistering(false)} />}
    {promoting && version && <PromotionDialog artifact={artifact} version={version} onClose={() => setPromoting(false)} />}
  </>;
}

function VersionDetails({ version, artifact, preview, previewVisible, onPreview, onPromote }: { version: ArtifactVersion; artifact: FleetArtifact; preview: SafePreview | null; previewVisible: boolean; onPreview(): void; onPromote(): void }) {
  return <div className="artifact-version-detail">
    <div className="artifact-version-detail__stats"><div><strong>{formatBytes(version.sizeBytes)}</strong><span>Size</span></div><div><strong>{version.mimeType ?? 'Unknown'}</strong><span>MIME type</span></div><div><strong>{version.createdBy}</strong><span>Registered by</span></div></div>
    <div className="artifact-checksum"><ShieldCheck size={15} /><div><span>Recorded SHA-256 identity</span><code title={version.checksumSha256}>{version.checksumSha256}</code></div><button className="icon-button" onClick={() => void copyText(version.checksumSha256)} aria-label="Copy checksum"><Copy size={14} /></button></div>
    <PreviewPanel artifact={artifact} version={version} preview={preview} visible={previewVisible} onShow={onPreview} />
    <div className="artifact-locations"><header><MapPin size={14} /><strong>Locations</strong><span>{version.locations.filter((location) => location.status === 'available').length} available</span></header>{version.locations.length ? version.locations.map((location) => <LocationRow key={location.id} location={location} />) : <p>No physical location was registered for this version.</p>}</div>
    <MetadataTable metadata={version.metadata} />
    <div className="artifact-promotion"><div><PackageCheck size={17} /><span><strong>{artifact.promotedEnvironment ? `Promoted to ${artifact.promotedEnvironment}` : 'Not promoted'}</strong><small>Promotion records this checksum as the selected environment release.</small></span></div><button className="primary-button" onClick={onPromote}><UploadCloud size={14} />Promote version</button></div>
  </div>;
}

interface SafePreview { url: string; kind: 'image' | 'video'; display: string }

function PreviewPanel({ artifact, version, preview, visible, onShow }: { artifact: FleetArtifact; version: ArtifactVersion; preview: SafePreview | null; visible: boolean; onShow(): void }) {
  if (!preview) return <div className="artifact-preview artifact-preview--empty"><Eye size={20} /><div><strong>Preview unavailable</strong><p>Orchestra has metadata for this {titleCase(artifact.kind)}, but no available HTTPS byte location with a compatible image or video MIME type. Device and mounted-storage paths remain metadata only.</p></div></div>;
  if (!visible) return <div className="artifact-preview artifact-preview--ready"><FileImage size={20} /><div><strong>{titleCase(preview.kind)} preview available</strong><p>Loading it will contact {preview.display} without sending an Orchestra credential or referrer.</p></div><button className="secondary-button" onClick={onShow}><Eye size={14} />Load preview</button></div>;
  return <div className="artifact-preview artifact-preview--media">{preview.kind === 'image' ? <img src={preview.url} alt={`Preview of ${artifact.name}, version ${version.version}`} referrerPolicy="no-referrer" /> : <video src={preview.url} controls preload="metadata" />}<footer><span>{preview.display}</span><button className="text-button" onClick={() => void openExternal(preview.url)}>Open externally <ArrowUpRight size={12} /></button></footer></div>;
}

function LocationRow({ location }: { location: ArtifactLocation }) {
  const { snapshot } = useFleet();
  const provider = snapshot?.v2.storageConnections.find((candidate) => candidate.id === location.providerId);
  const device = snapshot?.devices.find((candidate) => candidate.id === location.deviceId);
  const Icon = location.deviceId ? Server : location.providerId ? Database : isHttpsUrl(location.path) ? Link2 : HardDrive;
  return <article><span><Icon size={15} /></span><div><strong>{device?.name ?? provider?.name ?? (isHttpsUrl(location.path) ? 'HTTPS location' : 'Core / external path')}</strong><code title={location.path}>{displayPath(location.path)}</code></div><div><StatePill value={location.status} /><small>{location.cached ? 'Cached' : 'Source'}{location.lastVerifiedAt ? ` · verified ${relativeTime(location.lastVerifiedAt)}` : ''}</small></div></article>;
}

function MetadataTable({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata);
  return <div className="artifact-metadata"><header><FileCode2 size={14} /><strong>Metadata</strong><span>{entries.length} fields</span></header>{entries.length ? <dl>{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd title={formatMetadata(value)}>{formatMetadata(value)}</dd></div>)}</dl> : <p>No custom metadata was registered.</p>}</div>;
}

function LineageList({ label, values, empty, onNavigate }: { label: string; values: Array<FleetArtifact | string>; empty: string; onNavigate(id: string): void }) {
  return <div className="artifact-lineage"><span>{label}</span>{values.length ? <div>{values.map((value) => typeof value === 'string' ? <span className="artifact-lineage__missing" key={value}><FileBox size={13} />Unknown artifact · {compactId(value)}</span> : <button key={value.id} onClick={() => onNavigate(value.id)}><span className={`artifact-kind artifact-kind--${value.kind}`}>{(() => { const Icon = artifactIcon(value); return <Icon size={14} />; })()}</span><span><strong>{value.name}</strong><small>{titleCase(value.kind)} · {value.versions.length} versions</small></span><ChevronGlyph /></button>)}</div> : <p>{empty}</p>}</div>;
}

function VersionDialog({ artifact, onClose }: { artifact: FleetArtifact; onClose(): void }) {
  const { snapshot, request } = useFleet();
  const [sizeBytes, setSizeBytes] = useState(0);
  const [checksum, setChecksum] = useState('');
  const [mimeType, setMimeType] = useState('application/octet-stream');
  const [createdBy, setCreatedBy] = useState('local-operator');
  const [metadata, setMetadata] = useState('{}');
  const [locations, setLocations] = useState<LocationDraft[]>([newLocationDraft()]);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState('');
  useEscape(onClose);

  const updateLocation = (key: string, patch: Partial<LocationDraft>) => setLocations((current) => current.map((location) => location.key === key ? { ...location, ...patch } : location));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    let parsedMetadata: unknown;
    try { parsedMetadata = JSON.parse(metadata); } catch { setFormError('Metadata must be valid JSON.'); return; }
    if (!parsedMetadata || Array.isArray(parsedMetadata) || typeof parsedMetadata !== 'object') { setFormError('Metadata must be a JSON object.'); return; }
    if (!/^[a-f0-9]{64}$/i.test(checksum.trim())) { setFormError('Checksum must be exactly 64 hexadecimal SHA-256 characters.'); return; }
    if (locations.some((location) => !location.path.trim())) { setFormError('Every location needs a path or HTTPS URL.'); return; }
    if (locations.some((location) => location.target === 'url' && !isHttpsUrl(location.path))) { setFormError('URL locations must use HTTPS and may not contain embedded credentials.'); return; }
    if (locations.some((location) => ['device', 'storage'].includes(location.target) && !location.targetId)) { setFormError('Choose a device or storage provider for every targeted location.'); return; }
    setPending(true);
    try {
      await request(() => apiV2.registerArtifactVersion(artifact.id, {
        sizeBytes,
        checksumSha256: checksum.trim().toLowerCase(),
        mimeType: mimeType.trim() || undefined,
        createdBy: createdBy.trim() || 'local-operator',
        metadata: parsedMetadata as Record<string, unknown>,
        locations: locations.map((location) => ({
          id: randomId(),
          path: location.path.trim(),
          status: location.status,
          cached: location.cached,
          ...(location.verified ? { lastVerifiedAt: new Date().toISOString() } : {}),
          ...(location.target === 'device' ? { deviceId: location.targetId } : {}),
          ...(location.target === 'storage' ? { providerId: location.targetId } : {})
        }))
      }));
      onClose();
    } catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  }

  return <div className="modal-backdrop artifact-version-modal"><form className="modal modal--wide" onSubmit={(event) => void submit(event)}><header><div><span className="eyebrow">Version registration</span><h2>Add version {artifact.versions.length + 1}</h2><p className="artifact-dialog__subtitle">Record the immutable checksum, content type, metadata, and every currently known location.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
    <div className="form-grid"><label>Size in bytes<input required min="0" step="1" type="number" value={sizeBytes} onChange={(event) => setSizeBytes(Number(event.target.value))} /></label><label>MIME type<input value={mimeType} onChange={(event) => setMimeType(event.target.value)} placeholder="application/octet-stream" /></label></div>
    <label>SHA-256 checksum<input required minLength={64} maxLength={64} className="artifact-dialog__mono" value={checksum} onChange={(event) => setChecksum(event.target.value)} placeholder="64 hexadecimal characters" autoCapitalize="none" spellCheck={false} /></label>
    <div className="form-grid"><label>Registered by<input required value={createdBy} onChange={(event) => setCreatedBy(event.target.value)} /></label><label>Custom metadata (JSON)<textarea className="artifact-dialog__mono" rows={3} value={metadata} onChange={(event) => setMetadata(event.target.value)} spellCheck={false} /></label></div>
    <fieldset className="artifact-location-editor"><legend>Known locations</legend><p>Locations are references. Orchestra never invents availability or exposes a path as a downloadable URL.</p>{locations.map((location, index) => <div className="artifact-location-editor__row" key={location.key}><header><strong>Location {index + 1}</strong>{locations.length > 1 && <button type="button" className="text-button danger-text" onClick={() => setLocations((current) => current.filter((candidate) => candidate.key !== location.key))}>Remove</button>}</header><div className="form-grid"><label>Location type<select value={location.target} onChange={(event) => updateLocation(location.key, { target: event.target.value as LocationTarget, targetId: '' })}><option value="core">Core / mounted path</option><option value="device">Orchestra device</option><option value="storage">Storage provider</option><option value="url">HTTPS URL</option></select></label>{location.target === 'device' ? <label>Device<select required value={location.targetId} onChange={(event) => updateLocation(location.key, { targetId: event.target.value })}><option value="">Select device</option>{snapshot?.devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.status}</option>)}</select></label> : location.target === 'storage' ? <label>Storage<select required value={location.targetId} onChange={(event) => updateLocation(location.key, { targetId: event.target.value })}><option value="">Select provider</option>{snapshot?.v2.storageConnections.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.status}</option>)}</select></label> : <label>Status<select value={location.status} onChange={(event) => updateLocation(location.key, { status: event.target.value as ArtifactLocation['status'] })}>{['available', 'transferring', 'offline', 'missing'].map((value) => <option key={value}>{value}</option>)}</select></label>}</div><label>{location.target === 'url' ? 'HTTPS byte URL' : 'Path'}<input required type={location.target === 'url' ? 'url' : 'text'} value={location.path} onChange={(event) => updateLocation(location.key, { path: event.target.value })} placeholder={location.target === 'url' ? 'https://artifacts.example.com/model.bin' : '/artifacts/model.bin'} /></label>{['device', 'storage'].includes(location.target) && <div className="form-grid"><label>Status<select value={location.status} onChange={(event) => updateLocation(location.key, { status: event.target.value as ArtifactLocation['status'] })}>{['available', 'transferring', 'offline', 'missing'].map((value) => <option key={value}>{value}</option>)}</select></label><span /></div>}<div className="artifact-location-editor__checks"><label><input type="checkbox" checked={location.cached} onChange={(event) => updateLocation(location.key, { cached: event.target.checked })} />Cached copy</label><label><input type="checkbox" checked={location.verified} onChange={(event) => updateLocation(location.key, { verified: event.target.checked })} />Operator verified this location now</label></div></div>)}<button type="button" className="secondary-button artifact-location-editor__add" onClick={() => setLocations((current) => [...current, newLocationDraft()])}><Plus size={14} />Add another location</button></fieldset>
    {formError && <div className="artifact-dialog__error">{formError}</div>}<footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={pending}>{pending ? 'Registering…' : 'Register version'}</button></footer></form></div>;
}

function PromotionDialog({ artifact, version, onClose }: { artifact: FleetArtifact; version: ArtifactVersion; onClose(): void }) {
  const { request } = useFleet();
  const [environment, setEnvironment] = useState(artifact.promotedEnvironment ?? 'production');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState('');
  useEscape(onClose);
  async function submit(event: FormEvent) { event.preventDefault(); setPending(true); setFormError(''); try { await request(() => apiV2.promoteArtifact(artifact.id, { environment: environment.trim(), versionId: version.id, confirm: true })); onClose(); } catch (error) { setFormError(error instanceof Error ? error.message : String(error)); } finally { setPending(false); } }
  return <div className="modal-backdrop"><form className="modal artifact-promotion-dialog" onSubmit={(event) => void submit(event)}><header><div><span className="eyebrow">Controlled promotion</span><h2>Promote {artifact.name}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></header><div className="artifact-promotion-dialog__version"><PackageCheck size={19} /><div><strong>Version {version.version}</strong><code>{compactChecksum(version.checksumSha256)}</code></div><span>{formatBytes(version.sizeBytes)}</span></div><label>Target environment<input required maxLength={120} value={environment} onChange={(event) => setEnvironment(event.target.value)} placeholder="production" /></label><label className="artifact-promotion-dialog__confirm"><input required type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>Confirm this exact checksum</strong><small>I understand that promotion records version {version.version} as the selected release for this environment. It does not copy or deploy bytes.</small></span></label>{formError && <div className="artifact-dialog__error">{formError}</div>}<footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!confirmed || pending}><UploadCloud size={14} />{pending ? 'Promoting…' : `Promote to ${environment.trim() || 'environment'}`}</button></footer></form></div>;
}

function artifactIcon(artifact: Pick<FleetArtifact, 'kind'>) {
  if (artifact.kind === 'image') return FileImage;
  if (artifact.kind === 'video') return Film;
  if (artifact.kind === 'model') return Layers3;
  if (artifact.kind === 'archive') return FileArchive;
  if (['report', 'document', 'git-diff', 'log', 'test-result'].includes(artifact.kind)) return FileText;
  return FileBox;
}

function safePreview(version: ArtifactVersion): SafePreview | null {
  const mime = version.mimeType?.toLowerCase().split(';', 1)[0]?.trim();
  const kind = mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : null;
  if (!kind) return null;
  for (const location of version.locations) {
    if (location.status !== 'available' || !isHttpsUrl(location.path)) continue;
    const parsed = new URL(location.path);
    return { url: parsed.toString(), kind, display: `${parsed.hostname}${parsed.pathname}` };
  }
  return null;
}

function isHttpsUrl(value: string): boolean {
  if (!value || value.length > 4_096) return false;
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password; } catch { return false; }
}

function newLocationDraft(): LocationDraft { return { key: randomId(), target: 'core', targetId: '', path: '', status: 'available', cached: false, verified: false }; }
function randomId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function compactId(value: string): string { return value.length > 15 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value; }
function compactChecksum(value: string): string { return `${value.slice(0, 10)}…${value.slice(-10)}`; }
function promotionLabel(artifact: FleetArtifact): string {
  if (!artifact.promotedEnvironment) return 'Not promoted';
  const version = artifact.promotedVersionId ? artifact.versions.find((candidate) => candidate.id === artifact.promotedVersionId)?.version : undefined;
  return `${artifact.promotedEnvironment}${version ? ` · v${version}` : ''}`;
}
function displayPath(value: string): string { if (!isHttpsUrl(value)) return value; const parsed = new URL(value); return `${parsed.origin}${parsed.pathname}`; }
function formatMetadata(value: unknown): string { if (typeof value === 'string') return value; if (value === null) return 'null'; if (typeof value === 'object') return JSON.stringify(value); return String(value); }
async function copyText(value: string): Promise<void> { await navigator.clipboard.writeText(value); }
async function openExternal(url: string): Promise<void> { if (window.fleetDesktop) await window.fleetDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer'); }
