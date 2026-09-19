import type { Bot, Context, Session } from 'koishi'

// Satori Universal.Status.ONLINE is 1 in the supported Koishi 4 runtime.
const ONLINE_STATUS: Bot['status'] = 1

export interface OneBotGroupFile {
  file_id: string
  file_name: string
  busid: number
  file_size: number
}

export interface OneBotGroupFolder {
  folder_id: string
  folder_name: string
}

export interface OneBotGroupFileList {
  files: OneBotGroupFile[]
  folders: OneBotGroupFolder[]
}

export interface OneBotInternal {
  _request?: (
    action: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>
  getGroupRootFiles(groupId: string): Promise<OneBotGroupFileList>
  getGroupFilesByFolder(groupId: string, folderId: string): Promise<OneBotGroupFileList>
  uploadGroupFile(
    groupId: string,
    file: string,
    name: string,
    folder?: string,
  ): Promise<void>
}

export interface BoundBot {
  bot: Bot
  internal: OneBotInternal
}

export class OneBotUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OneBotUnavailableError'
  }
}

export function targetGroupFromSession(session: Session): string {
  if (!session.guildId) {
    throw new Error('该操作只能在目标 QQ 群中执行。')
  }
  if (!session.channelId) {
    throw new Error('当前群会话缺少 channelId，无法确认目标群。')
  }
  return session.channelId
}

export function requireOwner(session: Session, ownerUserId: string): void {
  if (!ownerUserId.trim()) throw new Error('后台尚未配置部署主人 QQ 号。')
  if (session.userId !== ownerUserId.trim()) {
    throw new Error('只有后台配置的部署主人可以执行该操作。')
  }
}

export function resolveExactRootFolder(
  response: OneBotGroupFileList,
  folderName: string,
): OneBotGroupFolder {
  const matches = normalizeFolders(response).filter((folder) => (
    folder.folder_name === folderName
  ))
  if (!matches.length) {
    throw new Error(`目标群根目录中没有找到文件夹“${folderName}”。`)
  }
  if (matches.length > 1) {
    throw new Error(`目标群根目录中存在多个同名文件夹“${folderName}”，拒绝自动选择。`)
  }
  if (!matches[0].folder_id) {
    throw new Error(`文件夹“${folderName}”没有有效的 OneBot folder_id。`)
  }
  return matches[0]
}

export function findSameNameFiles(
  response: OneBotGroupFileList,
  fileName: string,
): OneBotGroupFile[] {
  return normalizeFiles(response).filter((file) => file.file_name === fileName)
}

export function findBoundBot(
  ctx: Context,
  platform: string,
  selfId: string,
): BoundBot {
  const bot = ctx.bots.find((candidate) => (
    candidate.platform === platform && candidate.selfId === selfId
  ))
  if (!bot) {
    throw new OneBotUnavailableError(
      `绑定使用的 OneBot/NapCat 当前未连接：${platform}/${selfId}`,
    )
  }
  return { bot, internal: requireOneBotInternal(bot) }
}

export function requireOneBotInternal(bot: Bot): OneBotInternal {
  const internal = (bot as Bot & { internal?: Partial<OneBotInternal> }).internal
  if (!internal
    || typeof internal.getGroupRootFiles !== 'function'
    || typeof internal.getGroupFilesByFolder !== 'function'
    || typeof internal.uploadGroupFile !== 'function') {
    throw new Error('当前机器人没有提供所需的 OneBot 群文件接口。')
  }
  if (!isOneBotReady(bot)) {
    throw new OneBotUnavailableError(
      'OneBot/NapCat 尚未连接完成，请等待机器人上线后重试。',
    )
  }
  return internal as OneBotInternal
}

export function isOneBotReady(bot: Bot): boolean {
  const internal = (bot as Bot & { internal?: Partial<OneBotInternal> }).internal
  return bot.platform === 'onebot'
    && bot.status === ONLINE_STATUS
    && typeof internal?._request === 'function'
}

export function isOneBotUnavailableError(
  error: unknown,
): error is OneBotUnavailableError {
  return error instanceof OneBotUnavailableError
}

function normalizeFolders(response: OneBotGroupFileList): OneBotGroupFolder[] {
  return Array.isArray(response?.folders) ? response.folders : []
}

function normalizeFiles(response: OneBotGroupFileList): OneBotGroupFile[] {
  return Array.isArray(response?.files) ? response.files : []
}
