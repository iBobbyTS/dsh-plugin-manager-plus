/**
 * Help-prompt generation: when an operation (install / sync backup / sync
 * restore) fails, the UI offers a "start a new conversation for help" action
 * that copies a self-contained, context-rich prompt to the clipboard. The
 * user pastes it into a new DSH conversation and the model gets everything it
 * needs to diagnose the failure.
 *
 * Prompts are pure functions of the failure data — no I/O here.
 */
/** One installed plugin's identity for context. */
export interface PluginContext {
    name: string;
    spec: string;
    repoUrl: string | null;
}
/** Everything the install-help prompt needs. */
export interface InstallFailureContext {
    pluginName: string;
    pluginUrl: string;
    profile: string;
    exitCode: number | null;
    timedOut: boolean;
    /** stdout+stderr tail from the failed run. */
    output: string;
    /** Packages pnpm blocked on build scripts (allowBuilds/onlyBuiltDependencies). */
    blockedBuilds: string[];
    /** Installed plugin list for context. */
    installed: PluginContext[];
    dshVersion: string;
    pluginManagerVersion: string;
}
/** Everything the sync-help prompt needs. */
export interface SyncFailureContext {
    action: 'backup' | 'restore';
    repo: string;
    branch: string;
    errorCode: string;
    errorMessage: string;
    hint: string;
    /** Local plugins that could not be auto-restored. */
    localPlugins: string[];
    profile: string;
    dshVersion: string;
    pluginManagerVersion: string;
}
/**
 * Build the install-failure help prompt.
 * @returns a prompt the user pastes into a new conversation.
 */
export declare function buildInstallHelpPrompt(ctx: InstallFailureContext): string;
/**
 * Build the sync (backup/restore) help prompt.
 * @returns a prompt the user pastes into a new conversation.
 */
export declare function buildSyncHelpPrompt(ctx: SyncFailureContext): string;
