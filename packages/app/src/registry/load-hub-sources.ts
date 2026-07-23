/**
 * Hub source-loading/dedup — ported from the extension's
 * `src/services/hub-manager.ts` (`HubManager.loadHubSources`/
 * `findDuplicateSource`). Stage 2 of the staged HubManager port
 * (migration plan §7.5, HubManager item; see `hub-manager.ts`'s
 * module doc for the full stage list).
 *
 * Converts a hub's declared `HubSource[]` into `RegistrySource`
 * entries and syncs them into the registry: skips disabled sources,
 * updates sources that already carry the same stable id (re-import/
 * sync of the same hub), skips true duplicates (same url/type/branch/
 * collectionsPath under a different id — e.g. added independently
 * before hub adoption, or shared across two hubs), adds everything
 * else as new, and prunes orphaned sources — ones this hub previously
 * contributed that are no longer in its config (e.g. a collection whose
 * repository URL was renamed, producing a new sourceId while the old
 * one lingers as a stale duplicate).
 *
 * SourceId format: `generateSourceId(type, url, config)` produces
 * `{type}-{12-char-hash}`, based on source properties rather than the
 * hub id, so lockfiles stay portable across different hub
 * configurations. Legacy hub-prefixed ids (`hub-{hubId}-{sourceId}`)
 * continue to work since duplicate detection matches on url/type/
 * branch/collectionsPath, not id.
 * @module registry/load-hub-sources
 */
import type {
  HubSource,
  HubSourceSync,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  generateSourceId,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

export interface LoadHubSourcesResult {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
}

/**
 * Check if a hub source is a duplicate of an already-registered
 * source, based on type + url + branch + collectionsPath (not id
 * matching, so it tolerates both the new stable-hash id format and
 * legacy hub-prefixed ids).
 * @param source Candidate hub source.
 * @param existingSources Already-registered sources to compare against.
 * @returns The matching existing source, or undefined.
 */
export function findDuplicateSource(
  source: HubSource,
  existingSources: RegistrySource[]
): RegistrySource | undefined {
  return existingSources.find((existing) => {
    if (existing.type !== source.type || existing.url !== source.url) {
      return false;
    }

    const existingConfig = existing.config ?? {};
    const sourceConfig = source.config ?? {};

    const existingBranch = existingConfig.branch ?? 'main';
    const sourceBranch = sourceConfig.branch ?? 'main';
    if (existingBranch !== sourceBranch) {
      return false;
    }

    const existingPath = existingConfig.collectionsPath ?? 'collections';
    const sourcePath = sourceConfig.collectionsPath ?? 'collections';
    if (existingPath !== sourcePath) {
      return false;
    }

    return true;
  });
}

/**
 * Sync a hub's declared sources into the registry.
 *
 * Per-source `addSource`/`removeSource` failures (e.g. a private repo
 * returning 404) are caught, logged, and skipped rather than failing
 * the whole operation — a hub with one bad source should still get its
 * other sources loaded. `listSources`/`updateSource` failures are not
 * caught here; they propagate to the caller.
 *
 * After syncing, any source belonging to this hub (`hubId` match) that
 * was not represented in the current config is pruned. Manually-added
 * sources (no `hubId`) and sources contributed by other hubs are never
 * touched. Disabled sources still count as "represented" — their id is
 * protected from pruning so `enabled: false` suppresses fetching without
 * destroying the registry entry.
 *
 * Pruning is deliberately conservative to avoid stranding installed
 * bundles (`removeSource` detaches a source but does not uninstall bundles
 * or clean lockfile entries, so a pruned source with live consumers can no
 * longer be updated):
 * - It is skipped entirely for the whole sync if any `addSource` failed,
 *   so a transient error on a renamed source's new id cannot delete the
 *   old id before its replacement lands.
 * - An orphan with installed bundles still referencing it (via
 *   `ports.listInstalledBundles`, when provided) is kept and logged as a
 *   warning rather than removed; deletion only proceeds once those
 *   consumers are migrated or uninstalled. When `listInstalledBundles` is
 *   not provided this guard is skipped and a pruned source may leave its
 *   installed bundles in an unmanaged state.
 * @param hubId Hub identifier the sources belong to.
 * @param hubSources Sources declared in the hub's config.
 * @param ports Registry read/write access.
 * @param onLog Optional sink for diagnostic log events.
 * @returns Counts of added/updated/skipped/removed sources.
 */
export async function loadHubSources(
  hubId: string,
  hubSources: HubSource[],
  ports: HubSourceSync,
  onLog?: OnLogEvent
): Promise<LoadHubSourcesResult> {
  const log = (level: LogEvent['level'], message: string, error?: Error): void => {
    onLog?.({ level, message, error });
  };

  log('info', `Found ${hubSources.length} sources in hub ${hubId}`);

  const existingSources = await ports.listSources();

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let removed = 0;

  // Ids of existing sources still represented in the current hub config
  // (added, updated, or matched as a duplicate). Any source belonging to
  // this hub but absent from this set after processing is orphaned and
  // must be pruned to avoid stale duplicates on URL rename.
  const keepSourceIds = new Set<string>();

  // Set when any `addSource` fails this cycle. Orphan pruning is skipped
  // entirely in that case: a transient failure on a renamed source's new
  // id would otherwise let us delete the old id (now absent from config)
  // while the replacement never landed, stranding installed bundles. Better
  // to keep a stale duplicate than to lose the source outright.
  let addFailed = false;

  for (const hubSource of hubSources) {
    // Generate the stable id up front and protect it from pruning
    // regardless of the enabled flag. Disabling a source in hub config is a
    // reversible action (e.g. a collection under maintenance); it must
    // suppress fetching, not destroy the registry entry and strand any
    // bundles installed from it.
    const sourceId = generateSourceId(hubSource.type, hubSource.url, {
      branch: hubSource.config?.branch,
      collectionsPath: hubSource.config?.collectionsPath
    });
    keepSourceIds.add(sourceId);

    if (!hubSource.enabled) {
      log('debug', `Skipping disabled source: ${hubSource.id}`);
      skipped++;
      continue;
    }

    const existingSourceById = existingSources.find((s) => s.id === sourceId);

    if (existingSourceById) {
      log('info', `Updating existing hub source: ${sourceId}`);
      await ports.updateSource(sourceId, {
        name: hubSource.name,
        type: hubSource.type,
        url: hubSource.url,
        enabled: hubSource.enabled,
        priority: hubSource.priority,
        private: hubSource.private,
        token: hubSource.token,
        metadata: hubSource.metadata,
        config: hubSource.config,
        hubId
      });
      updated++;
      continue;
    }

    const duplicateSource = findDuplicateSource(hubSource, existingSources);

    if (duplicateSource) {
      keepSourceIds.add(duplicateSource.id);
      log(
        'info',
        `Skipping duplicate source: ${hubSource.name} `
        + `(already exists as "${duplicateSource.name}" with ID: ${duplicateSource.id})`
      );
      log(
        'debug',
        `Duplicate detected - URL: ${hubSource.url}, `
        + `Branch: ${hubSource.config?.branch ?? 'main'}, `
        + `CollectionsPath: ${hubSource.config?.collectionsPath ?? 'collections'}`
      );
      skipped++;
      continue;
    }

    log('info', `Adding new hub source: ${sourceId} (${hubSource.name})`);

    const registrySource: RegistrySource = {
      id: sourceId,
      name: hubSource.name,
      type: hubSource.type,
      url: hubSource.url,
      enabled: hubSource.enabled,
      priority: hubSource.priority,
      private: hubSource.private,
      token: hubSource.token,
      metadata: hubSource.metadata,
      config: hubSource.config,
      hubId
    };

    try {
      await ports.addSource(registrySource);
      added++;
    } catch (sourceError) {
      const err = sourceError instanceof Error ? sourceError : new Error(String(sourceError));
      log('warn', `Failed to add hub source ${sourceId} (${hubSource.name}): ${err.message}`, err);
      addFailed = true;
      skipped++;
    }
  }

  // Skip pruning entirely if any add failed: the config sync is incomplete,
  // and deleting an orphan (e.g. the pre-rename id) while its replacement
  // never landed would strand installed bundles. A stale duplicate is
  // recoverable on the next successful sync; lost sources are not.
  if (addFailed) {
    log(
      'warn',
      `Skipping orphaned source pruning for hub ${hubId}: one or more sources failed to add this sync`
    );
  } else {
    // Prune orphaned sources: any source previously linked to this hub that
    // is no longer represented in the current config (e.g. a renamed URL).
    const orphanedSources = existingSources.filter(
      (s) => s.hubId === hubId && !keepSourceIds.has(s.id)
    );

    const installedBundles = orphanedSources.length > 0
      ? await ports.listInstalledBundles()
      : [];

    for (const orphan of orphanedSources) {
      const consumers = installedBundles.filter((b) => b.sourceId === orphan.id);

      if (consumers.length > 0) {
        // Find the replacement source: the one in keepSourceIds that was
        // added/updated this cycle for the same hub. When a URL is renamed,
        // the new sourceId is in keepSourceIds but not in existingSources at
        // the start of this sync. Prefer the newly-added source; if multiple
        // exist, pick the first (there is typically exactly one replacement).
        const replacementId = [...keepSourceIds].find((id) => id !== orphan.id);

        if (replacementId && ports.remapBundleSource) {
          try {
            await ports.remapBundleSource(orphan.id, replacementId);
            await ports.removeSource(orphan.id);
            log(
              'info',
              `Remapped ${consumers.length} bundle(s) from orphaned source ${orphan.id} to ${replacementId} and removed it`
            );
            removed++;
          } catch (remapError) {
            const err = remapError instanceof Error ? remapError : new Error(String(remapError));
            log(
              'warn',
              `Failed to remap bundles from orphaned source ${orphan.id} to ${replacementId}: ${err.message}. `
              + 'Keeping the orphaned source to avoid stranding installed bundles.',
              err
            );
          }
        } else {
          log(
            'warn',
            `Keeping orphaned hub source ${orphan.id} (${orphan.name}): `
            + `${consumers.length} installed bundle(s) still reference it. `
            + (replacementId
              ? `Replacement source ${replacementId} is available but remapBundleSource is not provided.`
              : 'No replacement source found.')
          );
        }
        continue;
      }

      try {
        await ports.removeSource(orphan.id);
        log('info', `Removed orphaned hub source: ${orphan.id} (${orphan.name}) - no longer present in hub ${hubId}`);
        removed++;
      } catch (removeError) {
        const err = removeError instanceof Error ? removeError : new Error(String(removeError));
        log('warn', `Failed to remove orphaned hub source ${orphan.id} (${orphan.name}): ${err.message}`, err);
      }
    }
  }

  log(
    'info',
    `Hub source loading complete for ${hubId}: ${added} added, ${updated} updated, ${skipped} skipped, ${removed} removed`
  );

  return { added, updated, skipped, removed };
}
