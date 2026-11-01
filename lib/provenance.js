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
/** In-box bundles shipped with every web profile. */
const INBOX_BUNDLES = new Set([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-headless',
]);
/** Official GitHub organizations. */
const OFFICIAL_OWNERS = new Set(['deepseek-ai', 'dsh-external']);
/** Official package scopes. */
const OFFICIAL_SCOPES = ['@deepseek-ai/'];
/**
 * Determine the provenance of a plugin.
 * @param name - Package name (e.g. `@deepseek-ai/dsh-base`, `dsh-plugin-tts`)
 * @param owner - GitHub owner (e.g. `deepseek-ai`, `1624318455`), or empty
 * @param trust - Optional explicit trust level from the registry
 */
export function classifyProvenance(name, owner, trust) {
    // 1. Explicit trust level from registry
    if (trust === 'official')
        return 'official';
    // 2. In-box bundle
    if (INBOX_BUNDLES.has(name))
        return 'official';
    // 3. Package name scope
    for (const scope of OFFICIAL_SCOPES) {
        if (name.startsWith(scope))
            return 'official';
    }
    // 4. GitHub owner
    if (owner && OFFICIAL_OWNERS.has(owner))
        return 'official';
    // 5. Everything else
    return 'community';
}
/**
 * Get a display label for the provenance.
 */
export function provenanceLabel(provenance, locale = 'zh') {
    if (locale === 'zh') {
        return provenance === 'official' ? '官方' : '社区';
    }
    return provenance === 'official' ? 'Official' : 'Community';
}
/**
 * Get a CSS class suffix for the provenance badge.
 */
export function provenanceBadgeClass(provenance) {
    return provenance === 'official' ? 'official' : 'community';
}
