import { describe, expect, it } from 'vitest'
import { deliveryId, monitorId } from '../src/config'

describe('persistent identity keys', () => {
  it('keeps repository casing out of the monitor identity', () => {
    const first = monitorId({
      repositoryOwner: 'AUTO-MAS-Project',
      repositoryName: 'AUTO-MAS',
      targetGroupId: '123456789',
      targetFolderName: 'AUTO-MAS软件分发',
    })
    const second = monitorId({
      repositoryOwner: 'auto-mas-project',
      repositoryName: 'auto-mas',
      targetGroupId: '123456789',
      targetFolderName: 'AUTO-MAS软件分发',
    })
    expect(first).toBe(second)
  })

  it('separates deliveries by asset ID and target', () => {
    const monitor = monitorId({
      repositoryOwner: 'AUTO-MAS-Project',
      repositoryName: 'AUTO-MAS',
      targetGroupId: '123456789',
      targetFolderName: 'AUTO-MAS软件分发',
    })
    expect(deliveryId(monitor, '493648478'))
      .not.toBe(deliveryId(monitor, '493648470'))
  })
})
