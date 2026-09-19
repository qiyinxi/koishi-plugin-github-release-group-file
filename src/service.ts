import type { Bot, Context, Session } from 'koishi'
import type { Config } from './config'
import { deliveryId, monitorId } from './config'
import { ReleaseAssetDownloader } from './downloader'
import {
  compileAssetPattern,
  errorMessage,
  GitHubReleaseClient,
  isEligibleRelease,
  releasesFrom,
  selectMatchingAssets,
  type GitHubRelease,
  type GitHubReleaseAsset,
} from './github'
import {
  findBoundBot,
  findSameNameFiles,
  isOneBotReady,
  isOneBotUnavailableError,
  requireOneBotInternal,
  requireOwner,
  resolveExactRootFolder,
  targetGroupFromSession,
  type OneBotInternal,
} from './onebot'

const LOGGER_NAME = 'github-release-group-file'

export interface BindingRow {
  id: string
  platform: string
  selfId: string
  groupId: string
  folderId: string
  folderName: string
  confirmedBy: string
  createdAt: Date
  updatedAt: Date
}

export interface MonitorStateRow {
  id: string
  startReleaseId: string
  startTag: string
  startPublishedAt: Date
  initializedAt: Date
  updatedAt: Date
}

export type DeliveryStatus = 'downloading' | 'uploading' | 'failed' | 'delivered'

export interface DeliveryRow {
  id: string
  monitorId: string
  releaseId: string
  releaseTag: string
  releaseUrl: string
  assetId: string
  assetName: string
  assetUrl: string
  assetSize: number
  assetDigest: string
  status: DeliveryStatus
  result: string
  attemptCount: number
  lastError: string
  firstSeenAt: Date
  updatedAt: Date
  deliveredAt: Date | null
}

export interface PollSummary {
  releases: number
  matchedAssets: number
  uploaded: number
  alreadyPresent: number
  failed: number
  skipped: number
  reason?: string
}

declare module 'koishi' {
  interface Tables {
    gh_release_file_binding: BindingRow
    gh_release_file_state: MonitorStateRow
    gh_release_file_delivery: DeliveryRow
  }
}

export class GitHubReleaseGroupFileService {
  private readonly id: string
  private readonly assetPattern: RegExp
  private readonly github: GitHubReleaseClient
  private readonly downloader: ReleaseAssetDownloader
  private polling: Promise<PollSummary> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    this.id = monitorId(config)
    this.assetPattern = compileAssetPattern(config.assetPattern)
    this.github = new GitHubReleaseClient(ctx, {
      owner: config.repositoryOwner,
      repository: config.repositoryName,
      token: config.githubToken,
      timeout: config.requestTimeout,
      retries: config.requestRetries,
    })
    this.downloader = new ReleaseAssetDownloader({
      baseDir: ctx.baseDir,
      directory: config.downloadDirectory,
      timeoutMinutes: config.downloadTimeoutMinutes,
      retries: config.downloadRetries,
      githubToken: config.githubToken,
    })
  }

  async bind(session: Session): Promise<string> {
    requireOwner(session, this.config.ownerUserId)
    const groupId = this.requireTargetGroup(session)
    if (session.platform !== 'onebot') {
      throw new Error(`当前平台是 ${session.platform || 'unknown'}，只支持 OneBot QQ 群。`)
    }
    if (!session.selfId) throw new Error('当前会话缺少机器人 selfId。')

    const internal = requireOneBotInternal(session.bot)
    const rootFiles = await internal.getGroupRootFiles(groupId)
    const folder = resolveExactRootFolder(rootFiles, this.config.targetFolderName)
    const [existing] = await this.ctx.database.get('gh_release_file_binding', { id: this.id })
    const now = new Date()

    await this.ctx.database.upsert('gh_release_file_binding', [{
      id: this.id,
      platform: session.platform,
      selfId: session.selfId,
      groupId,
      folderId: folder.folder_id,
      folderName: folder.folder_name,
      confirmedBy: session.userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }])

    this.ctx.setTimeout(() => {
      this.runInBackground('绑定后首次检查')
    }, 500)

    return [
      'GitHub Release 群文件上传目标已确认。',
      `仓库：${this.config.repositoryOwner}/${this.config.repositoryName}`,
      `目标群：${groupId}`,
      `文件夹：${folder.folder_name}`,
      `folder_id：${folder.folder_id}`,
      `本地下载目录：${this.downloader.directory}`,
      `附件规则：${this.config.assetPattern}`,
      '已安排后台检查；可稍后用 github-release-group-file.status 查看结果。',
    ].join('\n')
  }

  async unbind(session: Session): Promise<string> {
    requireOwner(session, this.config.ownerUserId)
    this.requireTargetGroup(session)
    const [existing] = await this.ctx.database.get('gh_release_file_binding', { id: this.id })
    if (!existing) return '当前群尚未绑定 GitHub Release 文件上传目标。'
    await this.ctx.database.remove('gh_release_file_binding', { id: this.id })
    return '已解除当前群与 QQ 群文件夹的绑定；历史去重记录和本地下载缓存已保留。'
  }

  async status(session: Session): Promise<string> {
    requireOwner(session, this.config.ownerUserId)
    this.requireTargetGroup(session)
    const [[binding], [state], deliveries] = await Promise.all([
      this.ctx.database.get('gh_release_file_binding', { id: this.id }),
      this.ctx.database.get('gh_release_file_state', { id: this.id }),
      this.ctx.database.get('gh_release_file_delivery', { monitorId: this.id }),
    ])
    const latest = [...deliveries]
      .filter((delivery) => {
        this.assetPattern.lastIndex = 0
        return this.assetPattern.test(delivery.assetName)
      })
      .sort((left, right) => (
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      ))
      .slice(0, 5)

    const lines = [
      'GitHub Release 群文件上传状态',
      `启用：${this.config.enabled ? '是' : '否'}`,
      `仓库：${this.config.repositoryOwner}/${this.config.repositoryName}`,
      `起始标签：${this.config.startTag || '首次启动时的最新 Release'}`,
      `附件规则：${this.config.assetPattern}`,
      `目标群：${this.config.targetGroupId}`,
      `目标文件夹：${this.config.targetFolderName}`,
      `本地下载目录：${this.downloader.directory}`,
      binding
        ? `绑定：${binding.platform}/${binding.selfId} → ${binding.folderName} (${binding.folderId})`
        : '绑定：尚未在目标群确认',
      state
        ? `监控起点：${state.startTag} · ${formatDate(state.startPublishedAt)}`
        : '监控起点：尚未初始化',
      `后台检查：${this.polling ? '正在运行' : '空闲'}`,
    ]
    if (latest.length) {
      lines.push('最近附件：')
      for (const delivery of latest) {
        const detail = delivery.status === 'delivered'
          ? delivery.result
          : delivery.lastError || delivery.status
        lines.push(`- ${delivery.releaseTag} / ${delivery.assetName}：${detail}`)
      }
    }
    return lines.join('\n')
  }

  manualCheck(session: Session): string {
    requireOwner(session, this.config.ownerUserId)
    this.requireTargetGroup(session)
    const alreadyRunning = Boolean(this.polling)
    this.runInBackground('主人手动检查')
    return alreadyRunning
      ? '后台检查已经在运行；没有启动重复任务。'
      : '已启动后台检查。本地下载和群文件上传可能需要几分钟，请稍后查看状态。'
  }

  runInBackground(reason: string): void {
    void this.pollAndDeliver()
      .then((summary) => {
        this.ctx.logger(LOGGER_NAME).info(
          '%s完成：Release %d，匹配 %d，上传 %d，已存在 %d，失败 %d，跳过 %d%s',
          reason,
          summary.releases,
          summary.matchedAssets,
          summary.uploaded,
          summary.alreadyPresent,
          summary.failed,
          summary.skipped,
          summary.reason ? `（${summary.reason}）` : '',
        )
      })
      .catch((error) => {
        this.ctx.logger(LOGGER_NAME).warn('%s失败：%s', reason, errorMessage(error))
      })
  }

  async pollAndDeliver(): Promise<PollSummary> {
    if (!this.polling) {
      this.polling = this.performPoll().finally(() => {
        this.polling = undefined
      })
    }
    return this.polling
  }

  private async performPoll(): Promise<PollSummary> {
    if (!this.config.enabled) return emptySummary('插件已在后台关闭')
    const [binding] = await this.ctx.database.get('gh_release_file_binding', { id: this.id })
    if (!binding) return emptySummary('尚未由部署主人在目标群确认文件夹绑定')
    this.validateStoredBinding(binding)

    let boundBot: ReturnType<typeof findBoundBot>
    try {
      boundBot = findBoundBot(
        this.ctx,
        binding.platform,
        binding.selfId,
      )
    } catch (error) {
      if (isOneBotUnavailableError(error)) {
        return emptySummary(`${errorMessage(error)} 等待上线后自动重试`)
      }
      throw error
    }
    const { bot, internal } = boundBot
    try {
      await this.assertFolderStillBound(internal, binding)
    } catch (error) {
      if (isOneBotUnavailableError(error) || !isOneBotReady(bot)) {
        return emptySummary('OneBot/NapCat 连接已断开，等待上线后自动重试')
      }
      throw error
    }

    const { state, bootstrapRelease } = await this.ensureState()
    const recent = await this.github.listRecent(30)
    if (bootstrapRelease && !recent.some((release) => release.id === bootstrapRelease.id)) {
      recent.push(bootstrapRelease)
    }
    if (!recent.some((release) => String(release.id) === state.startReleaseId)) {
      const startRelease = await this.github.getByTag(state.startTag)
      if (!recent.some((release) => release.id === startRelease.id)) {
        recent.push(startRelease)
      }
    }

    const candidates = releasesFrom(
      recent,
      new Date(state.startPublishedAt),
      this.config.includePrereleases,
    )
    const summary: PollSummary = {
      releases: candidates.length,
      matchedAssets: 0,
      uploaded: 0,
      alreadyPresent: 0,
      failed: 0,
      skipped: 0,
    }

    for (const release of candidates) {
      const assets = selectMatchingAssets(
        release,
        this.assetPattern,
        this.config.repositoryOwner,
        this.config.repositoryName,
      )
      summary.matchedAssets += assets.length
      for (const asset of assets) {
        const result = await this.deliverAsset(bot, internal, binding, release, asset)
        if (result === 'uploaded') summary.uploaded += 1
        if (result === 'present') summary.alreadyPresent += 1
        if (result === 'failed') summary.failed += 1
        if (result === 'skipped') summary.skipped += 1
      }
    }
    return summary
  }

  private async ensureState(): Promise<{
    state: MonitorStateRow
    bootstrapRelease?: GitHubRelease
  }> {
    const [existing] = await this.ctx.database.get('gh_release_file_state', { id: this.id })
    if (existing) return { state: existing }

    let release: GitHubRelease | undefined
    if (this.config.startTag.trim()) {
      release = await this.github.getByTag(this.config.startTag)
    } else {
      release = (await this.github.listRecent(30))
        .find((candidate) => isEligibleRelease(candidate, this.config.includePrereleases))
    }
    if (!release) throw new Error('GitHub 没有返回可作为监控起点的已发布 Release。')
    if (!isEligibleRelease(release, this.config.includePrereleases)) {
      throw new Error(`起始 Release ${release.tag_name} 是草稿或被预发布过滤规则排除。`)
    }
    if (!release.published_at || !Number.isFinite(Date.parse(release.published_at))) {
      throw new Error(`起始 Release ${release.tag_name} 缺少有效发布时间。`)
    }

    const now = new Date()
    const state: MonitorStateRow = {
      id: this.id,
      startReleaseId: String(release.id),
      startTag: release.tag_name,
      startPublishedAt: new Date(release.published_at),
      initializedAt: now,
      updatedAt: now,
    }
    await this.ctx.database.upsert('gh_release_file_state', [state])
    return { state, bootstrapRelease: release }
  }

  private async deliverAsset(
    bot: Bot,
    internal: OneBotInternal,
    binding: BindingRow,
    release: GitHubRelease,
    asset: GitHubReleaseAsset,
  ): Promise<'uploaded' | 'present' | 'failed' | 'skipped'> {
    const id = deliveryId(this.id, String(asset.id))
    const [existing] = await this.ctx.database.get('gh_release_file_delivery', { id })
    if (existing?.status === 'delivered') return 'skipped'

    const now = new Date()
    const delivery: DeliveryRow = {
      id,
      monitorId: this.id,
      releaseId: String(release.id),
      releaseTag: release.tag_name,
      releaseUrl: release.html_url,
      assetId: String(asset.id),
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
      assetSize: asset.size,
      assetDigest: asset.digest ?? '',
      status: existing?.status ?? 'downloading',
      result: existing?.result ?? '',
      attemptCount: existing?.attemptCount ?? 0,
      lastError: existing?.lastError ?? '',
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
      deliveredAt: null,
    }
    let localFile: string | undefined

    try {
      const existingFiles = findSameNameFiles(
        await internal.getGroupFilesByFolder(binding.groupId, binding.folderId),
        asset.name,
      )
      if (existingFiles.some((file) => Number(file.file_size) === asset.size)) {
        await this.ctx.database.upsert('gh_release_file_delivery', [delivery])
        await this.markDelivered(delivery, '群文件夹中已存在同名同大小文件')
        return 'present'
      }
      if (this.isRetryDeferred(existing)) return 'skipped'
      if (existingFiles.length) {
        throw new Error(
          `群文件夹中已有同名但大小不同的文件；默认不覆盖：${asset.name}`,
        )
      }

      const maxBytes = this.config.maxAssetSizeMiB * 1024 * 1024
      if (asset.size > maxBytes) {
        throw new Error(
          `附件大小 ${formatBytes(asset.size)} 超过后台上限 ${this.config.maxAssetSizeMiB} MiB`,
        )
      }

      delivery.status = 'downloading'
      delivery.attemptCount += 1
      delivery.lastError = ''
      delivery.updatedAt = new Date()
      await this.ctx.database.upsert('gh_release_file_delivery', [delivery])

      const downloaded = await this.downloader.obtain(asset)
      localFile = downloaded.path
      await this.ctx.database.set('gh_release_file_delivery', { id }, {
        status: 'uploading',
        result: downloaded.cached ? '复用已校验的本地缓存' : '本地下载与校验完成',
        updatedAt: new Date(),
      })
      await internal.uploadGroupFile(
        binding.groupId,
        localFile,
        asset.name,
        binding.folderId,
      )
      await this.markDelivered(delivery, '上传成功')
      await this.cleanupDownloadedFile(localFile)
      await this.notifySuccess(bot, release, asset)
      return 'uploaded'
    } catch (error) {
      const recovered = await this.confirmPresentAfterError(internal, binding, asset)
      if (recovered) {
        await this.ctx.database.upsert('gh_release_file_delivery', [delivery])
        await this.markDelivered(delivery, '上传调用报错，但群文件夹已确认存在同名同大小文件')
        if (localFile) await this.cleanupDownloadedFile(localFile)
        return 'present'
      }
      if (this.isRetryDeferred(existing)) return 'skipped'

      const message = truncate(errorMessage(error), 4000)
      delivery.status = 'failed'
      delivery.attemptCount = Math.max(
        delivery.attemptCount,
        (existing?.attemptCount ?? 0) + 1,
      )
      delivery.lastError = message
      delivery.updatedAt = new Date()
      await this.ctx.database.upsert('gh_release_file_delivery', [delivery])
      this.ctx.logger(LOGGER_NAME).warn(
        '附件 %s (%s) 处理失败：%s',
        asset.name,
        release.tag_name,
        message,
      )
      return 'failed'
    }
  }

  private isRetryDeferred(existing?: DeliveryRow): boolean {
    if (existing?.status !== 'failed') return false
    const failedAt = new Date(existing.updatedAt).getTime()
    return Number.isFinite(failedAt)
      && Date.now() - failedAt < this.config.failureRetryMinutes * 60_000
  }

  private async confirmPresentAfterError(
    internal: OneBotInternal,
    binding: BindingRow,
    asset: GitHubReleaseAsset,
  ): Promise<boolean> {
    try {
      const files = findSameNameFiles(
        await internal.getGroupFilesByFolder(binding.groupId, binding.folderId),
        asset.name,
      )
      return files.some((file) => Number(file.file_size) === asset.size)
    } catch {
      return false
    }
  }

  private async markDelivered(delivery: DeliveryRow, result: string): Promise<void> {
    const now = new Date()
    await this.ctx.database.set('gh_release_file_delivery', { id: delivery.id }, {
      status: 'delivered',
      result,
      lastError: '',
      deliveredAt: now,
      updatedAt: now,
    })
  }

  private async cleanupDownloadedFile(filePath: string): Promise<void> {
    if (this.config.keepDownloadedFiles) return
    try {
      await this.downloader.cleanup(filePath)
    } catch (error) {
      this.ctx.logger(LOGGER_NAME).warn(
        '群文件已送达，但本地下载缓存清理失败：%s',
        errorMessage(error),
      )
    }
  }

  private async notifySuccess(
    bot: Bot,
    release: GitHubRelease,
    asset: GitHubReleaseAsset,
  ): Promise<void> {
    if (!this.config.notifyOnSuccess) return
    try {
      await bot.sendMessage(this.config.targetGroupId, [
        'AUTO-MAS 新版本文件已上传',
        `版本：${release.tag_name}`,
        `文件：${asset.name}`,
        `大小：${formatBytes(asset.size)}`,
        `Release：${release.html_url}`,
      ].join('\n'))
    } catch (error) {
      this.ctx.logger(LOGGER_NAME).warn(
        '文件已上传，但成功通知发送失败：%s',
        errorMessage(error),
      )
    }
  }

  private requireTargetGroup(session: Session): string {
    if (!this.config.targetGroupId.trim()) {
      throw new Error('后台尚未配置目标 QQ 群号。')
    }
    const currentGroup = targetGroupFromSession(session)
    if (currentGroup !== this.config.targetGroupId.trim()) {
      throw new Error(
        `该操作只能在后台配置的目标群 ${this.config.targetGroupId} 中执行。`,
      )
    }
    return currentGroup
  }

  private validateStoredBinding(binding: BindingRow): void {
    if (binding.groupId !== this.config.targetGroupId
      || binding.folderName !== this.config.targetFolderName) {
      throw new Error('后台目标群或文件夹名称已经变化，请在目标群重新执行绑定命令。')
    }
  }

  private async assertFolderStillBound(
    internal: OneBotInternal,
    binding: BindingRow,
  ): Promise<void> {
    const current = resolveExactRootFolder(
      await internal.getGroupRootFiles(binding.groupId),
      binding.folderName,
    )
    if (current.folder_id !== binding.folderId) {
      throw new Error(
        `文件夹“${binding.folderName}”的 folder_id 已变化，请由部署主人重新绑定。`,
      )
    }
  }
}

function emptySummary(reason: string): PollSummary {
  return {
    releases: 0,
    matchedAssets: 0,
    uploaded: 0,
    alreadyPresent: 0,
    failed: 0,
    skipped: 0,
    reason,
  }
}

function formatDate(value: Date): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = index === 0 ? 0 : 2
  return `${value.toFixed(digits)} ${units[index]}`
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}
