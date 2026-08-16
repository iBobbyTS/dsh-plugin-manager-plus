/**
 * The pnpm compatibility layer's decision logic. The -w cases encode issue
 * #20: the flag is required at pnpm-9 workspace roots but is a HARD ERROR
 * (every pnpm major) in a profile without pnpm-workspace.yaml — so the
 * injection must depend on the profile's actual shape.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPnpmFailure, pluginArgsFor } from '../src/pnpm-compat.ts'

describe('pluginArgsFor', () => {
  let dir: string
  afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }) })

  function profileFixture(workspace: boolean): string {
    dir = mkdtempSync(join(tmpdir(), 'dshm-profile-'))
    writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}')
    if (workspace) writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    return dir
  }

  it('injects -w exactly when the profile is a workspace root (#20)', () => {
    // pnpm 9 refuses add/remove at a workspace root without -w…
    const ws = profileFixture(true)
    expect(pluginArgsFor(ws, ['add', 'dshmarket'])).toEqual(['add', '-w', 'dshmarket'])
    expect(pluginArgsFor(ws, ['remove', 'dshmarket'])).toEqual(['remove', '-w', 'dshmarket'])
    // …other subcommands pass through untouched.
    expect(pluginArgsFor(ws, ['install'])).toEqual(['install'])
    rmSync(ws, { recursive: true, force: true })
    // …and every pnpm major hard-errors on -w OUTSIDE a workspace.
    const plain = profileFixture(false)
    expect(pluginArgsFor(plain, ['add', 'dshmarket'])).toEqual(['add', 'dshmarket'])
    expect(pluginArgsFor(plain, ['remove', 'dshmarket'])).toEqual(['remove', 'dshmarket'])
  })
})

describe('classifyPnpmFailure', () => {
  it('maps each known pnpm failure signature, and only those', () => {
    const hoist = classifyPnpmFailure('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF  This modules directory was created using a different public-hoist-pattern value. Run "pnpm install" to recreate the modules directory.')
    expect(hoist?.code).toBe('hoist-pattern-diff')
    expect(hoist?.recoverable).toBe(true)

    const root = classifyPnpmFailure('ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root')
    expect(root?.code).toBe('adding-to-root')
    expect(root?.recoverable).toBe(false)

    expect(classifyPnpmFailure('[ERROR] --workspace-root may only be used inside a workspace')?.code).toBe('not-a-workspace')
    expect(classifyPnpmFailure('dsh: pnpm not found on PATH — install pnpm to manage profile plugins')?.code).toBe('pnpm-missing')

    // #39 — both faces of pnpm's release-age gate on an already-written
    // young lockfile entry: lockfile verification (remove/any mutation) and
    // re-resolution of the young dep during a later add.
    const violation = classifyPnpmFailure('[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n  is-odd@3.0.1 was published at 2018-05-31T20:04:53.306Z, within the minimumReleaseAge cutoff')
    expect(violation?.code).toBe('release-age-violation')
    expect(classifyPnpmFailure('[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 1 version does not meet the minimumReleaseAge constraint:')?.code).toBe('release-age-violation')
    // Unrecognized output → null, the raw text is then surfaced as-is.
    expect(classifyPnpmFailure('some other failure')).toBeNull()
  })
})
