/**
 * Profile filesystem reads — everything the market learns from a dsh
 * profile directory (manifest, lockfile, installed package trees). Pure
 * functions of the directory contents; no processes, no network.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve a profile name to its directory under DSH_HOME (default ~/.dsh). */
export function profileDir(profile: string): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

/**
 * The in-box bundles dsh's profile templates install themselves — the ONLY
 * names the market hides from the installed list. Community plugins may
 * legitimately publish under the official scope (#28), so a whole-scope
 * filter would make them invisible and fail install validation.
 * (Diagnosis and fix proposed in #28 by @Lograthmic.)
 */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/** Community dependencies of the profile (in-box bundles filtered out). */
export function readInstalled(profile: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    const installed: Record<string, string> = {}
    // 1. Read from dependencies (where dsh plugin add puts entries)
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!INBOX_BUNDLES.has(name)) installed[name] = spec
    }
    // 2. Also include items from dsh.profile.bundles not in dependencies
    //    (e.g. provisioned by desktop shell or added manually)
    for (const name of manifest.dsh?.profile?.bundles ?? []) {
      if (!INBOX_BUNDLES.has(name) && installed[name] === undefined) {
        installed[name] = `bundles:${name}`
      }
    }
    // 3. Also include plugins declared in the profile's own cordis.patch.yml
    //    `- insert: { name: ... }` entries (manual patch-layer additions,
    //    e.g. client-only plugins loaded outside the bundle/dependency system)
    for (const name of readPatchInserts(profile)) {
      if (!INBOX_BUNDLES.has(name) && installed[name] === undefined) {
        installed[name] = `patch:${name}`
      }
    }
    return installed
  } catch {
    return {}
  }
}

/**
 * Parse a profile's cordis.patch.yml for `- insert:` blocks and return the
 * plugin names declared in each `name:` entry. Uses a light regex — the same
 * approach as pnpm-workspace.yaml handling elsewhere.
 */
export function readPatchInserts(profile: string): string[] {
  const names: string[] = []
  try {
    const patch = readFileSync(join(profileDir(profile), 'cordis.patch.yml'), 'utf8')
    // Split on top-level `- insert:` blocks; each block lists `name:` entries.
    const sections = patch.split(/\n\s*- insert:/).slice(1)
    for (const section of sections) {
      for (const nm of section.matchAll(/^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)) {
        names.push(nm[1]!)
      }
    }
  } catch { /* no patch file — nothing to add */ }
  return names
}

/** The version actually present in the profile's node_modules, or null. */
export function readInstalledVersion(profile: string, name: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the GitHub repo URL of an installed plugin from its own manifest:
 * `repository.url` (npm convention, e.g. "git+https://github.com/o/r.git")
 * or `homepage` pointing at GitHub. Returns null when the plugin declares no
 * GitHub source (then the UI marks it "local").
 */
export function readInstalledRepo(profile: string, name: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { repository?: { url?: string } | string; homepage?: string }
    const candidates: string[] = []
    if (typeof manifest.repository === 'string') candidates.push(manifest.repository)
    if (manifest.repository && typeof manifest.repository === 'object' && typeof manifest.repository.url === 'string') {
      candidates.push(manifest.repository.url)
    }
    if (typeof manifest.homepage === 'string') candidates.push(manifest.homepage)
    for (const raw of candidates) {
      // Normalize: git+https://github.com/o/r.git → https://github.com/o/r
      const m = /(?:git\+)?https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw.trim())
      if (m) return `https://github.com/${m[1]}`
    }
    return null
  } catch {
    return null
  }
}

/** Pinned commit per `owner/repo` from the profile lockfile's codeload tarball URLs. */
export function readLockCommits(profile: string): Map<string, string> {
  const commits = new Map<string, string>()
  try {
    const lock = readFileSync(join(profileDir(profile), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
      commits.set(m[1].toLowerCase(), m[2])
    }
  } catch { /* no lockfile — no git installs to report */ }
  return commits
}

/** True when the installed package's manifest declares a dsh plugin surface. */
export function hasDshManifest(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh?: unknown }
    return manifest.dsh !== undefined
  } catch {
    return false
  }
}

/**
 * True when the package's declared entry artifact actually exists — github
 * source checkouts of build-required plugins ship no lib/, and promoting one
 * into the bundle layer bricks the next boot (ERR_MODULE_NOT_FOUND kills the
 * whole profile, #18).
 */
export function entryArtifactExists(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      main?: string
      exports?: Record<string, unknown> | string
    }
    const candidates: string[] = []
    if (typeof manifest.main === 'string') candidates.push(manifest.main)
    const rootExport = typeof manifest.exports === 'string'
      ? manifest.exports
      : (manifest.exports as Record<string, unknown> | undefined)?.['.']
    if (typeof rootExport === 'string') candidates.push(rootExport)
    else if (rootExport !== null && typeof rootExport === 'object') {
      for (const value of Object.values(rootExport)) if (typeof value === 'string') candidates.push(value)
    }
    if (candidates.length === 0) candidates.push('index.js')
    return candidates.some(rel => existsSync(join(dir, rel)))
  } catch {
    return false
  }
}

/** Plugin subdirectories (depth 2) of a collection checkout, as relative paths. */
export function pluginSubdirs(root: string): string[] {
  const found: string[] = []
  let level1: string[] = []
  try {
    level1 = readdirSync(root, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && /^[A-Za-z0-9_.-]+$/.test(dirent.name) && dirent.name !== 'node_modules')
      .map(dirent => dirent.name)
  } catch {
    return found
  }
  for (const sub of level1) {
    if (hasDshManifest(join(root, sub))) {
      found.push(sub)
      continue
    }
    try {
      for (const inner of readdirSync(join(root, sub), { withFileTypes: true })) {
        if (!inner.isDirectory() || !/^[A-Za-z0-9_.-]+$/.test(inner.name) || inner.name === 'node_modules') continue
        if (hasDshManifest(join(root, sub, inner.name))) found.push(`${sub}/${inner.name}`)
      }
    } catch { /* unreadable level — skip */ }
    if (found.length >= 8) break
  }
  return found.slice(0, 8)
}

/**
 * Allow the given packages' build scripts in the profile's
 * pnpm-workspace.yaml `allowBuilds` block (the key dsh profiles use),
 * merging with existing entries and leaving the rest of the yaml intact.
 * (#6 by @qichuang321.)
 * @returns every package now allowed.
 */
export function setAllowBuilds(profile: string, packages: string[]): string[] {
  const file = join(profileDir(profile), 'pnpm-workspace.yaml')
  let yaml = ''
  try { yaml = readFileSync(file, 'utf8') } catch { /* created below */ }
  const blockRe = /allowBuilds:\n((?:[ \t]+[^\n]*\n?)*)/
  const map: Record<string, string> = {}
  const blockMatch = blockRe.exec(yaml)
  if (blockMatch !== null) {
    for (const line of blockMatch[1].split('\n')) {
      const m = /^[ \t]+([^:\s]+(?:\/[^:\s]+)?)\s*:\s*(\S.*)?$/.exec(line)
      if (m === null) continue
      // Keep only real booleans: pnpm's failed-install bug (#11535, seen in
      // our #56) writes a literal "set this to true or false" placeholder,
      // which breaks every later approval until the entry is dropped.
      const value = (m[2] ?? 'true').trim()
      if (/^(true|false)$/.test(value)) map[m[1]] = value
    }
  }
  for (const pkg of packages) {
    if (/^[A-Za-z0-9@/_.-]+$/.test(pkg)) map[pkg] = 'true'
  }
  const block = Object.entries(map).map(([k, v]) => `  ${k}: ${v}`).join('\n')
  const blockText = `allowBuilds:\n${block}\n`
  writeFileSync(file, blockMatch !== null ? yaml.replace(blockRe, blockText) : `${yaml.replace(/\n?$/, '\n')}${blockText}`)
  return Object.keys(map)
}

/**
 * Snapshots the profile's package.json before a mutating operation, returning
 * the snapshot path or null on failure. (Port from Sanqi/dsh-webui-market-plugin)
 */
export function snapshotProfile(profile: string): string | null {
  try {
    const p = join(profileDir(profile), 'package.json')
    if (!existsSync(p)) return null
    const snap = `${p}.pm-snapshot-${Date.now()}.json`
    writeFileSync(snap, readFileSync(p, 'utf8'))
    return snap
  } catch {
    return null
  }
}

/**
 * Disable or re-enable a community plugin: moves it out of the profile's
 * `dsh.profile.bundles` (or back in) and records the state in
 * `dsh.market.disabled` (preserving re-enable order). (Port from
 * Sanqi/dsh-webui-market-plugin.)
 * @returns true when the state changed, false when it was already as requested.
 */
export function setDisabledState(profile: string, name: string, disabled: boolean): boolean {
  const file = join(profileDir(profile), 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const dsh = (typeof manifest.dsh === 'object' && manifest.dsh !== null
      ? (manifest.dsh as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const bundles = Array.isArray(dsh.profile && typeof dsh.profile === 'object' && (dsh.profile as Record<string, unknown>).bundles)
      ? [...((dsh.profile as Record<string, unknown>).bundles as string[])]
      : []
    const market = (typeof dsh.market === 'object' && dsh.market !== null
      ? (dsh.market as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const disabledList = Array.isArray(market.disabled)
      ? (market.disabled as Array<{ name: string; index: number }>).map(e => ({ ...e }))
      : []
    const inBundles = bundles.includes(name)
    const inDisabled = disabledList.some(e => e.name === name)

    if (disabled && inBundles && !inDisabled) {
      dsh.profile = { ...(dsh.profile as Record<string, unknown>), bundles: bundles.filter(b => b !== name) }
      disabledList.push({ name, index: disabledList.length })
      dsh.market = { ...market, disabled: disabledList }
      manifest.dsh = dsh
      writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
      return true
    }
    if (!disabled && inDisabled) {
      const idx = disabledList.findIndex(e => e.name === name)
      if (idx !== -1) disabledList.splice(idx, 1)
      dsh.profile = { ...(dsh.profile as Record<string, unknown>), bundles: [...bundles, name] }
      dsh.market = disabledList.length > 0 ? { ...market, disabled: disabledList } : { ...market }
      if (disabledList.length === 0) delete (dsh.market as Record<string, unknown>).disabled
      manifest.dsh = dsh
      writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Re-apply the disabled state after any operation that might have touched
 * the profile manifest. Ensures disabled plugins stay dormant.
 * (Port from Sanqi/dsh-webui-market-plugin.)
 */
export function reapplyDisabledState(profile: string): void {
  const file = join(profileDir(profile), 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const dsh = (typeof manifest.dsh === 'object' && manifest.dsh !== null
      ? (manifest.dsh as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const market = (typeof dsh.market === 'object' && dsh.market !== null
      ? (dsh.market as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const disabledList = Array.isArray(market.disabled)
      ? (market.disabled as Array<{ name: string }>).map(e => e.name)
      : []
    if (disabledList.length === 0) return
    const bundles = Array.isArray(dsh.profile && typeof dsh.profile === 'object' && (dsh.profile as Record<string, unknown>).bundles)
      ? [...((dsh.profile as Record<string, unknown>).bundles as string[])]
      : []
    let changed = false
    for (const name of disabledList) {
      const idx = bundles.indexOf(name)
      if (idx !== -1) {
        bundles.splice(idx, 1)
        changed = true
      }
    }
    if (changed) {
      dsh.profile = { ...(dsh.profile as Record<string, unknown>), bundles }
      manifest.dsh = dsh
      writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
    }
  } catch { /* best-effort */ }
}
