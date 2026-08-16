/**
 * HelpPromptDialog: shown when an operation (install / sync backup /
 * sync restore) fails.
 *
 * - The prompt is generated IMMEDIATELY on open (pre-built template) via the
 *   host /plugin-manager/help-prompt route — no extra click.
 * - "创建新对话并发送" creates a fresh DSH session through the public
 *   apiproxy (POST /api/session.create → POST /api/session.prompt) and sends
 *   the prompt, so the user gets the diagnosis conversation started directly.
 * - A copy button remains as a fallback.
 *
 * The install-failure payload deliberately sends only the plugin name when the
 * host has cached the failure server-side — avoids "request body too large"
 * from big pnpm logs.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export type HelpKind = 'install' | 'sync'

interface HelpPromptProps {
  open: boolean
  kind: HelpKind
  /** Install failure context (for kind === 'install'). Only pluginName is
   * required when the host cached the failure; the rest is best-effort. */
  install?: {
    pluginName: string
    pluginUrl?: string
    exitCode?: number | null
    timedOut?: boolean
    output?: string
    blockedBuilds?: string[]
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

/** One apiproxy RPC call against the same-origin /api endpoint. */
async function rpc(method: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const r = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dsh-pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload,
    }),
  })
  const data = (await r.json().catch(() => ({}))) as {
    result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
  }
  const result = data.result
  if (result?.ok === true) return { ok: true, value: result.value }
  return { ok: false, error: result?.error?.message ?? `HTTP ${r.status}` }
}

export function HelpPromptDialog({ open, kind, install, sync, onClose }: HelpPromptProps) {
  const [prompt, setPrompt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  // Pre-generate the prompt as soon as the dialog opens (no extra click).
  const loadPrompt = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCopied(false)
    setSent(false)
    try {
      const body = kind === 'install'
        // Install: send ONLY the plugin name — the host uses its cached
        // failure (output, exitCode, blocked builds) so no large body.
        ? { kind: 'install', install: install }
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

  useEffect(() => {
    if (open) {
      setPrompt(null)
      setLoading(false)
      setError(null)
      setCopied(false)
      setSent(false)
      setSending(false)
      void loadPrompt()
    }
  }, [open, loadPrompt])

  const copyPrompt = useCallback(async () => {
    if (prompt === null) return
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
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

  /** Create a fresh session and send the prompt through the DSH apiproxy. */
  const sendToNewConversation = useCallback(async () => {
    if (prompt === null) return
    setSending(true)
    setError(null)
    try {
      const created = await rpc('session.create', {})
      if (!created.ok) {
        setError(`创建新对话失败：${created.error ?? '未知错误'}`)
        return
      }
      const sessionId = (created.value as { sessionId?: string } | undefined)?.sessionId
      if (!sessionId) {
        setError('创建新对话失败：未返回 sessionId')
        return
      }
      const sentRes = await rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      })
      if (!sentRes.ok) {
        setError(`发送提示词失败：${sentRes.error ?? '未知错误'}`)
        return
      }
      setSent(true)
    } catch {
      setError('发起新对话失败（网络错误）')
    }
    setSending(false)
  }, [prompt])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={kind === 'install' ? '发起新对话寻求安装帮助' : '发起新对话寻求同步帮助'}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
          {prompt !== null && (
            <Button variant="outline" size="sm" onClick={copyPrompt}>
              {copied ? '✓ 已复制' : '复制提示词'}
            </Button>
          )}
          {prompt !== null && !sent && (
            <Button variant="primary" size="sm" onClick={sendToNewConversation} disabled={sending}>
              {sending ? '正在创建对话…' : '创建新对话并发送'}
            </Button>
          )}
        </>
      }
    >
      <div style={{ fontSize: 13, lineHeight: '20px' }}>
        {sent ? (
          <p style={{ margin: 0 }}>
            ✅ 已创建新对话并发送提示词。切到新会话即可查看 AI 给出的诊断与解决步骤。
          </p>
        ) : (
          <>
            {loading && <p style={{ color: 'var(--dsw-alias-label-secondary,#6b7280)' }}>正在生成提示词…</p>}
            {error !== null && <p style={{ color: 'var(--dsw-alias-state-error-primary,#dc2626)' }}>{error}</p>}
            {prompt === null && !loading && !error && (
              <p style={{ margin: 0 }}>提示词生成失败，请关闭后重试。</p>
            )}
            {prompt !== null && (
              <>
                <p style={{ margin: '0 0 10px' }}>
                  将以下提示词发送到<b>新对话</b>，即可获得包含错误上下文的诊断与解决方案。提示词已脱敏（不含任何 Token）。
                </p>
                <pre
                  style={{
                    maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontSize: 12, lineHeight: '18px', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)',
                    borderRadius: 8, padding: 12, margin: '0 0 8px',
                  }}
                >{prompt}</pre>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}