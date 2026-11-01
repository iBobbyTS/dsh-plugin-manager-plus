/**
 * Update detection: per-plugin comparison of what the profile has against
 * the source of truth — git HEAD for github installs, the npm latest
 * dist-tag for registry installs — with a TTL cache.
 */
export interface UpdateStatus {
    kind: 'github' | 'npm' | 'linked';
    version: string | null;
    current: string | null;
    latest: string | null;
    updateAvailable: boolean;
    /** Verified GitHub owner/repo for Git installations, not npm package metadata. */
    repo?: string;
    /** Commits on remote HEAD that are absent from the installed revision. Null when not verifiable. */
    behind?: number | null;
    /** Commits on the installed revision that are absent from remote HEAD (divergence). */
    ahead?: number | null;
}
/** Drop the cached listing (after a successful install/update/uninstall). */
export declare function invalidateUpdates(): void;
/** @internal exported for routes.ts (lock sha update) */
export declare function fetchJson(url: string): Promise<unknown>;
/**
 * Evidence check behind the "wait a day" stale diagnosis (#45): whether the
 * package's CURRENT latest release was published recently enough to sit
 * inside pnpm's default fresh-release window. pnpm's silent hold leaves no
 * trace in its output, so the publish time is the only verifiable signal.
 * @returns true/false when the npm time metadata answers, null when it
 *   can't be determined (offline, unpublished, non-npm) — callers must NOT
 *   claim the safety wait on null.
 */
export declare function latestPublishedRecently(name: string, windowMs?: number): Promise<boolean | null>;
/** Recognize GitHub dependency sources; never infer a Git source from npm package metadata. */
export declare function githubRepoFromSpec(spec: string): string | null;
/** Per-plugin update checks; a failed check reports no update rather than failing the listing. */
export declare function checkUpdates(profile: string, force?: boolean): Promise<Record<string, UpdateStatus>>;
