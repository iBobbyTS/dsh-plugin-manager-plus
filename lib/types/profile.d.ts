/**
 * Profile filesystem reads — everything the market learns from a dsh
 * profile directory (manifest, lockfile, installed package trees). Pure
 * functions of the directory contents; no processes, no network.
 */
/** Resolve a profile name to its directory under DSH_HOME (default ~/.dsh). */
export declare function profileDir(profile: string): string;
/** Community dependencies of the profile (in-box bundles filtered out). */
export declare function readInstalled(profile: string): Record<string, string>;
/**
 * Parse a profile's cordis.patch.yml for `- insert:` blocks and return the
 * plugin names declared in each `name:` entry. Uses a light regex — the same
 * approach as pnpm-workspace.yaml handling elsewhere.
 */
export declare function readPatchInserts(profile: string): string[];
/** The version actually present in the profile's node_modules, or null. */
export declare function readInstalledVersion(profile: string, name: string): string | null;
/**
 * Resolve the GitHub repo URL of an installed plugin from its own manifest:
 * `repository.url` (npm convention, e.g. "git+https://github.com/o/r.git")
 * or `homepage` pointing at GitHub. Returns null when the plugin declares no
 * GitHub source (then the UI marks it "local").
 */
export declare function readInstalledRepo(profile: string, name: string): string | null;
/** Pinned commit per `owner/repo` from the profile lockfile's codeload tarball URLs. */
export declare function readLockCommits(profile: string): Map<string, string>;
/** True when the installed package's manifest declares a dsh plugin surface. */
export declare function hasDshManifest(dir: string): boolean;
/**
 * True when the package's declared entry artifact actually exists — github
 * source checkouts of build-required plugins ship no lib/, and promoting one
 * into the bundle layer bricks the next boot (ERR_MODULE_NOT_FOUND kills the
 * whole profile, #18).
 */
export declare function entryArtifactExists(dir: string): boolean;
/** Plugin subdirectories (depth 2) of a collection checkout, as relative paths. */
export declare function pluginSubdirs(root: string): string[];
/**
 * Allow the given packages' build scripts in the profile's
 * pnpm-workspace.yaml `allowBuilds` block (the key dsh profiles use),
 * merging with existing entries and leaving the rest of the yaml intact.
 * (#6 by @qichuang321.)
 *
 * Also removes pnpm's own failed-install placeholder rows
 * (`pkg: set this to true or false`, pnpm bug #11535) — those are literal
 * strings that break every later approval until dropped.
 * @returns every package now allowed.
 */
export declare function setAllowBuilds(profile: string, packages: string[]): string[];
/**
 * Add fully-qualified package specs to the profile's pnpm-workspace.yaml
 * `onlyBuiltDependencies` list. pnpm >=10 requires the COMPLETE spec (e.g.
 * "@scope/name@git+https://github.com/o/r.git#<sha>") for git-hosted
 * packages whose build scripts must run — the short name or the legacy
 * `allowBuilds` key is rejected with ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED.
 * The specs are taken verbatim from pnpm's own error suggestion, so they
 * match exactly. Merges with existing entries; idempotent.
 * @returns the specs that were newly added.
 */
export declare function setOnlyBuiltDependencies(profile: string, specs: string[]): string[];
/**
 * Snapshots the profile's package.json before a mutating operation, returning
 * the snapshot path or null on failure. (Port from Sanqi/dsh-webui-market-plugin)
 */
export declare function snapshotProfile(profile: string): string | null;
/**
 * Disable or re-enable a community plugin: moves it out of the profile's
 * `dsh.profile.bundles` (or back in) and records the state in
 * `dsh.market.disabled` (preserving re-enable order). (Port from
 * Sanqi/dsh-webui-market-plugin.)
 * @returns true when the state changed, false when it was already as requested.
 */
export declare function setDisabledState(profile: string, name: string, disabled: boolean): boolean;
/**
 * Re-apply the disabled state after any operation that might have touched
 * the profile manifest. Ensures disabled plugins stay dormant.
 * (Port from Sanqi/dsh-webui-market-plugin.)
 */
export declare function reapplyDisabledState(profile: string): void;
