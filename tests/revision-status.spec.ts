import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  installed: {} as Record<string, string>,
  commits: new Map<string, string>(),
}))

vi.mock('../src/profile.ts', () => ({
  readInstalled: () => fixtures.installed,
  readInstalledVersion: (_profile: string, name: string) => name === 'npm-plugin' ? '1.0.0' : '0.1.0',
  readLockCommits: () => fixtures.commits,
}))

import { checkUpdates, githubRepoFromSpec, invalidateUpdates } from '../src/updates.ts'

const installedSha = 'a'.repeat(40)
const latestSha = 'b'.repeat(40)

function stubApi(compare: { ahead_by?: unknown; behind_by?: unknown } | null): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url)
    if (path.includes('/commits/HEAD')) return new Response(JSON.stringify({ sha: latestSha }), { status: 200 })
    if (path.includes('/compare/')) return compare === null
      ? new Response('rate limited', { status: 403 })
      : new Response(JSON.stringify(compare), { status: 200 })
    if (path.includes('/npm-plugin/latest')) return new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })
    throw new Error('Unexpected API call: ' + path)
  }))
}

beforeEach(() => {
  invalidateUpdates()
  fixtures.installed = { 'git-plugin': 'github:alice/repo', 'npm-plugin': '^1.0.0' }
  fixtures.commits = new Map([['alice/repo', installedSha]])
})
afterEach(() => { invalidateUpdates(); vi.unstubAllGlobals() })

describe('installed GitHub revision distance', () => {
  it('recognizes GitHub installations but not npm package names', () => {
    expect(githubRepoFromSpec('github:alice/repo#main')).toBe('alice/repo')
    expect(githubRepoFromSpec('git+https://github.com/alice/repo.git')).toBe('alice/repo')
    expect(githubRepoFromSpec('git@github.com:alice/repo.git')).toBe('alice/repo')
    expect(githubRepoFromSpec('^1.0.0')).toBeNull()
  })

  it('reports npm releases separately from GitHub compare ahead_by', async () => {
    stubApi({ ahead_by: 4, behind_by: 0 })
    const updates = await checkUpdates('web')
    expect(updates['git-plugin']).toMatchObject({
      kind: 'github', repo: 'alice/repo', current: installedSha, latest: latestSha,
      behind: 4, ahead: 0, updateAvailable: true,
    })
    expect(updates['npm-plugin']).toMatchObject({
      kind: 'npm', current: '1.0.0', latest: '1.2.0', updateAvailable: true,
    })
    expect(updates['npm-plugin']?.behind).toBeUndefined()
  })

  it('reports both sides of divergent history without inventing a linear count', async () => {
    stubApi({ ahead_by: 5, behind_by: 2 })
    expect((await checkUpdates('web'))['git-plugin']).toMatchObject({ behind: 5, ahead: 2 })
  })

  it('keeps revision counts unknown when GitHub compare is unavailable', async () => {
    stubApi(null)
    expect((await checkUpdates('web'))['git-plugin']).toMatchObject({
      current: installedSha, latest: latestSha, behind: null, ahead: null,
    })
  })

  it('does not query compare for identical commits', async () => {
    fixtures.commits = new Map([['alice/repo', latestSha]])
    stubApi(null)
    const updates = await checkUpdates('web')
    expect(updates['git-plugin']).toMatchObject({ behind: 0, ahead: 0, updateAvailable: false })
    const mockFetch = vi.mocked(fetch)
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/compare/'))).toBe(false)
  })
})
