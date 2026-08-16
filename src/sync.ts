/**
 * Environment sync: export/import plugin environment via GitHub.
 * Supports two modes:
 * 1. **GitHub API** (recommended) — uses GitHub REST API to push/pull
 *    `dsh-plugins.json` to a repo. No git CLI needed.
 * 2. **Manual export** — generates the manifest JSON for manual copy.
 *
 * 🔒 Opt-in (default off): `sync.enabled` must be set to true before any
 *    network request is made.
 *
 * Error handling covers:
 * - Network failures (timeout, DNS, connection refused)
 * - GitHub API errors (auth, rate limit, not found, conflict)
 * - Invalid token / insufficient permissions
 * - Repository not accessible
 * - Manifest format validation
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readInstalled, readInstalledVersion, readInstalledRepo, readLockCommits, profileDir } from './profile.ts'
import { logEvent } from './log.ts'

// ── Types ──────────────────────────────────────────────────────────────

export interface SyncConfig {
  enabled: boolean
  /** GitHub repository in "owner/repo" format. */
  repo: string
  /** Branch to push/pull the manifest. */
  branch: string
  /** Optional GitHub personal access token (classic or fine-grained). */
  token?: string
  /** Last successful sync timestamp (for display). */
  lastSyncAt?: string | null
  /** Last error message (for display, transient). */
  lastError?: string | null
}

export interface SyncManifest {
  format: 'dsh-plugin-manifest'
  version: number
  generatedAt: string
  dsh: { version?: string; profile: string }
  plugins: Array<{
    name: string
    spec: string
    commit: string | null
    version: string | null
    npm: string | null
    /** GitHub repo URL resolved from the plugin manifest (repository field). */
    repo?: string
    /** True when the plugin has no GitHub/npm URL and can't be auto-restored. */
    local?: boolean
    /** Human-readable hint for manual restore. */
    localHint?: string
  }>
}

export interface SyncError {
  /** Machine-readable error code. */
  code: SyncErrorCode
  /** Human-readable message in Chinese + English. */
  message: string
  /** Whether the operation can be retried as-is. */
  retryable: boolean
  /** Suggested user action. */
  hint: string
}

export type SyncErrorCode =
  | 'not-configured'        // Repo not set
  | 'not-enabled'           // Sync not enabled
  | 'network-error'         // Timeout / DNS / connection
  | 'auth-failed'           // 401 – bad token
  | 'forbidden'             // 403 – no permission or rate limited
  | 'rate-limited'          // 429 – GitHub API rate limit
  | 'not-found'             // 404 – repo not found
  | 'conflict'              // 409 – push conflict
  | 'invalid-manifest'      // Manifest format invalid
  | 'empty-manifest'        // No plugins to export
  | 'unknown'               // Catch-all

// ── Defaults ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SyncConfig = {
  enabled: false,
  repo: '',
  branch: 'main',
  token: '',
  lastSyncAt: null,
  lastError: null,
}

const SYNC_DIR = '.dsh-plugin-manager'
const CONFIG_FILE = 'sync-config.json'
const MANIFEST_FILENAME = 'dsh-plugins.json'
const GITHUB_API_BASE = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 15_000

// ── Config Management ─────────────────────────────────────────────────

/** Read the sync config. Returns default (disabled) when not configured. */
export function readSyncConfig(profile: string): SyncConfig {
  try {
    const file = join(profileDir(profile), SYNC_DIR, CONFIG_FILE)
    if (!existsSync(file)) return { ...DEFAULT_CONFIG }
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<SyncConfig>
    return {
      enabled: data.enabled === true,
      repo: typeof data.repo === 'string' ? data.repo.trim() : '',
      branch: typeof data.branch === 'string' ? data.branch.trim() : 'main',
      token: typeof data.token === 'string' ? data.token.trim() : '',
      lastSyncAt: typeof data.lastSyncAt === 'string' ? data.lastSyncAt : null,
      lastError: typeof data.lastError === 'string' ? data.lastError : null,
    }
  } catch {
    return { ...DEFAULT_CONFIG, lastError: '配置读取失败，已重置为默认值' }
  }
}

/** Write the sync config. Returns the merged config. */
export function writeSyncConfig(profile: string, update: Partial<SyncConfig>): SyncConfig {
  const current = readSyncConfig(profile)
  const merged: SyncConfig = { ...current, ...update }
  try {
    const dir = join(profileDir(profile), SYNC_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(merged, null, 2) + '\n')
    logEvent('info', 'sync-config', `updated: enabled=${String(merged.enabled)} repo=${merged.repo}`)
  } catch (e) {
    logEvent('error', 'sync-config', `write failed: ${String(e)}`)
  }
  return merged
}

// ── Validation ────────────────────────────────────────────────────────

/** Validate the sync config. Returns the first error, or null if OK. */
export function validateConfig(config: SyncConfig): SyncError | null {
  if (!config.enabled) {
    return { code: 'not-enabled', message: '同步功能未启用，请在设置中开启 / Sync is not enabled — enable it in settings', retryable: false, hint: '打开设置 → 环境同步 → 启用同步' }
  }
  if (!config.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repo)) {
    return { code: 'not-configured', message: '请填写 GitHub 仓库（格式：owner/repo） / Please set a GitHub repository (format: owner/repo)', retryable: false, hint: '在设置中填写仓库地址，例如 "me/dsh-plugins"' }
  }
  return null
}

// ── GitHub API ────────────────────────────────────────────────────────

interface GitHubApiOptions {
  token?: string
  method?: string
  body?: unknown
  etag?: string
}

/** Build auth headers for GitHub API calls. */
function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-plugin-manager-plus/0.1.0',
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * Encode an "owner/repo" string for use in a GitHub API URL path.
 * The owner/repo separator slash MUST stay literal — GitHub returns 404 for
 * %2F-encoded repo paths. Each segment is encoded independently.
 */
function repoPath(repo: string): string {
  return repo.split('/').map(encodeURIComponent).join('/')
}

/** Parse a GitHub API error response into a SyncError. */
function parseGitHubError(err: unknown, context: string): SyncError {
  if (err instanceof TypeError && err.message === 'fetch failed') {
    return networkError(context)
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'network-error', message: `请求超时（${context}）：请检查网络连接 / Request timed out (${context}): check your network`, retryable: true, hint: '确认网络连接后重试，或增大超时设置' }
  }
  if (err instanceof Error && /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message)) {
    return networkError(context)
  }
  // HTTP errors
  if (err && typeof err === 'object' && 'status' in err) {
    const httpErr = err as { status: number; message?: string }
    switch (httpErr.status) {
      case 401:
        return { code: 'auth-failed', message: 'GitHub 认证失败：Token 无效或已过期 / Authentication failed: token is invalid or expired', retryable: false, hint: '在 GitHub Settings → Developer settings → Personal access tokens 重新生成 token，粘贴到同步设置中' }
      case 403:
        if (httpErr.message?.includes('rate limit')) {
          return { code: 'rate-limited', message: 'GitHub API 限流：请稍后再试，或添加 Token 提升限额 / Rate limited: add a token or wait', retryable: true, hint: '添加 GitHub Token 可将限额从 60 次/小时提升到 5000 次/小时' }
        }
        return { code: 'forbidden', message: '无权限访问仓库：请检查 Token 的仓库权限（需要 contents:write） / No permission: check your token scopes (needs contents:write)', retryable: false, hint: 'GitHub Token 需勾选 repo 或 contents:write 权限' }
      case 404:
        return { code: 'not-found', message: `仓库不存在或无权访问：${context} / Repository not found or no access: ${context}`, retryable: false, hint: '确认仓库地址正确，且 Token 有权限访问该仓库' }
      case 409:
        return { code: 'conflict', message: '推送冲突：远程仓库的 dsh-plugins.json 已被修改 / Push conflict: remote dsh-plugins.json was modified', retryable: true, hint: '先拉取远程版本，合并后再推送' }
      case 429:
        return { code: 'rate-limited', message: 'GitHub API 限流：请求过于频繁，请稍后再试 / Rate limited: too many requests, please wait', retryable: true, hint: '等待几分钟后重试' }
      default:
        return { code: 'unknown', message: `GitHub API 错误 (${httpErr.status})：${httpErr.message || context} / GitHub API error (${httpErr.status}): ${httpErr.message || context}`, retryable: httpErr.status >= 500, hint: '请稍后重试，或导出日志反馈' }
    }
  }
  return { code: 'unknown', message: `未知错误（${context}）：${String(err)} / Unknown error (${context}): ${String(err)}`, retryable: true, hint: '导出日志反馈' }
}

function networkError(context: string): SyncError {
  return { code: 'network-error', message: `网络连接失败（${context}）：请检查网络 / Network error (${context}): check your connection`, retryable: true, hint: '确认网络连接后重试' }
}

/** Test the GitHub API connection. Returns the first error, or null if OK. */
export async function testConnection(config: SyncConfig): Promise<SyncError | null> {
  const validationError = validateConfig(config)
  if (validationError) return validationError

  try {
    const res = await fetch(`${GITHUB_API_BASE}/repos/${repoPath(config.repo)}`, {
      headers: githubHeaders(config.token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      // Try to get rate limit info
      const body = await res.text().catch(() => '')
      return parseGitHubError({ status: res.status, message: body }, 'test-connection')
    }
    return null
  } catch (err) {
    return parseGitHubError(err, 'test-connection')
  }
}

/** Get the SHA of an existing file in the repo (for updates). */
async function getFileSha(config: SyncConfig, path: string): Promise<{ sha: string; content: string } | null> {
  try {
    const url = `${GITHUB_API_BASE}/repos/${repoPath(config.repo)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(config.branch)}`
    const res = await fetch(url, {
      headers: githubHeaders(config.token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw { status: res.status, message: body }
    }
    const data = (await res.json()) as { sha?: string; content?: string }
    if (data.sha && data.content) {
      return { sha: data.sha, content: Buffer.from(data.content, 'base64').toString('utf8') }
    }
    return null
  } catch (err) {
    throw parseGitHubError(err, `get-file-sha: ${path}`)
  }
}

// ── Manifest Export / Import ──────────────────────────────────────────

/** Export installed plugins as a sync manifest (lockfile). */
export function exportSyncManifest(profile: string, profileName: string, includeLocal = false): SyncManifest {
  const installed = readInstalled(profile)
  const lockCommits = readLockCommits(profile)
  const plugins: SyncManifest['plugins'] = []

  for (const [name, spec] of Object.entries(installed)) {
    const version = readInstalledVersion(profile, name)
    const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    const commit = gh !== null ? (lockCommits.get(gh[1].toLowerCase()) ?? null) : null
    const npm = spec.startsWith('github:') ? null : (name.startsWith('@') || !name.includes('/') ? name : null)
    // Resolve a GitHub URL from the plugin's own manifest (repository field)
    // so self-authored plugins uploaded to GitHub are not treated as local.
    const manifestRepo = readInstalledRepo(profile, name)

    // Detect local-only plugins: bundles:/link:/file: specs with no GitHub/npm
    // source AND no repository field in the plugin manifest.
    const hasSource = gh !== null || npm !== null || manifestRepo !== null
    const isLocal = (spec.startsWith('bundles:') || spec.startsWith('link:') || spec.startsWith('file:')) && !hasSource
    const localHint = isLocal
      ? (spec.startsWith('bundles:')
          ? '已通过 bundle 部署，需手动复制 node_modules 目录 / deployed as a bundle — copy the node_modules directory manually'
          : '本地安装，无法通过 GitHub 或 npm 自动还原 / locally installed — cannot auto-restore from GitHub or npm')
      : undefined

    // Skip local-only plugins unless explicitly included
    if (isLocal && !includeLocal) continue

    plugins.push({
      name, spec, commit, version, npm,
      repo: manifestRepo ?? undefined,
      local: isLocal || undefined,
      localHint,
    })
  }

  return {
    format: 'dsh-plugin-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    dsh: { version: process.version, profile: profileName },
    plugins,
  }
}

/** Compute the diff between a remote manifest and local state. */
export function diffManifest(
  manifest: SyncManifest,
  profile: string,
): { toInstall: SyncManifest['plugins']; alreadyInstalled: SyncManifest['plugins']; skipped: SyncManifest['plugins']; errors: string[] } {
  const installed = readInstalled(profile)
  const toInstall: SyncManifest['plugins'] = []
  const alreadyInstalled: SyncManifest['plugins'] = []
  const skipped: SyncManifest['plugins'] = []
  const errors: string[] = []

  if (!manifest || !Array.isArray(manifest.plugins)) {
    return { toInstall, alreadyInstalled, skipped, errors: ['清单格式无效：缺少 plugins 数组 / Invalid manifest: missing plugins array'] }
  }
  if (manifest.format !== 'dsh-plugin-manifest') {
    return { toInstall, alreadyInstalled, skipped, errors: [`不支持的清单格式：${manifest.format} / Unsupported manifest format: ${manifest.format}`] }
  }

  for (const plugin of manifest.plugins) {
    if (!plugin.name || !plugin.spec) {
      errors.push(`清单条目无效：缺少 name 或 spec / Invalid entry: missing name or spec`)
      continue
    }
    if (installed[plugin.name] !== undefined) {
      alreadyInstalled.push(plugin)
    } else if (plugin.name === 'dsh-plugin-manager-plus' || plugin.name === 'dshmarket') {
      skipped.push(plugin)
    } else {
      toInstall.push(plugin)
    }
  }

  return { toInstall, alreadyInstalled, skipped, errors }
}

/** Build install targets for restore. */
export function restoreTarget(plugin: SyncManifest['plugins'][0]): string {
  if (plugin.commit && /^[0-9a-f]{40}$/i.test(plugin.commit)) {
    const gh = /^github:(.+)$/.exec(plugin.spec)
    if (gh) return `github:${gh[1]}#${plugin.commit}`
    return plugin.spec
  }
  if (plugin.npm && plugin.version) {
    return `${plugin.npm}@${plugin.version}`
  }
  return plugin.spec
}

// ── Push / Pull (GitHub API) ──────────────────────────────────────────

/**
 * Push the manifest to GitHub. Creates or updates the file.
 * @returns error on failure, or { url, sha } on success.
 */
export async function pushManifest(config: SyncConfig, manifest: SyncManifest): Promise<{ error?: SyncError; url?: string; sha?: string }> {
  const validationError = validateConfig(config)
  if (validationError) return { error: validationError }

  // Rate limit check: show a warning if no token
  if (!config.token) {
    logEvent('warn', 'sync-push', 'no token configured — rate limited to 60 req/hr')
  }

  const content = JSON.stringify(manifest, null, 2)
  const encoded = Buffer.from(content, 'utf8').toString('base64')
  const path = MANIFEST_FILENAME

  try {
    // Check if file already exists (to get SHA for update)
    let sha: string | undefined
    try {
      const existing = await getFileSha(config, path)
      if (existing) sha = existing.sha
    } catch (err) {
      const syncErr = err as SyncError
      // 404 is OK — file doesn't exist yet, will create
      if (syncErr.code !== 'not-found') return { error: syncErr }
    }

    const url = `${GITHUB_API_BASE}/repos/${repoPath(config.repo)}/contents/${encodeURIComponent(path)}`
    const body: Record<string, unknown> = {
      message: `dsh-plugin-manager: sync ${manifest.plugins.length} plugins (${manifest.generatedAt})`,
      content: encoded,
      branch: config.branch,
    }
    if (sha) body.sha = sha

    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...githubHeaders(config.token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { error: parseGitHubError({ status: res.status, message: bodyText }, 'push-manifest') }
    }

    const data = (await res.json()) as { content?: { sha?: string }; commit?: { sha?: string } }
    const resultSha = data.content?.sha || data.commit?.sha

    // Update lastSyncAt
    writeSyncConfig(manifest.dsh.profile, { lastSyncAt: new Date().toISOString(), lastError: null })

    logEvent('info', 'sync-push', `pushed to ${config.repo}/${path} (${manifest.plugins.length} plugins)`)
    return { url: `https://github.com/${config.repo}/blob/${config.branch}/${path}`, sha: resultSha }
  } catch (err) {
    return { error: parseGitHubError(err, 'push-manifest') }
  }
}

/**
 * Pull the manifest from GitHub.
 * @returns error on failure, or { manifest, source } on success.
 */
export async function pullManifest(config: SyncConfig): Promise<{ error?: SyncError; manifest?: SyncManifest; source?: 'github' | 'offline' }> {
  const validationError = validateConfig(config)
  if (validationError) return { error: validationError }

  const path = MANIFEST_FILENAME

  try {
    const existing = await getFileSha(config, path)
    if (!existing) {
      return { error: { code: 'not-found', message: `远程仓库不存在 ${MANIFEST_FILENAME}，请先在其他机器上执行备份 / No ${MANIFEST_FILENAME} found in the remote repo — run backup first`, retryable: false, hint: '先在已配好插件的机器上执行「备份」' } }
    }

    // Parse and validate manifest
    try {
      const manifest = JSON.parse(existing.content) as SyncManifest
      if (manifest.format !== 'dsh-plugin-manifest') {
        return { error: { code: 'invalid-manifest', message: `远程文件格式不正确：期望 dsh-plugin-manifest，实际 ${manifest.format} / Invalid manifest format: expected dsh-plugin-manifest, got ${manifest.format}`, retryable: false, hint: '确认远程仓库的 dsh-plugins.json 是由本插件生成的' } }
      }
      return { manifest, source: 'github' }
    } catch (parseErr) {
      return { error: { code: 'invalid-manifest', message: `远程文件解析失败：不是有效的 JSON / Remote file is not valid JSON: ${String(parseErr)}`, retryable: false, hint: '检查远程仓库的 dsh-plugins.json 文件是否损坏' } }
    }
  } catch (err) {
    const syncErr = err as SyncError
    return { error: syncErr }
  }
}

// ── Error helpers for display ─────────────────────────────────────────

/** Get a user-friendly category for a SyncError, for UI grouping. */
export function errorCategory(code: SyncErrorCode): 'config' | 'network' | 'auth' | 'github' | 'data' {
  if (code === 'not-enabled' || code === 'not-configured') return 'config'
  if (code === 'network-error') return 'network'
  if (code === 'auth-failed' || code === 'forbidden') return 'auth'
  if (code === 'rate-limited' || code === 'not-found' || code === 'conflict') return 'github'
  return 'data'
}

/** Get a Chinese action label for an error code. */
export function errorAction(code: SyncErrorCode): string | null {
  switch (code) {
    case 'not-enabled': return '去启用'
    case 'not-configured': return '去配置'
    case 'network-error': return '重试'
    case 'auth-failed': return '更新 Token'
    case 'forbidden': return '检查权限'
    case 'rate-limited': return '等待'
    case 'not-found': return '检查仓库'
    case 'conflict': return '重新推送'
    default: return null
  }
}