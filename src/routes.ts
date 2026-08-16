/**
 * HTTP routes bridging the browser market UI to the host. This layer only
 * parses requests, calls the service modules, and serializes responses —
 * process spawning lives in dsh-cli.ts, filesystem reads in profile.ts,
 * orchestration in install.ts / themes.ts / updates.ts.
 *
 * Security: the install route executes a shell command, so it accepts only
 * same-origin POSTs and only sources present in the curated registry.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadRegistry } from './registry.ts'
import {
  cleanHotDir, hotMount, hotUnmount, listHotMounts,
  mountClientOnlyDeps, readDisabledThemes,
} from './hot.ts'
import { exportLogs, logEvent } from './log.ts'
import { BOOT_ID, cancelActive, probePnpm, progress, provisionPnpm, runDshPlugin } from './dsh-cli.ts'
import { profileDir, readInstalled, readInstalledVersion, readInstalledRepo, readLockCommits, setAllowBuilds, snapshotProfile, setDisabledState, reapplyDisabledState } from './profile.ts'
import { findInstalledAlias, installTargetFor } from './sources.ts'
import { isStaleUpdate, parseIgnoredBuilds, RELEASE_AGE_OVERRIDE, retargetCollections, validateAddedPlugins, withHoistRecovery } from './install.ts'
import { checkUpdates, invalidateUpdates, latestPublishedRecently, fetchJson } from './updates.ts'
import { createThemeManager, type LoaderEntry } from './themes.ts'
import { readJsonBody, sameOrigin, sendJson } from './http.ts'
import { restartAllowed, scheduleRestart, trustedRestartRequest } from './restart.ts'
import { verifyActivation } from './verify.ts'
import { enqueueOp, waitForTurn, settleOp, isRunning, listOps, killOp, clearOps, appendOpOutput, findActiveOp } from './op-queue.ts'
import { classifyProvenance } from './provenance.ts'
import { exportSyncManifest, readSyncConfig, writeSyncConfig, diffManifest, restoreTarget, testConnection, pushManifest, pullManifest, validateConfig, unpackLocalPlugin, type SyncManifest } from './sync.ts'

export type { LoaderEntry } from './themes.ts'
export type { UpdateStatus } from './updates.ts'

/**
 * Ensure a plugin is registered in the profile's own cordis.patch.yml via an
 * `- insert:` entry (the mechanism used for manually deployed plugins like
 * client-only ones that have no dsh.bundle.patch). Idempotent.
 */
function ensurePatchInsert(profile: string, name: string): void {
  try {
    const file = join(profileDir(profile), 'cordis.patch.yml')
    let yaml = ''
    try { yaml = readFileSync(file, 'utf8') } catch { /* created below */ }
    // Skip when already inserted
    if (new RegExp(`- insert:[\\s\\S]*?name:\\s*['"]?${escapeRegExp(name)}['"]?\\s*$`, 'm').test(yaml)) return
    const insertBlock = `\n- insert:\n    - id: ${name}\n      name: '${name}'\n`
    writeFileSync(file, yaml.replace(/\n?$/, '\n') + insertBlock)
  } catch (error) {
    logEvent('error', 'sync-restore', `ensurePatchInsert(${name}) failed: ${String(error)}`)
  }
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface MarketHost {
  webServer: WebServerService
  loader: { entries(): Iterable<LoaderEntry> }
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
  on?(event: string, callback: (fiber: { entry?: { options?: { name?: string } } }) => void): () => void
  logger?: { info?(message: string): void; warn(message: string): void }
}

export interface MarketConfig {
  /** Profile the market installs into; matches the profile serving this UI. */
  profile: string
  /** Detached self-restart is unsafe under systemd/launchd/pm2; operators can disable it (#14). */
  allowRestart?: boolean
}

const PROFILE_RE = /^[A-Za-z0-9_-]+$/

/**
 * Register the market's HTTP routes.
 * @param host - Acquired webServer + shell services.
 * @param config - Validated market configuration.
 * @returns Disposer removing every registered route.
 */
export function mountMarketRoutes(host: MarketHost, config: MarketConfig): () => void {
  if (!PROFILE_RE.test(config.profile)) {
    throw new Error(`plugin-manager: invalid profile name: ${config.profile}`)
  }
  // Boot-time wipe: stale hot-mount inputs from a previous session must never
  // survive into a composition where the bundle layer already covers them.
  cleanHotDir(profileDir(config.profile))
  // The user's persisted theme choice; activateTheme mutates and writes it.
  const disabledThemes = readDisabledThemes(profileDir(config.profile))
  const themes = createThemeManager(host, config.profile, disabledThemes)

  // Client-only packages (dsh.client without dsh.bundle) are invisible to the
  // bundle layer in every boot; the market shim-mounts them so their client
  // bundles are actually served.
  void mountClientOnlyDeps(host, profileDir(config.profile)).then(async (mounted) => {
    if (mounted.length > 0) logEvent('info', 'boot', `client-only shims mounted: ${mounted.join(', ')}`)
    // Replay the user's theme choice: bundle-layer themes they switched away
    // from get live-disabled again (bundle trees are in-memory, so the
    // disable never persists on its own).
    for (const name of disabledThemes) {
      if (await themes.setEntryDisabled(name, true)) logEvent('info', 'boot', `theme kept off: ${name}`)
    }
  })

  // Self-healing guard: dsh's own patch overlay can re-update entries during
  // activation and wipe the runtime disabled flag — whenever a fiber comes up
  // for a theme the user switched off, put it back down.
  host.on?.('internal/plugin', (fiber) => {
    const name = fiber.entry?.options?.name
    if (name !== undefined && disabledThemes.has(name)) void themes.setEntryDisabled(name, true)
  })
  let runningOpId: string | null = null
  let restarting = false

  /** Dependency diff vs. a pre-operation snapshot (cancel aftermath). */
  function changedSince(before: Record<string, string>): { changed: string[]; partial: boolean } {
    const now = readInstalled(config.profile)
    const changed = new Set<string>()
    for (const [name, spec] of Object.entries(now)) if (before[name] !== spec) changed.add(name)
    for (const name of Object.keys(before)) if (now[name] === undefined) changed.add(name)
    return { changed: [...changed], partial: changed.size > 0 }
  }

  /**
   * Everything live in the running composition: market hot mounts plus
   * bundle-layer loader entries whose fiber is up (loaded at boot). This is
   * the source of truth for verifyActivation's `live` state — without the
   * loader side, every boot-loaded bundle plugin would read as "restart".
   */
  function liveNames(): Set<string> {
    const live = new Set(listHotMounts())
    for (const entry of host.loader.entries()) {
      if (entry.fiber !== undefined && entry.options.name !== undefined) live.add(entry.options.name)
    }
    return live
  }

  /**
   * Drop live hot mounts whose package was removed outside the market
   * (e.g. `dsh plugin remove` in a terminal): the stale mount would keep
   * serving a client bundle that 404s after refresh, wedging the page
   * until a restart (#29 by @SunYanbox).
   */
  async function dropStaleHotMounts(): Promise<void> {
    for (const name of listHotMounts()) {
      if (existsSync(join(profileDir(config.profile), 'node_modules', name, 'package.json'))) continue
      await hotUnmount(name)
      logEvent('warn', 'hot-sweep', `${name}: package removed outside the market — live mount dropped`)
    }
  }

  /** Every plugin command goes through the pnpm-drift recovery wrapper (#20). */
  const runPlugin = (profile: string, args: string[]) => withHoistRecovery(runDshPlugin, profile, args)

  const disposers = [
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/registry',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const { registry, source } = await loadRegistry()
          // Add provenance trust level to each registry entry
          const enriched = {
            ...registry,
            plugins: registry.plugins.map(p => ({
              ...p,
              trust: classifyProvenance(p.name, p.owner, undefined),
            })),
          }
          sendJson(response, 200, { source, registry: enriched })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/installed',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        await dropStaleHotMounts()
        const installed = readInstalled(config.profile)
        const activation: Record<string, ReturnType<typeof verifyActivation>> = {}
        const provenance: Record<string, string> = {}
        const repoUrls: Record<string, string> = {}
        const live = liveNames()
        for (const name of Object.keys(installed)) {
          activation[name] = verifyActivation(config.profile, name, live)
          provenance[name] = classifyProvenance(name)
          // Resolve a GitHub URL from the plugin's own manifest (repository
          // field) so self-authored plugins uploaded to GitHub are not
          // mislabeled "local".
          const repo = readInstalledRepo(config.profile, name)
          if (repo !== null) repoUrls[name] = repo
        }
        sendJson(response, 200, {
          profile: config.profile,
          installed,
          activation,
          provenance,
          repoUrls,
          live: listHotMounts(),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/use-skin',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const installed = readInstalled(config.profile)
          const themeNames = await themes.installedThemeNames()
          if (installed[name] === undefined || !themeNames.has(name)) {
            sendJson(response, 400, { error: 'not an installed theme' })
            return
          }
          const activated = await themes.activateTheme(name)
          logEvent(activated ? 'info' : 'error', 'use-skin', `${name}: ${activated ? 'active' : 'failed'}`)
          sendJson(response, activated ? 200 : 502, { ok: activated, live: listHotMounts() })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'use-skin', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    // ★ FIFO queue: list ops, kill, clear
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/op',
      handler: async (_request, response) => {
        sendJson(response, 200, { ops: listOps(), running: runningOpId })
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/kill',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'untrusted origin' }); return }
        const body = (await readJsonBody(request)) as { id?: string }
        const ok = typeof body.id === 'string' && killOp(body.id)
        sendJson(response, ok ? 200 : 400, { ok })
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/clear-ops',
      handler: async (_request, response) => {
        clearOps()
        sendJson(response, 200, { ok: true })
      },
    }),

    // ★ F4 Environment Sync routes (opt-in, default disabled)
    // GET/POST /plugin-manager/sync-config — read/update config
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/sync-config',
      handler: async (request, response) => {
        if (request.method === 'GET') {
          const syncCfg = readSyncConfig(config.profile)
          // Never return the raw token in GET responses — security
          sendJson(response, 200, { ...syncCfg, token: syncCfg.token ? '••••••••' : '' })
          return
        }
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'GET, POST' }); response.end(); return }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'untrusted origin' }); return }
        try {
          const body = (await readJsonBody(request)) as Partial<import('./sync.ts').SyncConfig>
          // Only allow token to be SET, not READ (security)
          const updated = writeSyncConfig(config.profile, body)
          sendJson(response, 200, { ...updated, token: updated.token ? '••••••••' : '' })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    // POST /plugin-manager/sync-test — test GitHub connection
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/sync-test',
      handler: async (_request, response) => {
        const cfg = readSyncConfig(config.profile)
        const err = await testConnection(cfg)
        if (err) {
          sendJson(response, 200, { ok: false, error: err })
        } else {
          sendJson(response, 200, { ok: true })
        }
      },
    }),
    // GET /plugin-manager/sync-export — generate manifest (no push)
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/sync-export',
      handler: async (request, response) => {
        const cfg = readSyncConfig(config.profile)
        if (!cfg.enabled) {
          sendJson(response, 403, { error: 'sync is not enabled' })
          return
        }
        const url = new URL(request.url ?? '', 'http://localhost')
        const includeLocal = url.searchParams.get('includeLocal') === 'true'
        const manifest = exportSyncManifest(config.profile, config.profile, includeLocal)
        // Also return a list of local-only plugins that were skipped
        const skippedLocal = includeLocal ? [] : Object.entries(readInstalled(config.profile))
          .filter(([name, spec]) => (spec.startsWith('bundles:') || spec.startsWith('link:') || spec.startsWith('file:'))
            && readInstalledRepo(config.profile, name) === null)
          .map(([name]) => name)
        sendJson(response, 200, { manifest, count: manifest.plugins.length, skippedLocal })
      },
    }),
    // POST /plugin-manager/sync-push — push manifest to GitHub
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/sync-push',
      handler: async (request, response) => {
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'untrusted origin' }); return }
        const cfg = readSyncConfig(config.profile)
        const validationErr = validateConfig(cfg)
        if (validationErr) { sendJson(response, 200, { ok: false, error: validationErr }); return }
        // Read body for includeLocal flag
        let includeLocal = false
        try {
          const body = (await readJsonBody(request)) as { includeLocal?: boolean }
          includeLocal = body.includeLocal === true
        } catch { /* no body, use default */ }
        const manifest = exportSyncManifest(config.profile, config.profile, includeLocal)
        if (manifest.plugins.length === 0) {
          sendJson(response, 200, { ok: false, error: { code: 'empty-manifest', message: '没有已安装的第三方插件可同步 / No third-party plugins to sync', retryable: false, hint: '先安装一些社区插件' } })
          return
        }
        const skippedLocal = includeLocal ? [] : Object.entries(readInstalled(config.profile))
          .filter(([name, spec]) => (spec.startsWith('bundles:') || spec.startsWith('link:') || spec.startsWith('file:'))
            && readInstalledRepo(config.profile, name) === null)
          .map(([name]) => name)
        const result = await pushManifest(cfg, manifest)
        if (result.error) {
          sendJson(response, 200, { ok: false, error: result.error })
        } else {
          sendJson(response, 200, { ok: true, url: result.url, sha: result.sha, skippedLocal: skippedLocal.length > 0 ? skippedLocal : undefined })
        }
      },
    }),
    // POST /plugin-manager/sync-pull — pull manifest from GitHub
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/sync-pull',
      handler: async (_request, response) => {
        if (!sameOrigin(_request)) { sendJson(response, 403, { error: 'untrusted origin' }); return }
        const cfg = readSyncConfig(config.profile)
        const validationErr = validateConfig(cfg)
        if (validationErr) { sendJson(response, 200, { ok: false, error: validationErr }); return }
        const result = await pullManifest(cfg)
        if (result.error) {
          sendJson(response, 200, { ok: false, error: result.error })
        } else if (result.manifest) {
          const diff = diffManifest(result.manifest, config.profile)
          sendJson(response, 200, { ok: true, manifest: result.manifest, diff, source: result.source })
        }
      },
    }),
    // POST /plugin-manager/sync-restore-local — restore packed local plugins
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/sync-restore-local',
      handler: async (request, response) => {
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'untrusted origin' }); return }
        try {
          const body = (await readJsonBody(request)) as { manifest?: SyncManifest }
          const manifest = body.manifest
          if (!manifest || !manifest.localPlugins || Object.keys(manifest.localPlugins).length === 0) {
            sendJson(response, 200, { ok: true, restored: [], skipped: [] })
            return
          }
          const restored: string[] = []
          const skipped: string[] = []
          for (const [name, files] of Object.entries(manifest.localPlugins)) {
            const ok = unpackLocalPlugin(config.profile, name, files)
            if (ok) {
              // Register the plugin into the profile so dsh loads it on next boot
              ensurePatchInsert(config.profile, name)
              restored.push(name)
            } else {
              skipped.push(name)
            }
          }
          sendJson(response, 200, { ok: true, restored, skipped })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    // POST /plugin-manager/sync-diff — diff a manifest against local state
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/sync-diff',
      handler: async (request, response) => {
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'untrusted origin' }); return }
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        try {
          const body = (await readJsonBody(request)) as { manifest?: SyncManifest }
          if (!body.manifest || !Array.isArray(body.manifest.plugins)) {
            sendJson(response, 200, { ok: false, error: { code: 'invalid-manifest', message: '请提供有效的清单文件 / Provide a valid manifest file', retryable: false, hint: '' } })
            return
          }
          const diff = diffManifest(body.manifest, config.profile)
          sendJson(response, 200, { ok: true, diff })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        await dropStaleHotMounts()
        sendJson(response, 200, {
          active: progress.active,
          target: progress.target,
          seconds: progress.active ? Math.round((Date.now() - progress.startedAt) / 1000) : 0,
          lastLine: progress.lastLine,
          phase: progress.phase,
          done: progress.done,
          total: progress.total,
          currentPackage: progress.currentPackage,
          downloaded: progress.downloaded,
          size: progress.size,
          ndjson: progress.ndjson,
          error: progress.error,
          cancelling: progress.cancelling,
          pnpm: await probePnpm(),
          boot: BOOT_ID,
          restart: restartAllowed(config),
          installed: readInstalled(config.profile),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/logs',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        let version = 'unknown'
        try {
          version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? version
        } catch { /* export still works without the version line */ }
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="dsh-market-log.txt"',
        })
        response.end(exportLogs({
          'dsh-plugin-manager': version,
          platform: `${process.platform} ${process.arch}`,
          node: process.version,
          profile: config.profile,
        }))
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/updates',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const force = (request.url ?? '').includes('force=1')
          sendJson(response, 200, { updates: await checkUpdates(config.profile, force) })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/update',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (runningOpId) {
          sendJson(response, 409, { error: 'another operation is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown; force?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const force = body.force === true
          const spec = readInstalled(config.profile)[name]
          if (spec === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          if (spec.startsWith('link:') || spec.startsWith('file:')) {
            sendJson(response, 400, { error: 'locally linked plugins update from their checkout' })
            return
          }
          const beforeInstalled = readInstalled(config.profile)
          // Re-running add re-resolves the source: git HEAD for github specs,
          // dist-tag latest for registry installs.
          const isGit = spec.startsWith('github:')
          // Lock sha: use #<sha> to avoid pnpm git ls-remote SSH issues (Sanqi pattern)
          const target = isGit
            ? await (async () => {
                const repoKey = spec.slice('github:'.length).replace(/#.*$/, '').toLowerCase()
                try {
                  const head = (await fetchJson(`https://api.github.com/repos/${repoKey}/commits/HEAD`)) as { sha?: string }
                  if (typeof head.sha === 'string' && /^[0-9a-f]{40}$/i.test(head.sha)) {
                    return `github:${repoKey}#${head.sha}`
                  }
                } catch { /* fall through to bare repo */ }
                return spec.replace(/#.*$/, '')
              })()
            : `${name}@latest`
          const repoKey = isGit ? spec.slice('github:'.length).replace(/#.*$/, '').toLowerCase() : null
          const beforeVersion = readInstalledVersion(config.profile, name)
          const beforeCommit = repoKey !== null ? readLockCommits(config.profile).get(repoKey) ?? null : null
          runningOpId = 'local'
          try {
            // force: the user chose to install a fresh release without the
            // default one-day safety wait; scoped to this single command.
            const addArgs = force ? ['add', RELEASE_AGE_OVERRIDE, target] : ['add', target]
            const result = await runPlugin(config.profile, addArgs)
            const cancelled = result.cancelled
            let ok = result.exitCode === 0 && !result.timedOut && !cancelled
            let stale = false
            let activation: Record<string, ReturnType<typeof verifyActivation>> | undefined
            if (ok) {
              stale = isStaleUpdate({
                isGit,
                beforeVersion,
                afterVersion: readInstalledVersion(config.profile, name),
                beforeCommit,
                afterCommit: repoKey !== null ? readLockCommits(config.profile).get(repoKey) ?? null : null,
              })
              if (stale) ok = false
            }
            if (ok) {
              invalidateUpdates()
              activation = { [name]: verifyActivation(config.profile, name, liveNames()) }
            }
            // Diagnose the stale outcome with EVIDENCE (#45 by @ayingQAQ):
            // only blame pnpm's fresh-release wait when the target's latest
            // release really is young; otherwise be honest that the cause is
            // unconfirmed. Git installs never hit the age gate.
            const youngRelease = stale && !isGit ? await latestPublishedRecently(name) : false
            const staleReason = stale ? (youngRelease === true ? 'release-age' : 'unknown') : null
            const staleError = !stale
              ? null
              : staleReason === 'release-age'
                ? '这个新版本刚发布不久。为了安全，系统默认会等它发布满一天后再安装——刚发布的版本偶尔会被发现问题然后撤回。可以明天再试，或点「立即更新」不再等待。 / This version was just released; for safety, installs normally wait about a day after a release. Try again tomorrow, or click "Update now" to install it right away.'
                : '更新命令执行完成，但版本没有变化，原因未能确认。点「立即更新」重试通常能解决；若仍不行，请导出日志反馈。 / The update command completed but the version did not change; the cause could not be confirmed. Clicking "Update now" to retry usually resolves it — if not, export the log and report it.'
            const cancelDiff = cancelled ? changedSince(beforeInstalled) : null
            logEvent(ok || cancelled ? 'info' : 'error', 'update',
              `${name} -> ${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${cancelled ? ' CANCELLED' : ''}${stale ? ` STALE(${staleReason ?? 'unknown'})` : ''}${ok || cancelled ? '' : ` stderr=${result.stderr.slice(-300)}`}`)
            // A user-cancelled run is a quiet outcome, not an error.
            sendJson(response, ok || cancelled ? 200 : 502, {
              ok,
              cancelled: cancelled || undefined,
              stale: stale || undefined,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              activation,
              staleReason: staleReason ?? undefined,
              error: staleError ?? undefined,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile),
            })
          } finally {
            reapplyDisabledState(config.profile)
            runningOpId = null
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[plugin-manager] update failed: ${message}`)
          logEvent('error', 'update', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/setup-pnpm',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const result = await provisionPnpm()
          sendJson(response, 200, { ok: result.ok, error: result.hint })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/restart',
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        // One-click restart contributed in #14 by @ysyyhhh.
        if (!restartAllowed(config)) {
          sendJson(response, 403, { error: 'self-restart is disabled for this host' })
          return
        }
        if (!trustedRestartRequest(request)) {
          sendJson(response, 403, { error: 'restart is limited to same-origin loopback requests' })
          return
        }
        if (runningOpId) {
          sendJson(response, 409, { error: 'cannot restart while a plugin operation is running' })
          return
        }
        if (restarting) {
          sendJson(response, 409, { error: 'restart already scheduled' })
          return
        }
        restarting = true
        try {
          const result = scheduleRestart()
          logEvent('info', 'restart', `scheduled pid=${String(result.pid)} helper=${String(result.helperPid)}`)
          sendJson(response, 202, { ok: true, boot: BOOT_ID, ...result })
        } catch (error) {
          restarting = false
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'restart', message)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/approve-builds',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          // One-click build-script approval (#6 by @qichuang321): only
          // packages physically present in the profile's installed tree can
          // be allowed — the list is not free input. Presence is checked in
          // node_modules, NOT the dependencies map: pnpm's blocked build
          // scripts are usually TRANSITIVE deps (cloudflared, ssh2,
          // cpu-features…), which never appear in package.json (#56 by
          // @walnut1218).
          const PKG_RE = /^(@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*$/
          const body = (await readJsonBody(request)) as { packages?: unknown }
          const packages = (Array.isArray(body.packages) ? body.packages.map(String) : [])
            .filter(name => PKG_RE.test(name)
              && existsSync(join(profileDir(config.profile), 'node_modules', name, 'package.json')))
          if (packages.length === 0) {
            sendJson(response, 400, { error: 'no installed packages given' })
            return
          }
          const approved = setAllowBuilds(config.profile, packages)
          logEvent('info', 'approve-builds', `allowed build scripts: ${approved.join(', ')}`)
          sendJson(response, 200, { ok: true, approved })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'approve-builds', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/cancel',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        // Cancel flow contributed in #6 by @qichuang321.
        if (!cancelActive()) {
          sendJson(response, 400, { error: 'no operation is running' })
          return
        }
        logEvent('info', 'cancel', `cancelled ${progress.target || 'operation'}`)
        sendJson(response, 200, { ok: true, cancelled: true, target: progress.target })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/uninstall',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (runningOpId) {
          sendJson(response, 409, { error: 'another operation is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          if (name === 'dsh-plugin-manager' || name === 'dsh-plugin-manager-plus') {
            sendJson(response, 400, { error: 'the market cannot uninstall itself; use the dsh CLI' })
            return
          }
          if (readInstalled(config.profile)[name] === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          const beforeInstalled = readInstalled(config.profile)
          const activation = { [name]: verifyActivation(config.profile, name, liveNames()) }
          runningOpId = 'local'
          try {
            const snap = snapshotProfile(config.profile)
            if (snap !== null) logEvent('info', 'uninstall', `snapshot: ${snap}`)
            const result = await runPlugin(config.profile, ['remove', name])
            const cancelled = result.cancelled
            const ok = result.exitCode === 0 && !result.timedOut && !cancelled
            const cancelDiff = cancelled ? changedSince(beforeInstalled) : null
            let hot = false
            if (ok) {
              invalidateUpdates()
              hot = await hotUnmount(name)
              // Bundle-layer plugins never hot-mount, but their loader entry
              // is still LIVE in this process — after the remove deleted the
              // package, the next refresh would 404 on its client bundle and
              // wedge the whole page until a dsh restart (#37 by
              // @1123762794). Live-disable the entry so the refresh composes
              // without it; after a real restart the entry is gone anyway.
              if (!hot) hot = await themes.setEntryDisabled(name, true)
            }
            logEvent(ok || cancelled ? 'info' : 'error', 'uninstall',
              `${name} exit=${String(result.exitCode)}${cancelled ? ' CANCELLED' : ''}${ok ? ` live-removed=${String(hot)}` : cancelled ? '' : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok || cancelled ? 200 : 502, {
              ok,
              cancelled: cancelled || undefined,
              hot,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              // The state of the package that was just removed (captured pre-op).
              activation,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile),
            })
          } finally {
            reapplyDisabledState(config.profile)
            runningOpId = null
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[plugin-manager] uninstall failed: ${message}`)
          logEvent('error', 'uninstall', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    // ★ Disable/Enable: toggle a plugin's active state via dsh.market.disabled
    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/disable',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'untrusted origin' }); return }
        try {
          const body = (await readJsonBody(request)) as { name?: string; disable?: boolean }
          const name = typeof body.name === 'string' ? body.name : ''
          const disable = body.disable !== false
          if (!name) { sendJson(response, 400, { error: 'name required' }); return }
          const changed = setDisabledState(config.profile, name, disable)
          sendJson(response, 200, { ok: true, changed, disabled: disable })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/plugin-manager/install',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (runningOpId) {
          sendJson(response, 409, { error: 'another operation is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { url?: unknown }
          const url = typeof body.url === 'string' ? body.url : ''
          const { registry } = await loadRegistry()
          const entry = registry.plugins.find(p => p.url.toLowerCase() === url.toLowerCase())
          if (entry === undefined) {
            logEvent('warn', 'install-rejected', `not in curated registry: ${url.slice(0, 120)}`)
            sendJson(response, 400, { error: 'plugin is not in the curated registry' })
            return
          }
          const target = installTargetFor(entry)
          if (target === null) {
            sendJson(response, 400, { error: 'unsupported source url' })
            return
          }
          // Duplicate guard (#27): the same plugin listed under another name
          // (an alias entry pointing at the same repo) must never install
          // twice — two loader entries with one id brick the next boot.
          // Monorepo subpath entries (distinct plugins in one repo) pass:
          // their entry urls differ by subpath and identity is name-based.
          const aliasOf = findInstalledAlias(entry, readInstalled(config.profile))
          if (aliasOf !== null) {
            logEvent('warn', 'install-rejected', `${entry.name}: same plugin already installed as ${aliasOf}`)
            sendJson(response, 400, { error: `已以「${aliasOf}」安装过同一个插件，无需重复安装 / this plugin is already installed as "${aliasOf}"` })
            return
          }
          runningOpId = 'local'
          try {
            // Snapshot profile before mutating (Sanqi pattern)
            const snap = snapshotProfile(config.profile)
            if (snap !== null) logEvent('info', 'install', `snapshot: ${snap}`)
            const beforeSpecs = readInstalled(config.profile)
            const before = new Set(Object.keys(beforeSpecs))
            const result = await runPlugin(config.profile, ['add', target])
            const cancelled = result.cancelled
            let ok = result.exitCode === 0 && !result.timedOut && !cancelled
            const cancelDiff = cancelled ? changedSince(beforeSpecs) : null
            if (ok) invalidateUpdates()
            if (ok) {
              // Collection repos (e.g. skin monorepos) install as a junk
              // fileset with no root package.json; retarget to the real
              // plugin subdirectories via pnpm's #path: selector.
              ok = await retargetCollections(runPlugin, config.profile, before, target)
            }
            // Fake-success guard (#18): a clean exit that added nothing
            // installable must not read as success. Runs even when
            // retargeting partially failed — a broken piece that slipped in
            // must never survive to brick the next boot.
            let notAPlugin = false
            let removedBroken: string[] = []
            if (result.exitCode === 0 && !result.timedOut && !cancelled) {
              const validated = await validateAddedPlugins(runPlugin, config.profile, before)
              removedBroken = validated.removedBroken
              if (removedBroken.length > 0) {
                logEvent('warn', 'install', `${target}: removed uninstallable pieces (no dsh manifest or missing build artifacts): ${removedBroken.join(', ')}`)
              }
              if (validated.keep.length === 0) {
                ok = false
                notAPlugin = true
                logEvent('error', 'install', `${target}: nothing installable survived validation`)
              } else {
                // Partial success across a collection still counts as success.
                ok = true
              }
            }
            const installed = readInstalled(config.profile)
            let hot = false
            let activation: Record<string, ReturnType<typeof verifyActivation>> | undefined
            if (ok) {
              const added = Object.keys(installed).filter(name => !before.has(name))
              if (added.length > 0) {
                // Theme installs auto-activate (and deactivate the previous
                // theme) so the result is visible right after the refresh.
                hot = true
                for (const name of added) {
                  const live = entry.category === 'theme'
                    ? await themes.activateTheme(name)
                    : (await hotMount(host, profileDir(config.profile), name)).ok
                  if (!live) hot = false
                }
                activation = {}
                const live = liveNames()
                for (const name of added) activation[name] = verifyActivation(config.profile, name, live)
              }
            }
            logEvent(ok || cancelled ? 'info' : 'error', 'install',
              `${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${cancelled ? ' CANCELLED' : ''}${ok ? ` hot=${String(hot)}` : cancelled ? '' : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok || cancelled ? 200 : 502, {
              ok,
              cancelled: cancelled || undefined,
              hot,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              activation,
              ignoredBuilds: (() => {
                // Prefer the structured event (pnpm 11 ndjson) over the human line.
                if (Array.isArray(result.ignoredBuilds) && result.ignoredBuilds.length > 0) return result.ignoredBuilds
                const list = parseIgnoredBuilds(result.stdout, result.stderr)
                return list.length > 0 ? list : undefined
              })(),
              error: notAPlugin ? 'nothing installable: the plugin(s) need a build step (blocked by default, see allowBuilds) or ship no prebuilt artifacts / 没有可安装的内容：插件需要构建授权（allowBuilds，默认拦截）或未附带构建产物，详见导出日志' : undefined,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed,
            })
          } finally {
            reapplyDisabledState(config.profile)
            runningOpId = null
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[plugin-manager] install failed: ${message}`)
          logEvent('error', 'install', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
