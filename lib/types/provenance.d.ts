/**
 * Plugin provenance: determines whether a plugin is official (from the
 * deepseek-ai team) or third-party community. Used for UI badges, filtering,
 * and install warnings.
 *
 * Source hierarchy (first match wins):
 * 1. Registry `trust` field (explicitly curated)
 * 2. Package name starts with `@deepseek-ai/` → official
 * 3. GitHub owner is `deepseek-ai` or `dsh-external` → official
 * 4. In-box bundle (INBOX_BUNDLES) → official
 * 5. Everything else → community
 */
/** Provenance levels. */
export type Provenance = 'official' | 'community';
/** Tags for the registry entry schema. */
export type TrustLevel = 'official' | 'curated' | 'community';
/**
 * Determine the provenance of a plugin.
 * @param name - Package name (e.g. `@deepseek-ai/dsh-base`, `dsh-plugin-tts`)
 * @param owner - GitHub owner (e.g. `deepseek-ai`, `1624318455`), or empty
 * @param trust - Optional explicit trust level from the registry
 */
export declare function classifyProvenance(name: string, owner?: string, trust?: TrustLevel | string): Provenance;
/**
 * Get a display label for the provenance.
 */
export declare function provenanceLabel(provenance: Provenance, locale?: 'zh' | 'en'): string;
/**
 * Get a CSS class suffix for the provenance badge.
 */
export declare function provenanceBadgeClass(provenance: Provenance): string;
