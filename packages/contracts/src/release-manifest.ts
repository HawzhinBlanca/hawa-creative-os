export interface ImageDigestEntry {
  service: 'core' | 'desk' | 'worker' | 'postgres' | 'nginx';
  image: string;
  digest?: string;
  sourceFileHashes?: Record<string, string>;
}

export interface ReleaseManifest {
  manifestVersion: '1.0.0';
  generatedAt: string;
  environment: 'production' | 'staging' | 'development' | 'test';
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
    core: ImageDigestEntry;
    desk: ImageDigestEntry;
    worker: ImageDigestEntry;
  };
  models: {
    registryVersion: string;
    pinnedModels: Record<string, { provider: string; model: string }>;
    promptVersions: Record<string, string>;
  };
  qa: {
    engineVersion: string;
    rulesVersion: string;
    rubricVersion: string;
  };
  sha256?: string;
}

export function validateReleaseManifest(data: unknown): { ok: true; manifest: ReleaseManifest } | { ok: false; error: string } {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Manifest must be an object' };
  }
  const m = data as Partial<ReleaseManifest>;
  if (m.manifestVersion !== '1.0.0') {
    return { ok: false, error: `Unsupported manifestVersion: ${m.manifestVersion}` };
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
  return { ok: true, manifest: data as ReleaseManifest };
}
