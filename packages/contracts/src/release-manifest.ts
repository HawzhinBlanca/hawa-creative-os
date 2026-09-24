export interface SourceComponentEntry {
  service: 'core' | 'desk' | 'worker';
  imageStatus: 'unbuilt';
  sourceFileHashes: Record<string, string>;
}

export interface ReleaseManifest {
  manifestVersion: '2.0.0';
  evidenceKind: 'source_candidate';
  generatedAt: string;
  targetEnvironment: 'production' | 'staging' | 'development' | 'test';
  topology: {
    canonical: 'infra/docker/docker-compose.prod.yml';
    description: string;
    activeLanes: string[];
    retiredLanes: string[];
  };
  build: {
    commit: string;
    treeClean: boolean;
    uncommittedFiles?: string[];
    commitTimestamp: string;
    branch: string;
  };
  migrations: {
    targetVersion: string;
    latestMigrationFile: string;
    totalMigrations: number;
  };
  flags: {
    DESIGN_PIPELINE_V3: 'off' | 'on';
    DESIGN_STUDIO_V2: 'off' | 'on';
    [key: string]: string;
  };
  components: {
    core: SourceComponentEntry;
    desk: SourceComponentEntry;
    worker: SourceComponentEntry;
  };
  models: {
    policySourceSha256: string;
    productionDefaults: Record<'layout' | 'critique' | 'judge' | 'text' | 'image', string>;
    runtimeOverrides: 'unobserved';
    promptVersion: string;
    promptSourcesSha256: Record<string, string>;
  };
  qa: {
    versionStatus: 'unobserved';
    sourceHashes: Record<string, string>;
  };
  sha256?: string;
}

export function validateReleaseManifest(data: unknown): { ok: true; manifest: ReleaseManifest } | { ok: false; error: string } {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Manifest must be an object' };
  }
  const m = data as Partial<ReleaseManifest>;
  if (m.manifestVersion !== '2.0.0') {
    return { ok: false, error: `Unsupported manifestVersion: ${m.manifestVersion}` };
  }
  if (m.evidenceKind !== 'source_candidate') {
    return { ok: false, error: 'Release manifest must identify itself as a source candidate' };
  }
  if (m.targetEnvironment !== 'production') {
    return { ok: false, error: 'This source candidate must name production as its target environment' };
  }
  if (!m.build?.commit || typeof m.build.commit !== 'string') {
    return { ok: false, error: 'Manifest missing build.commit' };
  }
  if (typeof m.build.treeClean !== 'boolean') {
    return { ok: false, error: 'Manifest missing build.treeClean boolean' };
  }
  if (m.topology?.canonical !== 'infra/docker/docker-compose.prod.yml') {
    return { ok: false, error: `Invalid canonical topology: ${m.topology?.canonical}` };
  }
  if (m.flags?.DESIGN_PIPELINE_V3 !== 'off' || m.flags?.DESIGN_STUDIO_V2 !== 'off') {
    return { ok: false, error: 'Production flags must remain "off" until admission gates pass' };
  }
  for (const component of Object.values(m.components || {})) {
    if (component?.imageStatus !== 'unbuilt' || 'image' in component || 'digest' in component) {
      return { ok: false, error: 'A source candidate cannot claim a built image or digest' };
    }
  }
  if (m.models?.runtimeOverrides !== 'unobserved') {
    return { ok: false, error: 'Runtime model overrides belong in the inspected deployment receipt' };
  }
  return { ok: true, manifest: data as ReleaseManifest };
}
