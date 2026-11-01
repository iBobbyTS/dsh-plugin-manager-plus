export interface SyncConfig {
    enabled: boolean;
    /** GitHub repository in "owner/repo" format. */
    repo: string;
    /** Branch to push/pull the manifest. */
    branch: string;
    /** Optional GitHub personal access token (classic or fine-grained). */
    token?: string;
    /** Last successful sync timestamp (for display). */
    lastSyncAt?: string | null;
    /** Last error message (for display, transient). */
    lastError?: string | null;
}
export interface SyncManifest {
    format: 'dsh-plugin-manifest';
    version: number;
    generatedAt: string;
    dsh: {
        version?: string;
        profile: string;
    };
    plugins: Array<{
        name: string;
        spec: string;
        commit: string | null;
        version: string | null;
        npm: string | null;
        /** GitHub repo URL resolved from the plugin manifest (repository field). */
        repo?: string;
        /** True when the plugin has no GitHub/npm URL and can't be auto-restored. */
        local?: boolean;
        /** Human-readable hint for manual restore. */
        localHint?: string;
    }>;
    /** Full file payloads of local-only plugins (path → base64 content). */
    localPlugins?: Record<string, Record<string, string>>;
}
export interface SyncError {
    /** Machine-readable error code. */
    code: SyncErrorCode;
    /** Human-readable message in Chinese + English. */
    message: string;
    /** Whether the operation can be retried as-is. */
    retryable: boolean;
    /** Suggested user action. */
    hint: string;
}
export type SyncErrorCode = 'not-configured' | 'not-enabled' | 'network-error' | 'auth-failed' | 'forbidden' | 'rate-limited' | 'not-found' | 'conflict' | 'invalid-manifest' | 'empty-manifest' | 'unknown';
/** Read the sync config. Returns default (disabled) when not configured. */
export declare function readSyncConfig(profile: string): SyncConfig;
/** Write the sync config. Returns the merged config. */
export declare function writeSyncConfig(profile: string, update: Partial<SyncConfig>): SyncConfig;
/** Validate the sync config. Returns the first error, or null if OK. */
export declare function validateConfig(config: SyncConfig): SyncError | null;
/** Test the GitHub API connection. Returns the first error, or null if OK. */
export declare function testConnection(config: SyncConfig): Promise<SyncError | null>;
/** Export installed plugins as a sync manifest (lockfile). */
export declare function exportSyncManifest(profile: string, profileName: string, includeLocal?: boolean): SyncManifest;
/**
 * Pack a local plugin's files from the profile's node_modules into a
 * path → base64 map (including nested dependencies under its node_modules,
 * so the restore is complete without any registry access).
 * @returns the file map, or null when the package directory is missing.
 */
export declare function packLocalPlugin(profile: string, name: string): Record<string, string> | null;
/**
 * Restore a packed local plugin from the manifest into the profile's
 * node_modules. Returns the plugin's directory on success or null on failure.
 */
export declare function unpackLocalPlugin(profile: string, name: string, files: Record<string, string>): boolean;
/** Compute the diff between a remote manifest and local state. */
export declare function diffManifest(manifest: SyncManifest, profile: string): {
    toInstall: SyncManifest['plugins'];
    alreadyInstalled: SyncManifest['plugins'];
    skipped: SyncManifest['plugins'];
    errors: string[];
};
/** Build install targets for restore. */
export declare function restoreTarget(plugin: SyncManifest['plugins'][0]): string;
/**
 * Push the manifest to GitHub. Creates or updates the file.
 * @returns error on failure, or { url, sha } on success.
 */
export declare function pushManifest(config: SyncConfig, manifest: SyncManifest): Promise<{
    error?: SyncError;
    url?: string;
    sha?: string;
}>;
/**
 * Pull the manifest from GitHub.
 * @returns error on failure, or { manifest, source } on success.
 */
export declare function pullManifest(config: SyncConfig): Promise<{
    error?: SyncError;
    manifest?: SyncManifest;
    source?: 'github' | 'offline';
}>;
/** Get a user-friendly category for a SyncError, for UI grouping. */
export declare function errorCategory(code: SyncErrorCode): 'config' | 'network' | 'auth' | 'github' | 'data';
/** Get a Chinese action label for an error code. */
export declare function errorAction(code: SyncErrorCode): string | null;
