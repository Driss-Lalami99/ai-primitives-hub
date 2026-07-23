/**
 * Tests for registry/load-hub-sources.ts (Stage 2: source-loading/dedup).
 */
import type {
  HubSource,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  generateSourceId,
} from '@ai-primitives-hub/core';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  findDuplicateSource,
  loadHubSources,
} from '../../src/registry/load-hub-sources';

function makeHubSource(overrides: Partial<HubSource> = {}): HubSource {
  return {
    id: 'source-1',
    name: 'Source 1',
    type: 'awesome-copilot',
    url: 'https://github.com/github/awesome-copilot',
    enabled: true,
    priority: 1,
    config: { branch: 'main', collectionsPath: 'collections' },
    ...overrides
  };
}

function makeRegistrySource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'existing-source',
    name: 'Existing Source',
    type: 'awesome-copilot',
    url: 'https://github.com/github/awesome-copilot',
    enabled: true,
    priority: 1,
    config: { branch: 'main', collectionsPath: 'collections' },
    ...overrides
  };
}

function makePorts(
  initial: RegistrySource[] = [],
  installedBundleSourceIds: string[] = []
): {
  listSources: ReturnType<typeof vi.fn>;
  addSource: ReturnType<typeof vi.fn>;
  updateSource: ReturnType<typeof vi.fn>;
  removeSource: ReturnType<typeof vi.fn>;
  listInstalledBundles: ReturnType<typeof vi.fn>;
  sources: RegistrySource[];
} {
  const sources = [...initial];
  const installed = installedBundleSourceIds.map((sourceId, index) => ({
    bundleId: `bundle-${index}`,
    sourceId
  }));
  return {
    sources,
    listSources: vi.fn(async () => [...sources]),
    addSource: vi.fn(async (source: RegistrySource) => {
      sources.push(source);
    }),
    updateSource: vi.fn(async (id: string, updates: Partial<RegistrySource>) => {
      const index = sources.findIndex((s) => s.id === id);
      if (index !== -1) {
        sources[index] = { ...sources[index], ...updates };
      }
    }),
    removeSource: vi.fn(async (id: string) => {
      const index = sources.findIndex((s) => s.id === id);
      if (index !== -1) {
        sources.splice(index, 1);
      }
    }),
    listInstalledBundles: vi.fn(async () => [...installed])
  };
}

describe('findDuplicateSource', () => {
  it('matches when type, url, branch, and collectionsPath are identical', () => {
    const existing = [makeRegistrySource()];
    const result = findDuplicateSource(makeHubSource(), existing);
    expect(result).toBe(existing[0]);
  });

  it('does not match a different branch', () => {
    const existing = [makeRegistrySource({ config: { branch: 'main', collectionsPath: 'collections' } })];
    const result = findDuplicateSource(
      makeHubSource({ config: { branch: 'develop', collectionsPath: 'collections' } }),
      existing
    );
    expect(result).toBeUndefined();
  });

  it('does not match a different collectionsPath', () => {
    const existing = [makeRegistrySource({ config: { branch: 'main', collectionsPath: 'collections' } })];
    const result = findDuplicateSource(
      makeHubSource({ config: { branch: 'main', collectionsPath: 'prompts' } }),
      existing
    );
    expect(result).toBeUndefined();
  });

  it('does not match a different url or type', () => {
    const existing = [makeRegistrySource()];
    expect(findDuplicateSource(makeHubSource({ url: 'https://github.com/org/other' }), existing)).toBeUndefined();
    expect(findDuplicateSource(makeHubSource({ type: 'github' }), existing)).toBeUndefined();
  });

  it('defaults missing branch/collectionsPath to main/collections on both sides', () => {
    const existing = [makeRegistrySource({ config: undefined })];
    const result = findDuplicateSource(makeHubSource({ config: undefined }), existing);
    expect(result).toBe(existing[0]);
  });
});

describe('loadHubSources', () => {
  let ports: ReturnType<typeof makePorts>;

  beforeEach(() => {
    ports = makePorts();
  });

  it('adds enabled sources as new RegistrySource entries', async () => {
    const source = makeHubSource();
    const result = await loadHubSources('hub-a', [source], ports);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 0 });
    expect(ports.addSource).toHaveBeenCalledWith(expect.objectContaining({
      id: generateSourceId('awesome-copilot', source.url, { branch: 'main', collectionsPath: 'collections' }),
      name: 'Source 1',
      hubId: 'hub-a'
    }));
  });

  it('skips disabled sources', async () => {
    const result = await loadHubSources('hub-a', [makeHubSource({ enabled: false })], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
    expect(ports.addSource).not.toHaveBeenCalled();
  });

  it('updates an existing source with the same generated id instead of duplicating', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);

    const result = await loadHubSources('hub-a', [{ ...source, name: 'Renamed' }], ports);

    expect(result).toEqual({ added: 0, updated: 1, skipped: 0, removed: 0 });
    expect(ports.sources).toHaveLength(1);
    expect(ports.sources[0].name).toBe('Renamed');
  });

  it('skips a true duplicate (same url/type/branch/collectionsPath under a different id)', async () => {
    const existing = makeRegistrySource({ id: 'manually-added' });
    ports = makePorts([existing]);

    const result = await loadHubSources('hub-a', [makeHubSource()], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
    expect(ports.sources).toHaveLength(1);
  });

  it('allows the same url with a different branch as a distinct source', async () => {
    ports = makePorts([makeRegistrySource()]);

    const result = await loadHubSources(
      'hub-a',
      [makeHubSource({ id: 'source-develop', config: { branch: 'develop', collectionsPath: 'collections' } })],
      ports
    );

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 0 });
    expect(ports.sources).toHaveLength(2);
  });

  it('continues loading remaining sources when one addSource call fails', async () => {
    ports.addSource = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Source validation failed: HTTP 404'))
      .mockResolvedValueOnce(undefined);

    const sources = [
      makeHubSource({ id: 's1', url: 'https://github.com/org/one' }),
      makeHubSource({ id: 's2', url: 'https://github.com/org/two' }),
      makeHubSource({ id: 's3', url: 'https://github.com/org/three' })
    ];

    const result = await loadHubSources('hub-a', sources, ports);

    expect(result).toEqual({ added: 2, updated: 0, skipped: 1, removed: 0 });
  });

  it('propagates a listSources failure', async () => {
    ports.listSources = vi.fn().mockRejectedValue(new Error('storage unavailable'));

    await expect(loadHubSources('hub-a', [makeHubSource()], ports)).rejects.toThrow('storage unavailable');
  });

  it('emits log events through the onLog callback', async () => {
    const events: string[] = [];
    await loadHubSources('hub-a', [makeHubSource()], ports, (event) => events.push(event.message));

    expect(events.some((m) => m.includes('Found 1 sources in hub hub-a'))).toBe(true);
    expect(events.some((m) => m.includes('Adding new hub source'))).toBe(true);
    expect(events.some((m) => m.includes('Hub source loading complete for hub-a: 1 added, 0 updated, 0 skipped, 0 removed'))).toBe(true);
  });

  it('prunes an orphaned source when a hub collection URL is renamed', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);
    expect(ports.sources).toHaveLength(1);

    // Simulate a repository rename: same logical source, new URL -> new sourceId.
    const renamed = makeHubSource({ url: 'https://github.com/github/awesome-copilot-renamed' });
    const result = await loadHubSources('hub-a', [renamed], ports);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 1 });
    expect(ports.sources).toHaveLength(1);
    expect(ports.sources[0].url).toBe('https://github.com/github/awesome-copilot-renamed');
    expect(ports.removeSource).toHaveBeenCalledTimes(1);
  });

  it('does not touch manually-added sources (no hubId) or sources from other hubs', async () => {
    const manual = makeRegistrySource({ id: 'manual', url: 'https://github.com/org/manual', hubId: undefined });
    const otherHub = makeRegistrySource({ id: 'other', url: 'https://github.com/org/other', hubId: 'hub-b' });
    ports = makePorts([manual, otherHub]);

    const result = await loadHubSources('hub-a', [makeHubSource()], ports);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 0 });
    expect(ports.removeSource).not.toHaveBeenCalled();
    expect(ports.sources.map((s) => s.id)).toEqual(expect.arrayContaining(['manual', 'other']));
  });

  it('prunes an orphan whose collection was removed from the hub config entirely', async () => {
    const stale = makeRegistrySource({ id: 'stale', url: 'https://github.com/org/stale', hubId: 'hub-a' });
    ports = makePorts([stale]);

    const result = await loadHubSources('hub-a', [], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 0, removed: 1 });
    expect(ports.sources).toHaveLength(0);
  });

  it('does not prune a previously-synced source that is later disabled in the hub config', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);
    expect(ports.sources).toHaveLength(1);

    const result = await loadHubSources('hub-a', [{ ...source, enabled: false }], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
    expect(ports.removeSource).not.toHaveBeenCalled();
    expect(ports.sources).toHaveLength(1);
  });

  it('skips orphan pruning entirely when any addSource fails this sync', async () => {
    const stale = makeRegistrySource({ id: 'stale', url: 'https://github.com/org/stale', hubId: 'hub-a' });
    ports = makePorts([stale]);
    ports.addSource = vi.fn().mockRejectedValue(new Error('Source validation failed: HTTP 503'));

    const result = await loadHubSources('hub-a', [makeHubSource()], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
    expect(ports.removeSource).not.toHaveBeenCalled();
    expect(ports.sources.map((s) => s.id)).toContain('stale');
  });

  it('keeps an orphaned source that still has installed bundles referencing it when remapBundleSource is not provided', async () => {
    const stale = makeRegistrySource({ id: 'stale', url: 'https://github.com/org/stale', hubId: 'hub-a' });
    ports = makePorts([stale], ['stale']);

    const result = await loadHubSources('hub-a', [], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 0, removed: 0 });
    expect(ports.removeSource).not.toHaveBeenCalled();
    expect(ports.sources.map((s) => s.id)).toContain('stale');
  });

  it('remaps and removes an orphan with installed consumers when remapBundleSource is provided and a replacement exists', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);
    expect(ports.sources).toHaveLength(1);

    const oldSourceId = ports.sources[0].id;

    // Seed installed bundles referencing the old source
    ports.listInstalledBundles = vi.fn(async () => [{ bundleId: 'bundle-0', sourceId: oldSourceId }]);
    const remapFn = vi.fn(async () => {});
    (ports as Record<string, unknown>).remapBundleSource = remapFn;

    // Rename URL -> new sourceId, old one becomes orphan with consumers
    const renamed = makeHubSource({ url: 'https://github.com/github/awesome-copilot-renamed' });
    const result = await loadHubSources('hub-a', [renamed], ports);

    expect(remapFn).toHaveBeenCalledWith(oldSourceId, expect.any(String));
    expect(result.removed).toBe(1);
    expect(ports.sources.every((s) => s.url === 'https://github.com/github/awesome-copilot-renamed')).toBe(true);
  });

  it('keeps an orphan when remapBundleSource fails (does not strand bundles)', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);
    const oldSourceId = ports.sources[0].id;

    ports.listInstalledBundles = vi.fn(async () => [{ bundleId: 'bundle-0', sourceId: oldSourceId }]);
    const remapFn = vi.fn(async () => {
      throw new Error('lockfile write failed');
    });
    (ports as Record<string, unknown>).remapBundleSource = remapFn;

    const renamed = makeHubSource({ url: 'https://github.com/github/awesome-copilot-renamed' });
    const result = await loadHubSources('hub-a', [renamed], ports);

    expect(result.removed).toBe(0);
    expect(ports.sources.map((s) => s.id)).toContain(oldSourceId);
  });

  it('prunes an orphan with no installed consumers even when listInstalledBundles is provided', async () => {
    const stale = makeRegistrySource({ id: 'stale', url: 'https://github.com/org/stale', hubId: 'hub-a' });
    ports = makePorts([stale], ['some-other-source']);

    const result = await loadHubSources('hub-a', [], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 0, removed: 1 });
    expect(ports.removeSource).toHaveBeenCalledWith('stale');
    expect(ports.sources).toHaveLength(0);
  });
});
