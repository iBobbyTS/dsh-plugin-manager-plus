/**
 * Sync tab: configure GitHub sync, backup/restore plugin environment.
 * Pure configuration page — no plugin lists. Default disabled (opt-in).
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './market-data.ts'

interface SyncTabProps {
  t: Translate
  lang: string
}

interface SyncConfig {
  enabled: boolean
  repo: string
  branch: string
  token: string
  lastSyncAt: string | null
  lastError: string | null
}

interface SyncError {
  code: string
  message: string
  retryable: boolean
  hint: string
}

export function SyncTab({ t }: SyncTabProps) {
  const [config, setConfig] = useState<SyncConfig | null>(null)
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'test' | 'backup' | 'restore' | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load config on mount
  useEffect(() => {
    fetch('/plugin-manager/sync-config', { cache: 'no-store' })
      .then(r => r.json())
      .then((cfg: SyncConfig) => {
        setConfig(cfg)
        setRepo(cfg.repo)
        setBranch(cfg.branch || 'main')
      })
      .catch(() => setError('加载配置失败'))
  }, [])

  // Save config
  const saveConfig = useCallback(async (update: Partial<SyncConfig>) => {
    try {
      const r = await fetch('/plugin-manager/sync-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      })
      const cfg = (await r.json()) as SyncConfig
      setConfig(cfg)
      setError(null)
      return cfg
    } catch {
      setError('保存配置失败')
      return null
    }
  }, [])

  // Enable / disable
  const toggleSync = useCallback(async (enable: boolean) => {
    if (enable && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      setError(t('syncRepo') + ' 格式应为 owner/repo')
      return
    }
    await saveConfig({ enabled: enable, repo, branch, token: token || undefined })
  }, [repo, branch, token, saveConfig, t])

  // Test connection
  const testConnection = useCallback(async () => {
    setBusy('test')
    setStatus(null)
    setError(null)
    try {
      const r = await fetch('/plugin-manager/sync-test', { cache: 'no-store' })
      const data = await r.json()
      setStatus(data.ok
        ? { ok: true, text: t('syncTestOk') }
        : { ok: false, text: (data.error as SyncError)?.message || t('syncTestFail') })
    } catch {
      setStatus({ ok: false, text: t('syncTestFail') })
    }
    setBusy(null)
  }, [t])

  // Backup: ask about local-only plugins, then push (files included on confirm)
  const doBackup = useCallback(async () => {
    setBusy('backup')
    setStatus(null)
    setError(null)
    try {
      // First check for local-only plugins
      const check = await fetch('/plugin-manager/sync-export?includeLocal=false', { cache: 'no-store' })
      const checkData = await check.json()
      const localList = (checkData.skippedLocal as string[] | undefined) ?? []
      let includeLocal = false
      if (localList.length > 0) {
        const names = localList.join('\n  • ')
        const ok = window.confirm(`发现 ${localList.length} 个本地插件（无 GitHub 链接）：\n\n  • ${names}\n\n是否将它们的文件一并备份到清单？（可在其他电脑完整还原）\n\n[确定] 包含文件  |  [取消] 跳过这些插件`)
        if (!ok) { setBusy(null); return }
        includeLocal = true
      }
      const r = await fetch('/plugin-manager/sync-push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeLocal }),
      })
      const data = await r.json()
      if (data.ok) {
        const skipped = (data.skippedLocal as string[] | undefined) ?? []
        setStatus(skipped.length > 0
          ? { ok: true, text: `${t('syncBackupOk')}（${skipped.length} 个本地插件未备份：${skipped.join('、')}）` }
          : { ok: true, text: includeLocal ? `${t('syncBackupOk')}（含本地插件文件）` : t('syncBackupOk') })
      } else {
        setStatus({ ok: false, text: (data.error as SyncError)?.message || '备份失败' })
      }
    } catch {
      setStatus({ ok: false, text: t('syncTestFail') })
    }
    setBusy(null)
  }, [t])

  // Restore: pull + diff, show summary only
  const doRestore = useCallback(async () => {
    setBusy('restore')
    setStatus(null)
    setError(null)
    try {
      const r = await fetch('/plugin-manager/sync-pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const data = await r.json()
      if (data.ok && data.diff) {
        const toInstall = (data.diff.toInstall as any[]) ?? []
        const already = (data.diff.alreadyInstalled as any[])?.length ?? 0
        const localIncluded = (data.manifest?.localPlugins ?? null) != null && Object.keys(data.manifest.localPlugins ?? {}).length > 0
        const localCount = localIncluded ? Object.keys(data.manifest.localPlugins).length : 0
        if (toInstall.length === 0) {
          setStatus({ ok: true, text: `已是最新，无需还原（${already} 个已存在）` })
        } else {
          const ok = window.confirm(`发现 ${toInstall.length} 个插件可还原，${already} 个已存在。\n${localCount > 0 ? `其中 ${localCount} 个本地插件将自动还原文件。` : ''}\n\n是否执行还原？`)
          if (ok) {
            // 1. Restore packed local plugin files (if the manifest carries them)
            let localRestored = 0
            if (localCount > 0 && data.manifest) {
              const lr = await fetch('/plugin-manager/sync-restore-local', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ manifest: data.manifest }),
              })
              const lrData = await lr.json()
              localRestored = lrData.restored?.length ?? 0
            }
            // 2. Online plugins: instruct the user (market install or dsh CLI)
            const onlineNames = toInstall.filter((p: any) => p.local !== true).map((p: any) => p.name)
            const msg = [`已还原 ${localRestored} 个本地插件。`]
            if (onlineNames.length > 0) {
              msg.push(`另有 ${onlineNames.length} 个插件可从市场安装：${onlineNames.join('、')}`)
            }
            setStatus({ ok: true, text: msg.join('\n') })
          } else {
            setStatus({ ok: false, text: '已取消还原' })
          }
        }
      } else {
        setStatus({ ok: false, text: (data.error as SyncError)?.message || '拉取失败' })
      }
    } catch {
      setStatus({ ok: false, text: t('syncTestFail') })
    }
    setBusy(null)
  }, [t])

  // Loading
  if (!config) {
    return <div style={{ padding: 24, fontSize: 13, color: 'var(--dsw-alias-label-secondary,#6b7280)' }}>{t('loading')}</div>
  }

  // Disabled → show guide + config form
  if (!config.enabled) {
    return (
      <div style={{ padding: '24px 8px', maxWidth: 480 }}>
        <h3 style={{ fontSize: 17, margin: '0 0 10px' }}>{t('syncNotEnabled')}</h3>
        <p style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary,#6b7280)', lineHeight: '20px', margin: '0 0 16px' }}>
          {t('syncDesc')}<br />
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#9ca3af)' }}>{t('syncPrivacyNote')}</span>
        </p>
        <div style={{ fontSize: 12, lineHeight: '20px', marginBottom: 16, color: 'var(--dsw-alias-label-secondary,#6b7280)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('syncGuide')}</div>
          <div>{t('syncEnableStep1')}</div>
          <div>{t('syncEnableStep2')}</div>
          <div>{t('syncEnableStep3')}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360 }}>
          <Input placeholder="owner/repo" value={repo} onChange={e => setRepo(e.target.value)} />
          <Input placeholder="main" value={branch} onChange={e => setBranch(e.target.value)} />
          <Input placeholder="ghp_..." value={token} onChange={e => setToken(e.target.value)} type="password" />
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#9ca3af)' }}>{t('syncTokenNote')}</div>
          <Button variant="primary" size="sm" onClick={() => toggleSync(true)} disabled={!repo}>{t('syncEnable')}</Button>
        </div>
        {error && <div style={{ color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 12, marginTop: 8 }}>{error}</div>}
      </div>
    )
  }

  // Enabled → config + actions (no plugin lists)
  return (
    <div style={{ padding: '16px 8px', maxWidth: 480 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{t('syncConfig')}</div>
        <Input placeholder="owner/repo" value={repo} onChange={e => setRepo(e.target.value)} />
        <Input placeholder="main" value={branch} onChange={e => setBranch(e.target.value)} />
        <Input placeholder="ghp_..." value={token} onChange={e => setToken(e.target.value)} type="password" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" onClick={() => saveConfig({ repo, branch, token: token || undefined })}>保存配置</Button>
          <Button variant="outline" size="sm" onClick={testConnection} disabled={busy !== null}>
            {busy === 'test' ? t('syncTesting') : t('syncTest')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => toggleSync(false)}>{t('syncDisable')}</Button>
        </div>
        {status && (
          <div style={{ fontSize: 12, color: status.ok ? 'var(--dsw-alias-state-success-primary,#16a34a)' : 'var(--dsw-alias-state-error-primary,#dc2626)' }}>
            {status.text}
          </div>
        )}
        {error && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' }}>{error}</div>}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" size="sm" onClick={doBackup} disabled={busy !== null}>
          {busy === 'backup' ? t('syncBackuping') : t('syncBackup')}
        </Button>
        <Button variant="outline" size="sm" onClick={doRestore} disabled={busy !== null}>
          {busy === 'restore' ? t('syncRestoring') : t('syncRestore')}
        </Button>
      </div>

      {config.lastSyncAt && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#9ca3af)', marginTop: 12 }}>
          {t('syncLastSync')}: {new Date(config.lastSyncAt).toLocaleString()}
        </div>
      )}
    </div>
  )
}