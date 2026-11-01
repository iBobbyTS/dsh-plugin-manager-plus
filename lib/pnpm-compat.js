/**
 * pnpm compatibility layer — everything the market needs to know about how
 * different pnpm majors behave inside a dsh profile directory, kept pure and
 * separately testable (test/unit + test/integration exercise this module
 * against real pnpm 9/10/11).
 *
 * Verified behavior matrix (2026-08, pnpm 9.15.9 / 10.28.2 / 11.21.0):
 * - workspace root, `add` without -w:  pnpm 9 fails ERR_PNPM_ADDING_TO_ROOT;
 *   pnpm 10/11 succeed.
 * - `add -w` where NO pnpm-workspace.yaml exists: ALL majors fail with
 *   "--workspace-root may only be used inside a workspace".
 * - modules dir built by pnpm 9, then pnpm 10/11 mutate it:
 *   ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF (defaults drifted between majors).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Decide the argv for a `dsh plugin <add|remove> …` call in the given profile.
 *
 * pnpm 9 refuses to add at a workspace root without -w (#17, #20); every
 * pnpm major refuses -w when the directory is NOT a workspace. So the flag
 * is injected exactly when the profile has a pnpm-workspace.yaml.
 * @param profileDir - resolved profile directory (owns pnpm-workspace.yaml, or not).
 * @param pluginArgs - the raw args, e.g. ['add', 'dshmarket@latest'].
 * @returns args with -w injected when — and only when — the profile is a workspace root.
 */
export function pluginArgsFor(profileDir, pluginArgs) {
    if (pluginArgs[0] !== 'add' && pluginArgs[0] !== 'remove')
        return pluginArgs;
    if (!existsSync(join(profileDir, 'pnpm-workspace.yaml')))
        return pluginArgs;
    return [pluginArgs[0], '-w', ...pluginArgs.slice(1)];
}
/**
 * Map a failed pnpm run's combined output to a known failure mode.
 *
 * dsh's own wrapper line ("dsh: pnpm failed in profile directory …") names no
 * cause, so the market must recognize pnpm's real diagnostics itself (#20).
 * @param output - stdout+stderr of the failed run.
 * @returns the classified failure, or null when unrecognized (raw output is then shown as-is).
 */
export function classifyPnpmFailure(output) {
    if (output.includes('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF')) {
        return {
            code: 'hoist-pattern-diff',
            recoverable: true,
            message: 'profile 的 node_modules 是旧版 pnpm 创建的，与当前 pnpm 的默认配置不兼容，需要重建后重试 / this profile\'s node_modules was created by a different pnpm major; it must be rebuilt (pnpm install) before changes can be applied',
        };
    }
    if (output.includes('ERR_PNPM_ADDING_TO_ROOT')) {
        return {
            code: 'adding-to-root',
            recoverable: false,
            message: 'pnpm 拒绝在 workspace 根目录安装（缺少 -w）。这是市场的 bug，请升级 dshmarket 到最新版 / pnpm refused to add at a workspace root (missing -w); this is a market bug — please update dshmarket',
        };
    }
    if (/--workspace-root may only be used inside a workspace/i.test(output)) {
        return {
            code: 'not-a-workspace',
            recoverable: false,
            message: 'profile 目录不是 pnpm workspace，却传入了 -w。这是市场的 bug，请升级 dshmarket 到最新版 / -w was passed but the profile is not a pnpm workspace; this is a market bug — please update dshmarket',
        };
    }
    // #39: once a release younger than minimumReleaseAge is in the lockfile
    // (fresh install or a force-update), pnpm 11 verifies the WHOLE lockfile
    // before ANY later mutation — uninstalling even an unrelated plugin fails
    // (MINIMUM_RELEASE_AGE_VIOLATION), and a later add can fail re-resolving
    // the young dep (NO_MATURE_MATCHING_VERSION). Recovery is a one-shot
    // --config.minimumReleaseAge=0 retry, automated in withHoistRecovery.
    if (output.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
        || output.includes('ERR_PNPM_NO_MATURE_MATCHING_VERSION')) {
        return {
            code: 'release-age-violation',
            recoverable: false,
            message: '这个 profile 里有一个刚发布不久的插件版本，pnpm 的安全等待期检查因此拒绝了本次改动（即使改的是别的插件）。市场已自动放行重试一次；若仍看到本条，请导出日志反馈 / a recently-published plugin version in this profile trips pnpm\'s fresh-release safety check, blocking any change (even to other plugins); the market retries once with a one-shot bypass — if you still see this, export the log and report it',
        };
    }
    if (output.includes('pnpm not found on PATH')) {
        return {
            code: 'pnpm-missing',
            recoverable: false,
            message: '找不到 pnpm，请先在市场页顶部一键安装组件 / pnpm is not on PATH — use the one-click setup at the top of the market page',
        };
    }
    return null;
}
/**
 * Detect `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` in pnpm output and heal it
 * by writing the flagged packages into the profile's `pnpm-workspace.yaml`
 * `minimumReleaseAgeExclude` block. (Port from Sanqi/dsh-webui-market-plugin.)
 * @returns the list of flagged package@version entries that were added, or
 *          empty array when no healing was needed or possible.
 */
export function healReleaseAgeExclude(profile, output) {
    const text = String(output || '');
    if (!/ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|minimumReleaseAge/.test(text))
        return [];
    const flagged = new Set();
    for (const m of text.matchAll(/([^\s]+) was published at [^,\n]+, within the minimumReleaseAge cutoff/g)) {
        const entry = String(m[1] || '').trim();
        if (/^[@A-Za-z0-9_.-]+@[0-9]/.test(entry))
            flagged.add(entry);
    }
    if (flagged.size === 0)
        return [];
    const yamlPath = join(profile, 'pnpm-workspace.yaml');
    if (!existsSync(yamlPath))
        return [];
    try {
        let yaml = readFileSync(yamlPath, 'utf8');
        const blockRe = /^minimumReleaseAgeExclude:\n((?:[ \t]+- .*(?:\n|$))*)/m;
        const existing = new Map();
        const addEntry = (entry) => {
            const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0);
            if (at <= 0)
                return;
            const name = entry.slice(0, at);
            if (!existing.has(name))
                existing.set(name, new Set());
            for (const v of entry.slice(at + 1).split('||')) {
                const t = v.trim();
                if (t)
                    existing.get(name).add(t);
            }
        };
        const m = blockRe.exec(yaml);
        if (m) {
            for (const line of m[1].split('\n')) {
                const mm = /^\s*-\s*(.+?)\s*$/.exec(line);
                if (mm)
                    addEntry(mm[1].replace(/^['"]|['"]$/g, ''));
            }
        }
        const added = [];
        for (const e of flagged) {
            const at = e.indexOf('@', e.startsWith('@') ? 1 : 0);
            if (at <= 0)
                continue;
            const name = e.slice(0, at);
            const ver = e.slice(at + 1);
            if (!existing.has(name) || !existing.get(name).has(ver)) {
                if (!existing.has(name))
                    existing.set(name, new Set());
                existing.get(name).add(ver);
                added.push(e);
            }
        }
        if (added.length === 0)
            return [];
        const lines = [...existing.entries()].flatMap(([name, versions]) => [...versions].map(v => `  - '${name}@${v}'`));
        const blockText = `minimumReleaseAgeExclude:\n${lines.join('\n')}\n`;
        yaml = blockRe.test(yaml) ? yaml.replace(blockRe, blockText) : `${yaml.replace(/\n?$/, '\n')}${blockText}`;
        writeFileSync(yamlPath, yaml);
        return added;
    }
    catch {
        return [];
    }
}
