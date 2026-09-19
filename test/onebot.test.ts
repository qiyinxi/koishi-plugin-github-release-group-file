import { describe, expect, it } from 'vitest'
import type { Bot } from 'koishi'
import {
  findSameNameFiles,
  isOneBotReady,
  OneBotUnavailableError,
  requireOneBotInternal,
  resolveExactRootFolder,
  type OneBotGroupFileList,
} from '../src/onebot'

function fileList(): OneBotGroupFileList {
  return {
    folders: [{
      folder_id: '/8a61cfd5-1111-2222-3333-444444444444',
      folder_name: 'AUTO-MAS软件分发',
    }],
    files: [],
  }
}

describe('OneBot folder resolution', () => {
  it('resolves the exact display name to its immutable folder ID', () => {
    expect(resolveExactRootFolder(
      fileList(),
      'AUTO-MAS软件分发',
    ).folder_id).toBe('/8a61cfd5-1111-2222-3333-444444444444')
  })

  it('does not silently choose a missing or duplicate folder', () => {
    expect(() => resolveExactRootFolder(fileList(), '其他目录'))
      .toThrow('没有找到文件夹')
    const duplicate = fileList()
    duplicate.folders.push({ ...duplicate.folders[0], folder_id: '/another' })
    expect(() => resolveExactRootFolder(duplicate, 'AUTO-MAS软件分发'))
      .toThrow('存在多个同名文件夹')
  })
})

describe('OneBot existing-file checks', () => {
  it('returns every exact same-name file for conflict handling', () => {
    const response: OneBotGroupFileList = {
      folders: [],
      files: [
        {
          file_id: '1',
          file_name: 'AUTO-MAS-Full-Setup-v5.4.0-beta.2-x64.zip',
          busid: 102,
          file_size: 160903836,
        },
        {
          file_id: '2',
          file_name: 'AUTO-MAS-Full-v5.4.0-beta.2-x64.zip',
          busid: 102,
          file_size: 242314973,
        },
      ],
    }

    expect(findSameNameFiles(
      response,
      'AUTO-MAS-Full-Setup-v5.4.0-beta.2-x64.zip',
    )).toHaveLength(1)
  })
})

describe('OneBot transport readiness', () => {
  function bot(
    status: Bot['status'],
    withRequest = true,
  ): Bot {
    return {
      platform: 'onebot',
      status,
      internal: {
        _request: withRequest ? async () => ({}) : undefined,
        getGroupRootFiles: async () => ({ folders: [], files: [] }),
        getGroupFilesByFolder: async () => ({ folders: [], files: [] }),
        uploadGroupFile: async () => {},
      },
    } as unknown as Bot
  }

  it('accepts OneBot only after the adapter is online and has a request channel', () => {
    const online = bot(1)
    expect(isOneBotReady(online)).toBe(true)
    expect(requireOneBotInternal(online)).toBe(
      (online as Bot & { internal: unknown }).internal,
    )
  })

  it('treats startup and disconnected transports as temporarily unavailable', () => {
    const connecting = bot(2)
    const missingRequest = bot(1, false)

    expect(isOneBotReady(connecting)).toBe(false)
    expect(isOneBotReady(missingRequest)).toBe(false)
    expect(() => requireOneBotInternal(connecting))
      .toThrow(OneBotUnavailableError)
    expect(() => requireOneBotInternal(missingRequest))
      .toThrow('尚未连接完成')
  })
})
