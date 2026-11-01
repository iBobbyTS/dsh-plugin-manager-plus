/**
 * Update detection: per-plugin comparison of what the profile has against
 * the source of truth — git HEAD for github installs, the npm latest
 * dist-tag for registry installs — with a TTL cache.
 */
import { readInstalled, readInstalledVersion, readLockCommits } from './profile.js';
const UPDATES_TTL_MS = 30 * 60 * 1000;
let updatesCache = null;
/** Drop the cached listing (after a successful install/update/uninstall). */
export function invalidateUpdates() {
    updatesCache = null;
}
/** @internal exported for routes.ts (lock sha update) */
export async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-manager' },
        signal: AbortSignal.timeout(4000),
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    return res.json();
}
/**
 * Evidence check behind the "wait a day" stale diagnosis (#45): whether the
 * package's CURRENT latest release was published recently enough to sit
 * inside pnpm's default fresh-release window. pnpm's silent hold leaves no
 * trace in its output, so the publish time is the only verifiable signal.
 * @returns true/false when the npm time metadata answers, null when it
 *   can't be determined (offline, unpublished, non-npm) — callers must NOT
 *   claim the safety wait on null.
 */
export async function latestPublishedRecently(name, windowMs = 26 * 60 * 60 * 1000) {
    try {
        const doc = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`));
        const latest = doc['dist-tags']?.latest;
        const published = latest !== undefined ? doc.time?.[latest] : undefined;
        if (published === undefined)
            return null;
        const age = Date.now() - Date.parse(published);
        return Number.isFinite(age) ? age < windowMs : null;
    }
    catch {
        return null;
    }
}
/** Recognize GitHub dependency sources; never infer a Git source from npm package metadata. */
export function githubRepoFromSpec(spec) {
    const match = /^(?:github:|(?:git\+)?https:\/\/github\.com\/|git\+ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/.exec(spec);
    return match?.[1] ?? null;
}
/** Per-plugin update checks; a failed check reports no update rather than failing the listing. */
export async function checkUpdates(profile, force = false) {
    if (!force && updatesCache && Date.now() - updatesCache.at < UPDATES_TTL_MS)
        return updatesCache.data;
    const installed = readInstalled(profile);
    const lockCommits = readLockCommits(profile);
    const result = {};
    await Promise.all(Object.entries(installed).map(async ([name, spec]) => {
        const version = readInstalledVersion(profile, name);
        if (spec.startsWith('link:') || spec.startsWith('file:')) {
            result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false };
            return;
        }
        const gh = githubRepoFromSpec(spec);
        try {
            if (gh !== null) {
                const current = lockCommits.get(gh.toLowerCase()) ?? null;
                const head = (await fetchJson(`https://api.github.com/repos/${gh}/commits/HEAD`));
                const latest = typeof head.sha === 'string' && /^[0-9a-f]{40}$/i.test(head.sha) ? head.sha : null;
                let behind = null;
                let ahead = null;
                if (current !== null && latest !== null) {
                    if (current === latest) {
                        behind = 0;
                        ahead = 0;
                    }
                    else if (/^[0-9a-f]{40}$/i.test(current)) {
                        try {
                            // ahead_by counts commits in the remote head missing from our installed base.
                            // behind_by counts commits in the installed base missing from remote HEAD.
                            const comparison = (await fetchJson(`https://api.github.com/repos/${gh}/compare/${current}...${latest}?per_page=1`));
                            if (typeof comparison.ahead_by === 'number'
                                && typeof comparison.behind_by === 'number'
                                && Number.isSafeInteger(comparison.ahead_by) && comparison.ahead_by >= 0
                                && Number.isSafeInteger(comparison.behind_by) && comparison.behind_by >= 0) {
                                behind = comparison.ahead_by;
                                ahead = comparison.behind_by;
                            }
                        }
                        catch {
                            // Missing history, network failures, and API rate limits are "unknown", not zero.
                        }
                    }
                }
                result[name] = {
                    kind: 'github', version, current, latest, repo: gh, behind, ahead,
                    updateAvailable: current !== null && latest !== null && current !== latest,
                };
            }
            else {
                const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`));
                const latest = typeof meta.version === 'string' ? meta.version : null;
                result[name] = {
                    kind: 'npm', version, current: version, latest,
                    updateAvailable: version !== null && latest !== null && version !== latest,
                };
            }
        }
        catch {
            result[name] = { kind: gh !== null ? 'github' : 'npm', version, current: null, latest: null, repo: gh ?? undefined, behind: gh !== null ? null : undefined, ahead: gh !== null ? null : undefined, updateAvailable: false };
        }
    }));
    updatesCache = { at: Date.now(), data: result };
    return result;
}
