import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDownloadSources,
  ReleaseAssetDownloader,
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

describe('AUTO-MAS download source priority', () => {
  it('uses CNB, AUTO-MAS mirror, then GitHub', () => {
    const sources = buildDownloadSources(asset(Buffer.from('fixture')))

    expect(sources.map((source) => source.url)).toEqual([
      'https://cnb.cool/AUTO-MAS-Project/AUTO-MAS/-/releases/download/v5.4.0-beta.2/AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
      'https://download.auto-mas.top/d/AUTO-MAS/AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
      'https://github.com/AUTO-MAS-Project/AUTO-MAS/releases/download/v5.4.0-beta.2/AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip',
    ])
    expect(sources.map((source) => source.githubAuthorization))
      .toEqual([false, false, true])
  })
})

describe('native readable streaming and fallback', () => {
  it('rejects a bad mirror digest and accepts the next source', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'koishi-native-download-'))
    cleanupDirectories.push(baseDir)
    const expected = Buffer.from('expected payload')
    const wrong = Buffer.from('unexpected bytes')
    expect(wrong.length).toBe(expected.length)
    const calls: string[] = []
    const requester: StreamRequester = async (url) => {
      calls.push(url)
      return response(calls.length === 1 ? wrong : expected)
    }
    const downloader = new ReleaseAssetDownloader({
      baseDir,
      directory: 'data/github-release-group-file',
      timeoutMinutes: 1,
      retries: 0,
      githubToken: '',
    }, requester)

    const downloaded = await downloader.obtain(asset(expected))

    expect(await readFile(downloaded.path)).toEqual(expected)
    expect(calls).toEqual(buildDownloadSources(asset(expected))
      .slice(0, 2)
      .map((source) => source.url))
  })
})
