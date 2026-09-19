'use strict'

const {
  compileAssetPattern,
  selectMatchingAssets,
} = require('../lib/github')

const owner = 'AUTO-MAS-Project'
const repository = 'AUTO-MAS'
const tag = 'v5.4.0-beta.2'
const expectedName = 'AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip'
const expectedSize = 105638256
const expectedDigest = 'sha256:d378d6644075c923edfc0b3c742c7e6b9f9d1f9ebd7493224386b4785977f625'

async function main() {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'koishi-plugin-github-release-group-file-live-smoke/0.1.3',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} ${response.statusText}`)
  }
  const release = await response.json()
  const selected = selectMatchingAssets(
    release,
    compileAssetPattern('^AUTO-MAS-Lite-Setup-v.+-x64\\.zip$'),
    owner,
    repository,
  )
  if (selected.length !== 1) {
    throw new Error(`Expected exactly one matching asset, received ${selected.length}`)
  }
  const [asset] = selected
  if (asset.name !== expectedName) {
    throw new Error(`Unexpected asset: ${asset.name}`)
  }
  if (asset.size !== expectedSize) {
    throw new Error(`Unexpected size: ${asset.size}`)
  }
  if (asset.digest !== expectedDigest) {
    throw new Error(`Unexpected digest: ${asset.digest}`)
  }
  process.stdout.write(`${JSON.stringify({
    releaseId: release.id,
    tag: release.tag_name,
    prerelease: release.prerelease,
    assetId: asset.id,
    name: asset.name,
    size: asset.size,
    digest: asset.digest,
    url: asset.browser_download_url,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
