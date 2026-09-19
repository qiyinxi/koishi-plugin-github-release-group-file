import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { GitHubReleaseAsset } from './github'

const AUTO_MAS_OWNER = 'AUTO-MAS-Project'
const AUTO_MAS_REPOSITORY = 'AUTO-MAS'
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 10

export interface DownloaderConfig {
  baseDir: string
  directory: string
  timeoutMinutes: number
  retries: number
  githubToken: string
}

export interface DownloadedAsset {
  path: string
  cached: boolean
}

export interface DownloadSource {
  label: string
  url: string
  githubAuthorization: boolean
}

export interface DownloadStreamResponse {
  body: Readable
  headers: IncomingHttpHeaders
  statusCode: number
  statusMessage: string
  url: string
}

export interface DownloadStreamRequest {
  headers: Record<string, string>
  signal: AbortSignal
  stallTimeoutMilliseconds: number
}

export type StreamRequester = (
  url: string,
  options: DownloadStreamRequest,
) => Promise<DownloadStreamResponse>

export class ReleaseAssetDownloader {
  readonly directory: string

  constructor(
    private readonly config: DownloaderConfig,
    private readonly requester: StreamRequester = requestHttpsStream,
  ) {
    this.directory = resolveOwnedDownloadDirectory(config.baseDir, config.directory)
  }

  async obtain(asset: GitHubReleaseAsset): Promise<DownloadedAsset> {
    await mkdir(this.directory, { recursive: true })
    const finalPath = this.assetPath(asset)
    if (await this.useValidCachedFile(finalPath, asset)) {
      return { path: finalPath, cached: true }
    }

    const errors: string[] = []
    for (const source of buildDownloadSources(asset)) {
      for (let attempt = 0; attempt <= this.config.retries; attempt += 1) {
        const partialPath = `${finalPath}.part-${process.pid}-${Date.now()}-${source.label}-${attempt}`
        try {
          await this.downloadOnce(asset, source, partialPath)
          await rename(partialPath, finalPath)
          return { path: finalPath, cached: false }
        } catch (error) {
          errors.push(`${source.label} 第 ${attempt + 1} 次：${errorMessage(error)}`)
          await rm(partialPath, { force: true }).catch(() => undefined)
          if (attempt < this.config.retries) {
            await delay(1000 * (attempt + 1))
          }
        }
      }
    }
    throw new Error(`下载 GitHub Release 附件失败：${errors.join('；')}`)
  }

  async cleanup(filePath: string): Promise<void> {
    const resolved = resolve(filePath)
    assertPathInside(this.directory, resolved)
    await rm(resolved, { force: true })
  }

  private assetPath(asset: GitHubReleaseAsset): string {
    if (!asset.name || asset.name.includes('/') || asset.name.includes('\\')) {
      throw new Error(`不安全的附件文件名：${asset.name}`)
    }
    const target = resolve(this.directory, `${asset.id}-${asset.name}`)
    assertPathInside(this.directory, target)
    return target
  }

  private async useValidCachedFile(
    filePath: string,
    asset: GitHubReleaseAsset,
  ): Promise<boolean> {
    let metadata
    try {
      metadata = await stat(filePath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
    if (!metadata.isFile()) {
      throw new Error(`下载缓存目标不是普通文件：${filePath}`)
    }

    const digest = await sha256File(filePath)
    const expected = expectedSha256(asset.digest)
    if (metadata.size === asset.size && (!expected || digest === expected)) {
      return true
    }

    const quarantinePath = `${filePath}.invalid-${Date.now()}`
    await rename(filePath, quarantinePath)
    return false
  }

  private async downloadOnce(
    asset: GitHubReleaseAsset,
    source: DownloadSource,
    partialPath: string,
  ): Promise<void> {
    const controller = new AbortController()
    let responseBody: Readable | undefined
    let stallTimer: NodeJS.Timeout | undefined
    const abort = (error: Error) => {
      if (!controller.signal.aborted) controller.abort(error)
      responseBody?.destroy(error)
    }
    const totalTimer = setTimeout(() => {
      abort(new Error(`下载超过 ${this.config.timeoutMinutes} 分钟总时限。`))
    }, this.config.timeoutMinutes * 60_000)

    try {
      const headers: Record<string, string> = {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        'User-Agent': 'koishi-plugin-github-release-group-file/0.1.3',
      }
      if (source.githubAuthorization && this.config.githubToken.trim()) {
        headers.Authorization = `Bearer ${this.config.githubToken.trim()}`
      }

      const response = await this.requester(source.url, {
        headers,
        signal: controller.signal,
        stallTimeoutMilliseconds: DOWNLOAD_STALL_TIMEOUT_MS,
      })
      responseBody = response.body
      if (response.statusCode < 200 || response.statusCode >= 300) {
        responseBody.destroy()
        throw new Error(
          `下载服务器返回 HTTP ${response.statusCode} ${response.statusMessage}`,
        )
      }

      const announcedLength = parseContentLength(response.headers)
      if (announcedLength !== undefined && announcedLength !== asset.size) {
        responseBody.destroy()
        throw new Error(
          `下载响应长度 ${announcedLength} 与 GitHub API 大小 ${asset.size} 不一致`,
        )
      }

      const hash = createHash('sha256')
      let received = 0
      const armStallTimer = () => {
        clearTimeout(stallTimer)
        stallTimer = setTimeout(() => {
          abort(new Error(
            `下载连续 ${DOWNLOAD_STALL_TIMEOUT_MS / 1000} 秒没有收到数据。`,
          ))
        }, DOWNLOAD_STALL_TIMEOUT_MS)
      }
      armStallTimer()

      const meter = new Transform({
        transform(
          chunk: Buffer | Uint8Array | string,
          encoding: BufferEncoding,
          callback: TransformCallback,
        ) {
          armStallTimer()
          const buffer = typeof chunk === 'string'
            ? Buffer.from(chunk, encoding)
            : Buffer.from(chunk)
          received += buffer.length
          if (received > asset.size) {
            callback(new Error('下载内容超过 GitHub API 声明的附件大小。'))
            return
          }
          hash.update(buffer)
          callback(null, buffer)
        },
      })

      await pipeline(
        responseBody,
        meter,
        createWriteStream(partialPath, { flags: 'wx' }),
      )
      if (received !== asset.size) {
        throw new Error(`下载大小不完整：收到 ${received}，预期 ${asset.size}`)
      }
      const actualDigest = hash.digest('hex')
      const expectedDigest = expectedSha256(asset.digest)
      if (expectedDigest && actualDigest !== expectedDigest) {
        throw new Error(
          `SHA-256 校验失败：收到 ${actualDigest}，预期 ${expectedDigest}`,
        )
      }
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason
      }
      throw error
    } finally {
      clearTimeout(totalTimer)
      clearTimeout(stallTimer)
    }
  }
}

export function buildDownloadSources(asset: GitHubReleaseAsset): DownloadSource[] {
  const github: DownloadSource = {
    label: 'github.com',
    url: asset.browser_download_url,
    githubAuthorization: true,
  }
  const release = parseGitHubReleaseAssetUrl(asset)
  if (!release
    || release.owner.toLowerCase() !== AUTO_MAS_OWNER.toLowerCase()
    || release.repository.toLowerCase() !== AUTO_MAS_REPOSITORY.toLowerCase()) {
    return [github]
  }

  const encodedTag = encodeURIComponent(release.tag)
  const encodedName = encodeURIComponent(asset.name)
  return [
    {
      label: 'cnb.cool',
      url: `https://cnb.cool/${AUTO_MAS_OWNER}/${AUTO_MAS_REPOSITORY}/-/releases/download/${encodedTag}/${encodedName}`,
      githubAuthorization: false,
    },
    {
      label: 'download.auto-mas.top',
      url: `https://download.auto-mas.top/d/AUTO-MAS/${encodedName}`,
      githubAuthorization: false,
    },
    github,
  ]
}

export function resolveOwnedDownloadDirectory(
  baseDir: string,
  configuredDirectory: string,
): string {
  const configured = configuredDirectory.trim()
  if (!configured) throw new Error('本地下载目录不能为空。')
  if (isAbsolute(configured)) {
    throw new Error('本地下载目录必须是相对于 Koishi 实例根目录的路径。')
  }
  const base = resolve(baseDir)
  const directory = resolve(base, configured)
  assertPathInside(base, directory)
  return directory
}

export function expectedSha256(digest?: string | null): string | undefined {
  if (!digest) return undefined
  const match = /^sha256:([a-f0-9]{64})$/iu.exec(digest.trim())
  return match?.[1].toLowerCase()
}

async function requestHttpsStream(
  value: string,
  options: DownloadStreamRequest,
  redirectCount = 0,
): Promise<DownloadStreamResponse> {
  const url = parseHttpsUrl(value)
  return new Promise<DownloadStreamResponse>((resolveResponse, rejectResponse) => {
    const request = httpsRequest(url, {
      method: 'GET',
      headers: options.headers,
      signal: options.signal,
    })
    request.setTimeout(options.stallTimeoutMilliseconds, () => {
      request.destroy(new Error(
        `下载连接连续 ${options.stallTimeoutMilliseconds / 1000} 秒没有收到数据。`,
      ))
    })
    request.once('response', (response: IncomingMessage) => {
      const statusCode = response.statusCode ?? 0
      const location = response.headers.location
      if (isRedirect(statusCode) && location) {
        response.resume()
        if (redirectCount >= MAX_REDIRECTS) {
          rejectResponse(new Error(`下载重定向超过 ${MAX_REDIRECTS} 次。`))
          return
        }
        let redirected: URL
        try {
          redirected = parseHttpsUrl(new URL(location, url).href)
        } catch (error) {
          rejectResponse(error)
          return
        }
        const headers = redirectHeaders(options.headers, url, redirected)
        void requestHttpsStream(redirected.href, {
          ...options,
          headers,
        }, redirectCount + 1).then(resolveResponse, rejectResponse)
        return
      }

      response.setTimeout(options.stallTimeoutMilliseconds, () => {
        response.destroy(new Error(
          `下载连续 ${options.stallTimeoutMilliseconds / 1000} 秒没有收到数据。`,
        ))
      })
      resolveResponse({
        body: response,
        headers: response.headers,
        statusCode,
        statusMessage: response.statusMessage ?? '',
        url: url.href,
      })
    })
    request.once('error', rejectResponse)
    request.end()
  })
}

function parseGitHubReleaseAssetUrl(asset: GitHubReleaseAsset): {
  owner: string
  repository: string
  tag: string
} | undefined {
  try {
    const url = new URL(asset.browser_download_url)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (segments.length !== 6
      || segments[2] !== 'releases'
      || segments[3] !== 'download'
      || segments[5] !== asset.name) {
      return undefined
    }
    return {
      owner: segments[0],
      repository: segments[1],
      tag: segments[4],
    }
  } catch {
    return undefined
  }
}

function parseHttpsUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new Error(`下载地址必须使用 HTTPS：${value}`)
  }
  if (url.username || url.password) {
    throw new Error('下载地址不能包含用户名或密码。')
  }
  return url
}

function redirectHeaders(
  original: Record<string, string>,
  from: URL,
  to: URL,
): Record<string, string> {
  const headers = { ...original }
  if (from.origin !== to.origin) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'authorization') delete headers[name]
    }
  }
  return headers
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301
    || statusCode === 302
    || statusCode === 303
    || statusCode === 307
    || statusCode === 308
}

function parseContentLength(headers: IncomingHttpHeaders): number | undefined {
  const value = headers['content-length']
  const normalized = Array.isArray(value) ? value[0] : value
  if (!normalized) return undefined
  const length = Number(normalized)
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

function assertPathInside(parent: string, target: string): void {
  const relation = relative(resolve(parent), resolve(target))
  if (!relation
    || relation === '..'
    || relation.startsWith(`..${sep}`)
    || isAbsolute(relation)) {
    throw new Error('下载路径必须严格位于插件受控目录内。')
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
