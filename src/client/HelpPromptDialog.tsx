/**
 * HelpPromptDialog: shown when an operation (install / sync backup /
 * sync restore) fails. Calls the host /plugin-manager/help-prompt route to
 * build a self-contained prompt, displays it, and offers one-click copy so
 * the user can paste it into a NEW conversation for assistance.
 */
import { useCallback, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export type HelpKind = 'install' | 'sync'

interface HelpPromptProps {
  open: boolean
  kind: HelpKind
  /** Install failure context (for kind === 'install'). */
  install?: {
    pluginName: string
    pluginUrl: string
    exitCode: number | null
    timedOut: boolean
    output: string
    blockedBuilds: string[]
  }
  /** Sync failure context (for kind === 'sync'). */
  sync?: {
    action: 'backup' | 'restore'
    repo: string
    branch: string
    errorCode: string
    errorMessage: string
    hint: string
    localPlugins: string[]
  }
  onClose: () => void
}

export function HelpPromptDialog({ open, kind, install, sync, onClose }: HelpPromptProps) {
  const [prompt, setPrompt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPrompt = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCopied(false)
    try {
      const body = kind === 'install'
        ? { kind: 'install', install }
        : { kind: 'sync', sync }
      const r = await fetch('/plugin-manager/help-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (data.prompt) {
        setPrompt(data.prompt)
      } else {
        setError((data.error as string) || '无法生成帮助提示词')
      }
    } catch {
      setError('无法生成帮助提示词（网络错误）')
    }
    setLoading(false)
  }, [kind, install, sync])

  const copyPrompt = useCallback(async () => {
    if (prompt === null) return
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea')
      ta.value = prompt
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [prompt])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={kind === 'install' ? '发起新对话寻求安装帮助' : '发起新对话寻求同步帮助'}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
          {prompt !== null && (
            <Button variant="primary" size="sm" onClick={copyPrompt}>
              {copied ? '✓ 已复制' : '复制提示词'}
            </Button>
          )}
        </>
      }
    >
      <div style={{ fontSize: 13, lineHeight: '20px' }}>
        {prompt === null && !loading && error === null && (
          <p style={{ margin: '0 0 12px' }}>
            点击下方按钮生成一份包含错误信息的帮助提示词，复制后打开<b>新对话</b>粘贴即可获得诊断与解决方案。
          </p>
        )}
        {loading && <p style={{ color: 'var(--dsw-alias-label-secondary,#6b7280)' }}>正在生成提示词…</p>}
        {error !== null && <p style={{ color: 'var(--dsw-alias-state-error-primary,#dc2626)' }}>{error}</p>}
        {prompt === null && !loading && (
          <Button variant="primary" size="sm" onClick={loadPrompt}>生成提示词</Button>
        )}
        {prompt !== null && (
          <>
            <pre
              style={{
                maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontSize: 12, lineHeight: '18px', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)',
                borderRadius: 8, padding: 12, margin: '0 0 8px',
              }}
            >{prompt}</pre>
            <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#9ca3af)', margin: 0 }}>
              已复制后，新建一个会话并粘贴即可。提示词已脱敏（不含任何 Token）。
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}