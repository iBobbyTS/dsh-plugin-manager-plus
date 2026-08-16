/**
 * #40: the one-click restart must not leave the replacement host
 * console-less on Windows. A `detached` spawn maps to DETACHED_PROCESS (no
 * console at all), after which every console child the host spawns (e.g.
 * DSH sandbox tool runners) pops a visible window. The fix: launch the
 * replacement through `powershell -WindowStyle Hidden`, which gives it a
 * HIDDEN console that children inherit. POSIX keeps the plain detached
 * spawn (process groups, no console concept).
 */

import { describe, expect, it } from 'vitest'
import { respawnInvocation } from '../src/restart.ts'

const LAUNCH = { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['--import', 'tsx/esm', 'bin.ts', '--profile', 'web'], viaShell: false }

describe('respawnInvocation (#40)', () => {
  it('wraps the win32 relaunch in powershell -WindowStyle Hidden (hidden console, not none)', () => {
    const spawned = respawnInvocation(LAUNCH, 'win32')
    expect(spawned.file).toBe('powershell.exe')
    expect(spawned.args.slice(0, 4)).toEqual(['-NoProfile', '-WindowStyle', 'Hidden', '-Command'])
    // The inner command line must carry the full original invocation,
    // single-quoted so spaces in paths survive PowerShell parsing.
    expect(spawned.args[4]).toBe("& 'C:\\Program Files\\nodejs\\node.exe' '--import' 'tsx/esm' 'bin.ts' '--profile' 'web'")
    // DETACHED_PROCESS is exactly the flag that caused #40.
    expect(spawned.detached).toBe(false)
    expect(spawned.viaShell).toBe(false)
  })

  it('escapes embedded single quotes PowerShell-style (doubled)', () => {
    const spawned = respawnInvocation({ file: "C:\\it's here\\dsh.cmd", args: [], viaShell: true }, 'win32')
    expect(spawned.args[4]).toBe("& 'C:\\it''s here\\dsh.cmd'")
  })

  it('keeps the plain detached spawn on POSIX', () => {
    const spawned = respawnInvocation({ file: 'node', args: ['bin.ts'], viaShell: false }, 'darwin')
    expect(spawned).toEqual({ file: 'node', args: ['bin.ts'], viaShell: false, detached: true })
  })
})
