import { createHash } from 'node:crypto'

export interface Config {
  enabled: boolean
  repositoryOwner: string
  repositoryName: string
  startTag: string
  includePrereleases: boolean
  assetPattern: string
  targetGroupId: string
  targetFolderName: string
  ownerUserId: string
  pollIntervalMinutes: number
  checkOnStart: boolean
  requestTimeout: number
  requestRetries: number
  downloadDirectory: string
  downloadTimeoutMinutes: number
  downloadRetries: number
  keepDownloadedFiles: boolean
  failureRetryMinutes: number
  maxAssetSizeMiB: number
  notifyOnSuccess: boolean
  commandAuthority: number
  githubToken: string
}

export function monitorId(config: Pick<
  Config,
  | 'repositoryOwner'
  | 'repositoryName'
  | 'targetGroupId'
  | 'targetFolderName'
>): string {
  return createHash('sha256')
    .update(JSON.stringify([
      config.repositoryOwner.toLowerCase(),
      config.repositoryName.toLowerCase(),
      config.targetGroupId,
      config.targetFolderName,
    ]))
    .digest('hex')
}

export function deliveryId(monitor: string, assetId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([monitor, assetId]))
    .digest('hex')
}
