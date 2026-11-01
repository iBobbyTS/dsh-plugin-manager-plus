/**
 * Help-prompt generation: when an operation (install / sync backup / sync
 * restore) fails, the UI offers a "start a new conversation for help" action
 * that copies a self-contained, context-rich prompt to the clipboard. The
 * user pastes it into a new DSH conversation and the model gets everything it
 * needs to diagnose the failure.
 *
 * Prompts are pure functions of the failure data — no I/O here.
 */
/** Mask anything that looks like a secret before embedding in a prompt. */
function maskSecrets(text) {
    return text
        .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'ghp_****')
        .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_****')
        .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer ****');
}
/** Truncate long output to a sane prompt size. */
function clamp(text, max = 6000) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}\n…(truncated ${text.length - max} chars)`;
}
/**
 * Build the install-failure help prompt.
 * @returns a prompt the user pastes into a new conversation.
 */
export function buildInstallHelpPrompt(ctx) {
    const blocked = ctx.blockedBuilds.length > 0
        ? `\n- pnpm 拦截了以下包的构建脚本（allowBuilds/onlyBuiltDependencies）：${ctx.blockedBuilds.join(', ')}`
        : '';
    const installed = ctx.installed.map(p => `  - ${p.name}${p.repoUrl ? ` (${p.repoUrl})` : ''}`).join('\n');
    return [
        `# 请求帮助：DSH 插件安装失败`,
        ``,
        `我尝试安装插件 **${ctx.pluginName}**（${ctx.pluginUrl}）但失败了，请帮我诊断并给出解决方案。`,
        ``,
        `## 环境信息`,
        `- DSH 版本：${ctx.dshVersion}`,
        `- 插件管理器版本：${ctx.pluginManagerVersion}`,
        `- Profile：${ctx.profile}`,
        `- 退出码：${ctx.exitCode ?? '未知'}${ctx.timedOut ? '（超时）' : ''}${blocked}`,
        ``,
        `## 当前已安装的插件`,
        installed || '  （无）',
        ``,
        `## 失败输出（stdout+stderr 尾部）`,
        '```',
        clamp(maskSecrets(ctx.output)),
        '```',
        ``,
        `## 请帮我`,
        `1. 分析失败的根本原因（pnpm 错误、依赖冲突、GitHub 源问题等）`,
        `2. 给出具体可执行的解决步骤（命令或界面操作）`,
        `3. 如果涉及构建脚本授权，说明需要放行哪些包、如何放行`,
    ].join('\n');
}
/**
 * Build the sync (backup/restore) help prompt.
 * @returns a prompt the user pastes into a new conversation.
 */
export function buildSyncHelpPrompt(ctx) {
    const actionLabel = ctx.action === 'backup' ? '备份' : '还原';
    const locals = ctx.localPlugins.length > 0
        ? `\n- 无法自动${actionLabel}的本地插件：${ctx.localPlugins.join('、')}`
        : '';
    return [
        `# 请求帮助：DSH 插件环境同步（${actionLabel}）失败`,
        ``,
        `我在执行插件环境**${actionLabel}**时遇到问题，请帮我诊断并配置。`,
        ``,
        `## 环境信息`,
        `- DSH 版本：${ctx.dshVersion}`,
        `- 插件管理器版本：${ctx.pluginManagerVersion}`,
        `- Profile：${ctx.profile}`,
        `- 同步仓库：${ctx.repo}（分支：${ctx.branch}）${locals}`,
        ``,
        `## 错误信息`,
        `- 错误码：${ctx.errorCode}`,
        `- 错误消息：${ctx.errorMessage}`,
        `- 提示：${ctx.hint || '（无）'}`,
        ``,
        `## 请帮我`,
        `1. 解释这个错误的原因（GitHub API 权限、限流、仓库配置、网络等）`,
        `2. 给出正确的配置步骤（Token 权限、仓库设置、分支等）`,
        `3. 如果需要，给出可验证的排查命令`,
    ].join('\n');
}
