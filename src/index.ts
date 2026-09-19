import { Context, Schema } from 'koishi'
import '@koishijs/plugin-http'
import type { Config as PluginConfig } from './config'
import { errorMessage } from './github'
import { isOneBotReady } from './onebot'
import {
  GitHubReleaseGroupFileService,
  type BindingRow,
  type DeliveryRow,
  type MonitorStateRow,
} from './service'

export const name = 'github-release-group-file'
export const inject = { required: ['database', 'http'] }

export type Config = PluginConfig

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description('启用自动检查与上传。关闭后保留绑定、缓存和去重记录。'),
    repositoryOwner: Schema.string()
      .default('AUTO-MAS-Project')
      .description('GitHub 仓库所有者。'),
    repositoryName: Schema.string()
      .default('AUTO-MAS')
      .description('GitHub 仓库名称。'),
    startTag: Schema.string()
      .default('v5.4.0-beta.2')
      .description('首次绑定后的监控起点；会处理此标签并继续处理后续 Release。留空则从当时最新版本开始。'),
    includePrereleases: Schema.boolean()
      .default(true)
      .description('包含预发布版本。AUTO-MAS beta 版本需要开启。'),
    assetPattern: Schema.string()
      .default('^AUTO-MAS-Lite-Setup-v.+-x64\\.zip$')
      .description('完整匹配附件文件名的正则。默认只上传 Lite Setup x64 ZIP，其他 Full/Lite 便携包和源码包均忽略。'),
    githubToken: Schema.string()
      .role('secret')
      .default('')
      .description('可选。公开仓库无需填写；如需令牌，只在 Koishi 后台直接输入，不要写进配置文件或提交到仓库。'),
  }).description('GitHub Release 与附件筛选'),
  Schema.object({
    targetGroupId: Schema.string()
      .default('')
      .description('允许绑定和接收文件的 QQ 群号。必填；仍需部署主人在该群执行绑定命令。'),
    targetFolderName: Schema.string()
      .default('AUTO-MAS软件分发')
      .description('目标群根目录下的文件夹精确名称。绑定时会解析真实 folder_id。'),
    ownerUserId: Schema.string()
      .default('')
      .description('唯一允许绑定、解绑和手动检查的部署主人 QQ 号。必填。'),
    commandAuthority: Schema.number()
      .min(0)
      .max(5)
      .step(1)
      .default(4)
      .description('管理命令的 Koishi 权限门槛；同时仍会精确核对 ownerUserId。'),
    notifyOnSuccess: Schema.boolean()
      .default(true)
      .description('群文件上传成功后，在目标群发送一条版本通知。'),
  }).description('QQ 群目标与主人确认'),
  Schema.object({
    pollIntervalMinutes: Schema.number()
      .min(1)
      .max(1440)
      .step(1)
      .default(5)
      .description('检查 GitHub Release 的间隔（分钟）。公开 API 默认额度下建议不少于 2 分钟。'),
    checkOnStart: Schema.boolean()
      .default(true)
      .description('Koishi 启动后等待 OneBot/NapCat 上线再安排一次检查；未绑定时不会访问 GitHub 或下载文件。'),
    requestTimeout: Schema.number()
      .min(1000)
      .max(120000)
      .step(1000)
      .default(20000)
      .description('GitHub API JSON 请求的单次超时（毫秒），不用于大文件下载。'),
    requestRetries: Schema.number()
      .min(0)
      .max(5)
      .step(1)
      .default(2)
      .description('GitHub API JSON 请求失败后的重试次数。'),
    downloadDirectory: Schema.string()
      .default('data/github-release-group-file')
      .description('相对于 Koishi 实例根目录的本地下载目录。插件会把绝对文件路径交给 NapCat。禁止绝对路径和 .. 跳出实例目录。'),
    downloadTimeoutMinutes: Schema.number()
      .min(1)
      .max(240)
      .step(1)
      .default(30)
      .description('插件自身流式下载单个附件的最长时间（分钟），不修改 OneBot 的 60 秒响应超时。'),
    downloadRetries: Schema.number()
      .min(0)
      .max(3)
      .step(1)
      .default(1)
      .description('每个下载源失败后的同源重试次数。依次尝试 CNB、AUTO-MAS 镜像和 GitHub。'),
    keepDownloadedFiles: Schema.boolean()
      .default(false)
      .description('上传成功后是否保留已校验的本地文件。上传失败时始终保留，供下一轮复用。'),
    failureRetryMinutes: Schema.number()
      .min(1)
      .max(1440)
      .step(1)
      .default(15)
      .description('失败后的最短重试间隔。OneBot 上传超时后会先回查文件夹，并等待此时间再决定是否重传。'),
    maxAssetSizeMiB: Schema.number()
      .min(1)
      .max(4096)
      .step(1)
      .default(512)
      .description('允许下载和上传的单个附件大小上限（MiB）。'),
  }).description('轮询、本地下载、缓存与重试'),
])

export function apply(ctx: Context, config: Config): void {
  defineModels(ctx)
  const service = new GitHubReleaseGroupFileService(ctx, config)

  ctx.command(
    'github-release-group-file.bind',
    '在当前目标群确认 GitHub Release 上传文件夹',
    { authority: config.commandAuthority },
  )
    .alias('发行文件绑定')
    .action(({ session }) => safeResult(service.bind(session!)))

  ctx.command(
    'github-release-group-file.unbind',
    '解除当前目标群的 GitHub Release 文件夹绑定',
    { authority: config.commandAuthority },
  )
    .alias('发行文件解绑')
    .action(({ session }) => safeResult(service.unbind(session!)))

  ctx.command(
    'github-release-group-file.status',
    '查看 GitHub Release 群文件上传状态',
    { authority: config.commandAuthority },
  )
    .alias('发行文件状态')
    .action(({ session }) => safeResult(service.status(session!)))

  ctx.command(
    'github-release-group-file.check',
    '立即启动一次 GitHub Release 后台检查',
    { authority: config.commandAuthority },
  )
    .alias('发行文件检查')
    .action(({ session }) => {
      try {
        return service.manualCheck(session!)
      } catch (error) {
        return `操作失败：${errorMessage(error)}`
      }
    })

  ctx.command('github-release-group-file.help', '显示 GitHub Release 群文件插件帮助')
    .alias('发行文件帮助')
    .action(() => [
      'GitHub Release 群文件上传',
      '发行文件绑定 — 主人在目标群确认群号与文件夹 folder_id',
      '发行文件状态 — 查看监控起点、本地目录和最近附件结果',
      '发行文件检查 — 立即启动后台检查',
      '发行文件解绑 — 停止向当前群文件夹上传',
      `当前只匹配：${config.assetPattern}`,
      '下载顺序：CNB → download.auto-mas.top → GitHub。',
      '大文件由插件流式下载到本地，校验后只把绝对路径交给 NapCat 上传。',
      '默认不会删除或覆盖群内文件；同名异大小时会停止并报错。',
    ].join('\n'))

  ctx.setInterval(() => {
    service.runInBackground('定时检查')
  }, config.pollIntervalMinutes * 60_000)

  let appReady = false
  let initialCheckScheduled = false

  const scheduleReadyCheck = (reason: string): void => {
    if (!config.checkOnStart || !appReady) return
    initialCheckScheduled = true
    service.runInBackground(reason)
  }

  ctx.on('ready', () => {
    appReady = true
    if (ctx.bots.some(isOneBotReady)) {
      scheduleReadyCheck('启动检查')
    }
  })

  ctx.on('bot-status-updated', (bot) => {
    if (!isOneBotReady(bot)) return
    scheduleReadyCheck(
      initialCheckScheduled ? 'OneBot 恢复检查' : '启动检查',
    )
  })
}

function defineModels(ctx: Context): void {
  ctx.model.extend('gh_release_file_binding', {
    id: { type: 'string', length: 64 },
    platform: { type: 'string', length: 64 },
    selfId: { type: 'string', length: 128 },
    groupId: { type: 'string', length: 128 },
    folderId: { type: 'string', length: 512 },
    folderName: { type: 'string', length: 512 },
    confirmedBy: { type: 'string', length: 128 },
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, { primary: 'id' })

  ctx.model.extend('gh_release_file_state', {
    id: { type: 'string', length: 64 },
    startReleaseId: { type: 'string', length: 128 },
    startTag: { type: 'string', length: 512 },
    startPublishedAt: 'timestamp',
    initializedAt: 'timestamp',
    updatedAt: 'timestamp',
  }, { primary: 'id' })

  ctx.model.extend('gh_release_file_delivery', {
    id: { type: 'string', length: 64 },
    monitorId: { type: 'string', length: 64 },
    releaseId: { type: 'string', length: 128 },
    releaseTag: { type: 'string', length: 512 },
    releaseUrl: 'text',
    assetId: { type: 'string', length: 128 },
    assetName: { type: 'string', length: 512 },
    assetUrl: 'text',
    assetSize: 'integer',
    assetDigest: { type: 'string', length: 256 },
    status: { type: 'string', length: 32 },
    result: 'text',
    attemptCount: 'integer',
    lastError: 'text',
    firstSeenAt: 'timestamp',
    updatedAt: 'timestamp',
    deliveredAt: { type: 'timestamp', nullable: true },
  }, { primary: 'id', unique: [['monitorId', 'assetId']] })
}

async function safeResult(promise: Promise<string>): Promise<string> {
  try {
    return await promise
  } catch (error) {
    return `操作失败：${errorMessage(error)}`
  }
}

export type {
  BindingRow,
  DeliveryRow,
  MonitorStateRow,
}
