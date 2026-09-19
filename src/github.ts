import type { Context } from 'koishi'
import '@koishijs/plugin-http'

export const GITHUB_API_ROOT = 'https://api.github.com'

export interface GitHubReleaseAsset {
  id: number
  name: string
  state: string
  content_type: string
  size: number
  digest?: string | null
  browser_download_url: string
  created_at: string
  updated_at: string
}

export interface GitHubRelease {
  id: number
  tag_name: string
  name: string | null
  html_url: string
  draft: boolean
  prerelease: boolean
  created_at: string
  published_at: string | null
  updated_at: string
  assets: GitHubReleaseAsset[]
}

export interface GitHubClientConfig {
  owner: string
  repository: string
  token: string
  timeout: number
  retries: number
}

export class GitHubReleaseClient {
  private readonly headers: Record<string, string>

  constructor(
    private readonly ctx: Context,
    private readonly config: GitHubClientConfig,
  ) {
    assertRepositoryPart(config.owner, '仓库所有者')
    assertRepositoryPart(config.repository, '仓库名称')
    this.headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'koishi-plugin-github-release-group-file/0.1',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (config.token.trim()) {
      this.headers.Authorization = `Bearer ${config.token.trim()}`
    }
  }

  async getByTag(tag: string): Promise<GitHubRelease> {
    if (!tag.trim()) throw new Error('起始 Release 标签不能为空。')
    const url = this.repositoryApiUrl(`/releases/tags/${encodeURIComponent(tag.trim())}`)
    return this.getWithRetries<GitHubRelease>(url)
  }

  async listRecent(perPage = 20): Promise<GitHubRelease[]> {
    const count = Math.max(1, Math.min(100, Math.floor(perPage)))
    const url = this.repositoryApiUrl(`/releases?per_page=${count}`)
    return this.getWithRetries<GitHubRelease[]>(url)
  }

  private repositoryApiUrl(suffix: string): string {
    return `${GITHUB_API_ROOT}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repository)}${suffix}`
  }

  private async getWithRetries<T>(url: string): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.retries; attempt += 1) {
      try {
        return await this.ctx.http.get<T>(url, {
          headers: this.headers,
          timeout: this.config.timeout,
        })
      } catch (error) {
        lastError = error
        if (attempt < this.config.retries) {
          await delay(500 * (attempt + 1))
        }
      }
    }
    throw new Error(`GitHub Release API 请求失败：${errorMessage(lastError)}`)
  }
}

export function compileAssetPattern(source: string): RegExp {
  const value = source.trim()
  if (!value) throw new Error('附件名称正则不能为空。')
  if (value.length > 512) throw new Error('附件名称正则过长。')
  try {
    return new RegExp(value, 'u')
  } catch (error) {
    throw new Error(`附件名称正则无效：${errorMessage(error)}`)
  }
}

export function isEligibleRelease(
  release: GitHubRelease,
  includePrereleases: boolean,
): boolean {
  return !release.draft
    && Boolean(release.published_at)
    && (includePrereleases || !release.prerelease)
}

export function selectMatchingAssets(
  release: GitHubRelease,
  pattern: RegExp,
  owner: string,
  repository: string,
): GitHubReleaseAsset[] {
  return release.assets.filter((asset) => {
    pattern.lastIndex = 0
    return asset.state === 'uploaded'
      && Number.isSafeInteger(asset.id)
      && Number.isSafeInteger(asset.size)
      && asset.size > 0
      && isSafeAssetName(asset.name)
      && pattern.test(asset.name)
      && isExpectedAssetUrl(asset.browser_download_url, owner, repository)
  })
}

export function releasesFrom(
  releases: readonly GitHubRelease[],
  publishedAt: Date,
  includePrereleases: boolean,
): GitHubRelease[] {
  const cutoff = publishedAt.getTime()
  return releases
    .filter((release) => {
      if (!isEligibleRelease(release, includePrereleases)) return false
      const timestamp = Date.parse(release.published_at!)
      return Number.isFinite(timestamp) && timestamp >= cutoff
    })
    .sort((left, right) => {
      const timeDifference = Date.parse(left.published_at!) - Date.parse(right.published_at!)
      return timeDifference || left.id - right.id
    })
}

export function isSafeAssetName(name: string): boolean {
  return Boolean(name)
    && name.length <= 255
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0')
}

export function isExpectedAssetUrl(
  value: string,
  owner: string,
  repository: string,
): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return false
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    return segments.length >= 6
      && segments[0].toLowerCase() === owner.toLowerCase()
      && segments[1].toLowerCase() === repository.toLowerCase()
      && segments[2] === 'releases'
      && segments[3] === 'download'
      && Boolean(segments[4])
      && Boolean(segments[5])
  } catch {
    return false
  }
}

function assertRepositoryPart(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(`${label}只能包含字母、数字、点、下划线和连字符。`)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
