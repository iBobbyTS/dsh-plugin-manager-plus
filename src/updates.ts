/**
 * Update detection: per-plugin comparison of what the profile has against
 * the source of truth — git HEAD for github installs, the npm latest
 * dist-tag for registry installs — with a TTL cache.
 */

import { readInstalled, readInstalledVersion, readLockCommits } from './profile.ts'

export interface UpdateStatus {
  kind: 'github' | 'npm' | 'linked'
  version: string | null
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

const UPDATES_TTL_MS = 30 * 60 * 1000
let updatesCache: { at: number; data: Record<string, UpdateStatus> } | null = null

/** Drop the cached listing (after a successful install/update/uninstall). */
export function invalidateUpdates(): void {
  updatesCache = null
}

/** @internal exported for routes.ts (lock sha update) */
export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-manager' },
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as unknown
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
export async function latestPublishedRecently(name: string, windowMs = 26 * 60 * 60 * 1000): Promise<boolean | null> {
  try {
    const doc = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)) as {
      'dist-tags'?: Record<string, string>
      time?: Record<string, string>
    }
    const latest = doc['dist-tags']?.latest
    const published = latest !== undefined ? doc.time?.[latest] : undefined
    if (published === undefined) return null
    const age = Date.now() - Date.parse(published)
    return Number.isFinite(age) ? age < windowMs : null
  } catch {
    return null
  }
}

/** Per-plugin update checks; a failed check reports no update rather than failing the listing. */
export async function checkUpdates(profile: string, force = false): Promise<Record<string, UpdateStatus>> {
  if (!force && updatesCache && Date.now() - updatesCache.at < UPDATES_TTL_MS) return updatesCache.data
  const installed = readInstalled(profile)
  const lockCommits = readLockCommits(profile)
  const result: Record<string, UpdateStatus> = {}
  await Promise.all(Object.entries(installed).map(async ([name, spec]) => {
    const version = readInstalledVersion(profile, name)
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      return
    }
    const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    try {
      if (spec.startsWith('github:') && gh !== null) {
        const current = lockCommits.get(gh[1].toLowerCase()) ?? null
        const head = (await fetchJson(`https://api.github.com/repos/${gh[1]}/commits/HEAD`)) as { sha?: string }
        const latest = typeof head.sha === 'string' ? head.sha : null
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: current !== null && latest !== null && current !== latest,
        }
      } else {
        const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)) as { version?: string }
        const latest = typeof meta.version === 'string' ? meta.version : null
        result[name] = {
          kind: 'npm', version, current: version, latest,
          updateAvailable: version !== null && latest !== null && version !== latest,
        }
      }
    } catch {
      result[name] = { kind: spec.startsWith('github:') ? 'github' : 'npm', version, current: null, latest: null, updateAvailable: false }
    }
  }))
  updatesCache = { at: Date.now(), data: result }
  return result
}
