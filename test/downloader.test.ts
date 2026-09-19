import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ReleaseAssetDownloader,
  resolveOwnedDownloadDirectory,
  type DownloadStreamResponse,
  type StreamRequester,
} from '../src/downloader'
import type { GitHubReleaseAsset } from '../src/github'

const cleanupDirectories: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function asset(content: Buffer): GitHubReleaseAsset {
  return {
    id: 493648467,
    name: 'AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
    state: 'uploaded',
    content_type: 'application/zip',
    size: content.length,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    browser_download_url: 'https://github.com/AUTO-MAS-Project/AUTO-MAS/releases/download/v5.4.0-beta.2/AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
    created_at: '2026-07-29T05:38:00Z',
    updated_at: '2026-07-29T05:38:00Z',
  }
}

function response(content: Buffer): DownloadStreamResponse {
  const split = Math.max(1, Math.floor(content.length / 2))
  return {
    body: Readable.from([
      content.subarray(0, split),
      content.subarray(split),
    ]),
    headers: { 'content-length': String(content.length) },
    statusCode: 200,
    statusMessage: 'OK',
    url: 'https://fixture.invalid/file.zip',
  }
}

describe('streaming release download', () => {
  it('writes a verified file and reuses the valid cache', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'koishi-release-download-'))
    cleanupDirectories.push(baseDir)
    const content = Buffer.from('verified AUTO-MAS fixture')
    let calls = 0
    const requester: StreamRequester = async () => {
      calls += 1
      return response(content)
    }
    const downloader = new ReleaseAssetDownloader({
      baseDir,
      directory: 'data/github-release-group-file',
      timeoutMinutes: 1,
      retries: 0,
      githubToken: '',
    }, requester)

    const first = await downloader.obtain(asset(content))
    const second = await downloader.obtain(asset(content))

    expect(first.cached).toBe(false)
    expect(second).toEqual({ path: first.path, cached: true })
    expect(await readFile(first.path)).toEqual(content)
    expect(calls).toBe(1)
  })

  it('rejects a digest mismatch after all sources fail validation', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'koishi-release-download-'))
    cleanupDirectories.push(baseDir)
    const expected = Buffer.from('expected')
    const received = Buffer.from('received')
    const requester: StreamRequester = async () => response(received)
    const downloader = new ReleaseAssetDownloader({
      baseDir,
      directory: 'data/github-release-group-file',
      timeoutMinutes: 1,
      retries: 0,
      githubToken: '',
    }, requester)
    const target = asset(expected)
    target.size = received.length

    await expect(downloader.obtain(target)).rejects.toThrow('SHA-256 校验失败')
  })
})

describe('download directory containment', () => {
  it('accepts a child directory and rejects traversal or absolute paths', () => {
    expect(resolveOwnedDownloadDirectory(
      'C:\\koishi',
      'data/github-release-group-file',
    )).toMatch(/github-release-group-file$/u)
    expect(() => resolveOwnedDownloadDirectory('C:\\koishi', '..\\outside'))
      .toThrow('严格位于')
    expect(() => resolveOwnedDownloadDirectory('C:\\koishi', 'C:\\outside'))
      .toThrow('相对于')
  })
})
