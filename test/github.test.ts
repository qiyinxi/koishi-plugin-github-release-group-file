import { describe, expect, it } from 'vitest'
import {
  compileAssetPattern,
  isExpectedAssetUrl,
  releasesFrom,
  selectMatchingAssets,
  type GitHubRelease,
  type GitHubReleaseAsset,
} from '../src/github'

const owner = 'AUTO-MAS-Project'
const repository = 'AUTO-MAS'

function asset(
  id: number,
  name: string,
  size = 100,
  url = `https://github.com/${owner}/${repository}/releases/download/v5.4.0-beta.2/${name}`,
): GitHubReleaseAsset {
  return {
    id,
    name,
    state: 'uploaded',
    content_type: 'application/zip',
    size,
    digest: `sha256:${String(id).padStart(64, '0')}`,
    browser_download_url: url,
    created_at: '2026-07-29T05:38:00Z',
    updated_at: '2026-07-29T05:38:00Z',
  }
}

function release(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    id: 361527149,
    tag_name: 'v5.4.0-beta.2',
    name: 'v5.4.0-beta.2',
    html_url: `https://github.com/${owner}/${repository}/releases/tag/v5.4.0-beta.2`,
    draft: false,
    prerelease: true,
    created_at: '2026-07-29T05:37:00Z',
    published_at: '2026-07-29T05:38:54Z',
    updated_at: '2026-07-29T05:38:54Z',
    assets: [],
    ...overrides,
  }
}

describe('AUTO-MAS asset selection', () => {
  it('selects only Lite Setup x64 ZIP assets', () => {
    const target = asset(
      493648467,
      'AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
      105638256,
    )
    const candidate = release({
      assets: [
        target,
        asset(2, 'AUTO-MAS-Full-v5.4.0-beta.2-x64.zip'),
        asset(3, 'AUTO-MAS-Full-Setup-v5.4.0-beta.2-x64.zip'),
        asset(4, 'AUTO-MAS-Lite-v5.4.0-beta.2-x64.zip'),
      ],
    })
    const pattern = compileAssetPattern('^AUTO-MAS-Lite-Setup-v.+-x64\\.zip$')

    expect(selectMatchingAssets(candidate, pattern, owner, repository)).toEqual([target])
  })

  it('rejects matching names hosted outside the configured GitHub repository', () => {
    const candidate = release({
      assets: [
        asset(
          1,
          'AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
          100,
          'https://example.com/AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
        ),
      ],
    })
    const pattern = compileAssetPattern('^AUTO-MAS-Lite-Setup-v.+-x64\\.zip$')

    expect(selectMatchingAssets(candidate, pattern, owner, repository)).toEqual([])
  })

  it('includes the configured beta start release and later stable releases', () => {
    const releases = [
      release({
        id: 3,
        tag_name: 'v5.4.1',
        prerelease: false,
        published_at: '2026-07-30T00:00:00Z',
      }),
      release({ id: 2 }),
      release({
        id: 1,
        tag_name: 'v5.3.0',
        prerelease: false,
        published_at: '2026-07-01T00:00:00Z',
      }),
    ]

    expect(releasesFrom(
      releases,
      new Date('2026-07-29T05:38:54Z'),
      true,
    ).map((item) => item.tag_name)).toEqual([
      'v5.4.0-beta.2',
      'v5.4.1',
    ])
  })
})

describe('GitHub asset URL validation', () => {
  it('accepts the requested release download URL', () => {
    expect(isExpectedAssetUrl(
      'https://github.com/AUTO-MAS-Project/AUTO-MAS/releases/download/v5.4.0-beta.2/AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
      owner,
      repository,
    )).toBe(true)
  })

  it('rejects another repository and non-HTTPS URLs', () => {
    expect(isExpectedAssetUrl(
      'https://github.com/other/AUTO-MAS/releases/download/v1/file.zip',
      owner,
      repository,
    )).toBe(false)
    expect(isExpectedAssetUrl(
      'http://github.com/AUTO-MAS-Project/AUTO-MAS/releases/download/v1/file.zip',
      owner,
      repository,
    )).toBe(false)
  })
})
