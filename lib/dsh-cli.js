/**
 * Process layer: re-invoking the dsh CLI that launched this host, spawning
 * `dsh plugin` commands with timeouts and live progress, and provisioning
 * pnpm. This is the only module that starts child processes.
 *
 * Installs run through node:child_process, not ctx.shell: the shell service is
 * the agent's sandboxed executor and denies writes to the profile directory.
 */
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { logEvent } from './log.js';
import { createProgressTracker } from './ndjson.js';
import { pluginArgsFor } from './pnpm-compat.js';
import { profileDir } from './profile.js';
// 15 min default (slow networks + git installs), overridable for CI/tests.
// (#6 by @qichuang321.)
/**
 * macOS apps launched from Finder/Dock inherit a minimal PATH without the
 * shell profile — Homebrew/npm/corepack all vanish and every install dies
 * with ENOENT/127 (#32, #38). Append the well-known bin directories so the
 * market's children find their tools regardless of how dsh was started.
 */
function spawnEnv() {
    // pnpm v10+ blocks forever on a silent interactive prompt without a TTY;
    // CI mode forces it to act or fail instead of asking.
    if (process.platform === 'win32')
        return { ...process.env, CI: 'true' };
    const parts = (process.env.PATH ?? '').split(':').filter(part => part !== '');
    for (const bin of ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]) {
        if (!parts.includes(bin))
            parts.push(bin);
    }
    return { ...process.env, CI: 'true', PATH: parts.join(':') };
}
const INSTALL_TIMEOUT_MS = Number(process.env.DSH_MARKET_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000;
/**
 * Windows npm/corepack/pnpm are `.cmd` shims. Node's `spawn` without a shell
 * cannot start them (ENOENT / EINVAL). Same pattern as dsh's `plugin` forwarder.
 */
export const winCmdShim = process.platform === 'win32';
/**
 * Argv re-invoking the CLI that launched this host process, so installs work
 * whether dsh runs from a global bin, a local install, or repo source
 * (`node --import tsx/esm .../bin.ts`). Falls back to a PATH `dsh`.
 */
export function dshArgv() {
    const entry = process.argv[1];
    if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
        // Absolute paths are required: source launches (`pnpm dsh`) pass a
        // relative entry, which the child resolves against its OWN cwd and dies
        // with MODULE_NOT_FOUND (#13). cwd near the entry keeps execArgv imports
        // (tsx/esm) resolvable on source launches.
        const abs = resolve(entry);
        return { file: process.execPath, args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false };
    }
    // Bare `dsh` is a .cmd shim on Windows that only a shell can start (#13).
    return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim };
}
/**
 * Kill a spawned child and, on Windows, its whole process tree — `kill()`
 * there only terminates the wrapper, leaving pnpm children running.
 * (Contributed in #7 by @mraing.)
 */
export function killChild(child) {
    if (process.platform === 'win32' && child.pid !== undefined) {
        try {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
            return;
        }
        catch { /* fall through */ }
    }
    child.kill('SIGKILL');
}
/** The child of the operation currently running, for /dsh-market/cancel. */
let activeChild = null;
let cancelRequested = false;
/**
 * Kill a child and its whole tree, gracefully where the platform allows:
 * taskkill /T /F on Windows (plain kill() leaves pnpm children running),
 * SIGTERM with a 5s SIGKILL escalation elsewhere so pnpm can clean up.
 * (Cancel flow contributed in #6 by @qichuang321.)
 */
function killTree(child) {
    if (process.platform === 'win32' && child.pid !== undefined) {
        try {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
            return;
        }
        catch { /* fall through */ }
    }
    // POSIX: the dsh wrapper runs pnpm as a grandchild (spawnSync), which a
    // plain child.kill() leaves running — it keeps our stdio pipes open, so
    // the close event never fires and the market looks stuck "installing".
    // The child is spawned detached as its own process GROUP; kill the group.
    const signalTree = (signal) => {
        if (child.pid === undefined)
            return;
        try {
            process.kill(-child.pid, signal);
        }
        catch {
            try {
                child.kill(signal);
            }
            catch { /* already gone */ }
        }
    };
    signalTree('SIGTERM');
    const escalate = setTimeout(() => signalTree('SIGKILL'), 5000);
    escalate.unref?.();
}
/**
 * Cancel the plugin command currently running.
 * @returns true when there was one to cancel.
 */
export function cancelActive() {
    if (activeChild === null)
        return false;
    cancelRequested = true;
    progress.cancelling = true;
    killTree(activeChild);
    return true;
}
/** Whether `pnpm` resolves on PATH; success is cached, absence is re-probed. */
let pnpmReady = false;
/** Probe `pnpm --version` on PATH. */
export function probePnpm() {
    if (pnpmReady)
        return Promise.resolve(true);
    return new Promise((resolvePromise) => {
        const child = spawn('pnpm', ['--version'], { stdio: 'ignore', shell: winCmdShim, env: spawnEnv() });
        child.on('error', () => resolvePromise(false));
        child.on('close', (code) => {
            pnpmReady = code === 0;
            resolvePromise(pnpmReady);
        });
    });
}
function runQuiet(file, args, timeoutMs) {
    return new Promise((resolvePromise) => {
        const child = spawn(file, args, {
            env: spawnEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: winCmdShim,
        });
        let output = '';
        const timer = setTimeout(() => killChild(child), timeoutMs);
        const collect = (chunk) => { output = (output + chunk.toString()).slice(-8 * 1024); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: 127, output: error.message }); });
        child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, output }); });
    });
}
/**
 * Provision pnpm without user involvement: corepack (ships with Node) first,
 * a global npm install as fallback.
 * @returns true when `pnpm --version` succeeds afterwards.
 */
export async function provisionPnpm() {
    const corepack = await runQuiet('corepack', ['enable', 'pnpm'], 60 * 1000);
    logEvent(corepack.code === 0 ? 'info' : 'warn', 'setup-pnpm', `corepack enable: exit=${String(corepack.code)} ${corepack.output.slice(-200)}`);
    if (await probePnpm())
        return { ok: true };
    const npm = await runQuiet('npm', ['install', '-g', 'pnpm'], 3 * 60 * 1000);
    logEvent(npm.code === 0 ? 'info' : 'error', 'setup-pnpm', `npm -g: exit=${String(npm.code)} ${npm.output.slice(-200)}`);
    if (await probePnpm())
        return { ok: true };
    // Both provisioning tools missing = Node itself is not on this process's
    // PATH (typical for Finder/Dock launches with nvm/fnm). Pointing the user
    // back at this same button would be a dead end (#32) — say what actually
    // helps.
    const pathIssue = /ENOENT/.test(corepack.output) && /ENOENT/.test(npm.output);
    return {
        ok: false,
        hint: pathIssue
            ? '这台机器的 dsh 进程找不到 Node（从图形界面启动不继承终端 PATH）。请改从终端启动 dsh，或安装 Homebrew 版 pnpm：brew install pnpm / This dsh process cannot find Node (GUI launches skip your shell PATH). Start dsh from a terminal, or install pnpm via Homebrew: brew install pnpm'
            : undefined,
    };
}
/** Singleton progress state; the status route reads it, runDshPlugin writes it. */
export const progress = {
    active: false,
    target: '',
    startedAt: 0,
    lastLine: '',
    phase: null,
    done: 0,
    total: null,
    currentPackage: null,
    downloaded: null,
    size: null,
    ndjson: false,
    error: null,
    cancelling: false,
};
/** Identifies this host process; the client scopes its pending-restart flags to it. */
export const BOOT_ID = `${String(process.pid)}-${String(Date.now())}`;
/**
 * Central allowlist for every spawn target, regardless of which route built
 * it (defense in depth on top of per-route validation — the win32 bare-dsh
 * fallback runs through a shell). Suggested in #16 by @anupamme.
 */
const TARGET_RE = /^[A-Za-z0-9@:./_#+-]+$/;
/** Mutating pnpm commands get the structured reporter appended. */
const NDJSON_COMMANDS = new Set(['add', 'remove', 'install']);
/**
 * Line-buffered progress feed: pnpm's ndjson reporter emits one JSON object
 * per line on stdout, and chunk boundaries can split a line. Human fallback
 * lines (older pnpm without structured events) still update `lastLine`.
 */
function makeProgressFeeder(tracker) {
    let lineBuffer = '';
    return (chunk) => {
        lineBuffer += chunk;
        let nl;
        while ((nl = lineBuffer.indexOf('\n')) !== -1) {
            const line = lineBuffer.slice(0, nl);
            lineBuffer = lineBuffer.slice(nl + 1);
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            tracker.feed(trimmed);
            // Human lines never start with '{'; JSON lines are consumed by the tracker.
            if (!trimmed.startsWith('{'))
                progress.lastLine = trimmed.slice(0, 200);
        }
    };
}
/** Run one `dsh plugin --profile <p> …` command with timeout and progress tracking. */
export function runDshPlugin(profile, pluginArgs) {
    const { file, args, cwd, viaShell } = dshArgv();
    pluginArgs = pluginArgsFor(profileDir(profile), pluginArgs);
    const target = pluginArgs[pluginArgs.length - 1] ?? '';
    if (!TARGET_RE.test(target)) {
        logEvent('error', 'install', `unsafe plugin target rejected: ${JSON.stringify(target)}`);
        return Promise.resolve({ exitCode: 1, timedOut: false, stdout: '', stderr: `unsafe plugin target rejected: ${JSON.stringify(target)}`, cancelled: false });
    }
    // pnpm's structured reporter must be appended after the target is extracted
    // (the allowlist above validates the last argument).
    if (NDJSON_COMMANDS.has(pluginArgs[0]))
        pluginArgs = [...pluginArgs, '--reporter=ndjson'];
    progress.active = true;
    progress.target = target;
    progress.startedAt = Date.now();
    progress.lastLine = '';
    progress.phase = null;
    progress.done = 0;
    progress.total = null;
    progress.currentPackage = null;
    progress.downloaded = null;
    progress.size = null;
    progress.ndjson = false;
    progress.error = null;
    progress.cancelling = false;
    const tracker = createProgressTracker();
    const feed = makeProgressFeeder(tracker);
    return new Promise((resolvePromise) => {
        const child = spawn(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
            cwd,
            // pnpm v10 blocks forever on a silent interactive prompt without a TTY
            // (observed on re-add over a pinned git spec); CI mode forces it to act
            // or fail instead of asking.
            env: spawnEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: viaShell,
            // Own process group on POSIX so cancel/timeout can kill the whole
            // tree (dsh wrapper + pnpm grandchild) with one group signal.
            detached: process.platform !== 'win32',
        });
        activeChild = child;
        cancelRequested = false;
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, INSTALL_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout = (stdout + text).slice(-256 * 1024);
            feed(text);
            syncProgress(tracker);
        });
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderr = (stderr + text).slice(-64 * 1024);
            feed(text);
            syncProgress(tracker);
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            progress.active = false;
            progress.cancelling = false;
            if (activeChild === child)
                activeChild = null;
            resolvePromise({ exitCode: 127, timedOut: false, stdout, stderr: `${stderr}\n${error.message}`, cancelled: false });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            progress.active = false;
            progress.cancelling = false;
            if (activeChild === child)
                activeChild = null;
            const failed = code !== 0 || timedOut;
            if (failed)
                progress.error = tracker.snapshot.error;
            const ignoredBuilds = tracker.snapshot.ignoredBuilds;
            resolvePromise({
                exitCode: code,
                timedOut,
                stdout,
                stderr,
                cancelled: cancelRequested,
                ...(ignoredBuilds.length > 0 ? { ignoredBuilds } : {}),
            });
        });
    });
}
/** Copy the tracker's snapshot into the singleton the status route reads. */
function syncProgress(tracker) {
    const snap = tracker.snapshot;
    progress.phase = snap.phase;
    progress.done = snap.done;
    progress.total = snap.total;
    progress.currentPackage = snap.currentPackage;
    progress.downloaded = snap.downloaded;
    progress.size = snap.size;
    progress.ndjson = snap.seen;
    if (snap.error !== null)
        progress.error = snap.error;
}
/**
 * Trial boot probe: installs a plugin into a temporary DSH_HOME profile,
 * boots it on a free port, and waits for the readiness line. If the plugin
 * bricks the boot or fails to install, the real profile is never touched.
 * (Port from Sanqi/dsh-webui-market-plugin.)
 * @returns ok + stage + output for diagnosis.
 */
export async function runProbe(explicitBin, source, signal) {
    const home = mkdtempSync(join(tmpdir(), 'dsh-mkts-probe-'));
    try {
        const profileDirPath = join(home, 'profiles', 'web');
        mkdirSync(profileDirPath, { recursive: true });
        writeFileSync(join(profileDirPath, 'package.json'), JSON.stringify({
            name: 'dsh-profile-web', private: true, dependencies: {},
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
        }, null, 2) + '\n');
        writeFileSync(join(profileDirPath, 'cordis.patch.yml'), '[]\n');
        writeFileSync(join(profileDirPath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
        const env = { ...process.env, CI: 'true', DSH_HOME: home };
        // 1) Install into the trial profile
        const installResult = await runDshPluginInternal(explicitBin, home, 'web', ['add', source], 60_000, signal);
        if (!installResult.ok || installResult.exitCode !== 0) {
            return { ok: false, stage: 'install', output: installResult.stderr || installResult.stdout || 'install failed' };
        }
        // 2) Boot the trial profile; readiness line is the verdict
        const bootResult = await runDshPluginInternal(explicitBin, home, 'web', [], 30_000, signal);
        if (bootResult.ready)
            return { ok: true, stage: 'boot', output: '' };
        return { ok: false, stage: 'boot', output: bootResult.stderr || bootResult.stdout || 'boot failed' };
    }
    finally {
        try {
            rmSync(home, { recursive: true, force: true, maxRetries: 3 });
        }
        catch { /* best-effort cleanup */ }
    }
}
/** Internal variant of runDshPlugin that supports custom DSH_HOME and readiness detection. */
async function runDshPluginInternal(explicitBin, dshHome, profile, pluginArgs, timeoutMs, signal) {
    const bin = resolvePluginBin(explicitBin);
    const args = [...bin.args, ...(pluginArgs.length > 0 ? ['plugin', '--profile', profile, ...pluginArgs] : ['--profile', profile, '--host', '127.0.0.1', '--port', '0'])];
    const env = { ...process.env, CI: 'true', DSH_HOME: dshHome };
    return new Promise(resolve => {
        const child = spawn(bin.file, args, { cwd: join(dshHome, 'profiles', profile), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', settled = false;
        const timer = setTimeout(() => { if (!settled) {
            settled = true;
            child.kill();
            resolve({ ok: false, exitCode: null, stdout, stderr, ready: false });
        } }, timeoutMs);
        const finish = (exitCode, ready) => { if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: exitCode === 0, exitCode, stdout, stderr, ready });
        } };
        child.stdout.on('data', (d) => { stdout += d.toString(); if (/dsh web: http:\/\//.test(stdout))
            finish(null, true); });
        child.stderr.on('data', (d) => { stderr += d.toString(); if (/dsh web: http:\/\//.test(stderr))
            finish(null, true); });
        if (signal)
            signal.addEventListener('abort', () => { if (!settled) {
                settled = true;
                child.kill();
                resolve({ ok: false, exitCode: null, stdout, stderr, ready: false });
            } }, { once: true });
        child.on('close', (code) => finish(code, /dsh web: http:\/\//.test(stdout + stderr)));
        child.on('error', () => { if (!settled) {
            settled = true;
            resolve({ ok: false, exitCode: null, stdout, stderr, ready: false });
        } });
    });
}
/** Resolve the dsh binary path, falling back to the current process's argv. */
function resolvePluginBin(explicitBin) {
    if (explicitBin)
        return { file: explicitBin, args: [] };
    // Try the current process's entry point
    const argv = process.argv;
    if (argv.length >= 2)
        return { file: argv[1], args: argv.slice(2).filter(a => a !== '--profile' && !a.startsWith('--profile=') && a !== 'web' && !a.startsWith('--port') && !a.startsWith('--host')) };
    return { file: 'dsh', args: [] };
}
