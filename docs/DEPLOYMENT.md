# 生产部署交接

目标是一台 Windows 上的 Koishi Desktop 实例（下文以 `<实例根目录>` 代指实例
根目录，例如 `%APPDATA%\Koishi\Desktop\data\instances\default`）。开发机不能
替代生产验证。本版本不调用 OneBot `download_file`，不需要修改 OneBot 的 60 秒
全局超时。

## 交付物

```text
koishi-plugin-github-release-group-file-0.1.3.tgz
```

先把归档复制到 `<实例根目录>`。

## 从 0.1.2 升级

0.1.2 可能在 Koishi 已就绪、OneBot/NapCat 尚在连接时立即调用群文件接口，日志会
出现 `this._request is not a function`。0.1.3 会等待绑定机器人进入在线状态且
请求通道已经建立后再启动检查；断线时跳过，重连后自动补查。

现有后台配置、群文件夹绑定、监控起点、下载缓存和数据库记录全部保留，不需要
重新绑定，也不需要修改 OneBot 的 60 秒超时。

## 从 0.1.1 或更早版本升级

0.1.1 在生产环境上已经确认会出现全局 `fetch` 响应体不产出数据、临时文件保持
0 字节的问题。0.1.2 改用 Node 原生 HTTPS 可读流，并按以下顺序下载：

```text
CNB → download.auto-mas.top → GitHub
```

GitHub API 提供的附件大小和 SHA-256 始终是最终校验标准。

1. 在 Koishi Desktop 中停止 `default` 实例。
2. 可删除 `<实例根目录>\data\github-release-group-file` 下已经确认为 0 字节的
   `*.part-*` 旧临时文件；这不会删除数据库或群文件：

   ```powershell
   Get-ChildItem -LiteralPath '<实例根目录>\data\github-release-group-file' -Filter '*.part-*' |
     Where-Object { $_.Length -eq 0 } |
     Remove-Item
   ```

3. 不要清空 `gh_release_file_*` 表，也不需要重新创建群文件夹。
4. 由于现有插件配置会保留旧值，升级后必须在 Koishi 后台把
   `assetPattern` 明确改为：

   ```text
   ^AUTO-MAS-Lite-Setup-v.+-x64\.zip$
   ```

Lite Setup 使用新的 GitHub Asset ID，因此旧 Full 包的下载记录不会阻止新版处理。

## 安装前

1. 确认当前实例使用 Node.js 18 或更高版本、Koishi 4.18.11 或更高版本，以及
   Koishi Desktop 自带的 Yarn 4。
2. 在 Koishi Desktop 中确认 OneBot 适配器已经加载。依赖存在不代表插件已加载。
3. 确认运行 NapCat 的 Windows 账户能读取 Koishi 实例根目录下的
   `data\github-release-group-file`。不要读取或修改 Token、endpoint、secret。
4. 不要打印完整 `koishi.yml`。

在 PowerShell 中备份依赖清单：

```powershell
& {
  Set-Location -LiteralPath '<实例根目录>'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item -LiteralPath '.\package.json' -Destination ".\package.json.before-github-release-group-file-$stamp.bak"
  Copy-Item -LiteralPath '.\yarn.lock' -Destination ".\yarn.lock.before-github-release-group-file-$stamp.bak"
}
```

## Yarn 4 安装

```powershell
Set-Location -LiteralPath '<实例根目录>'
node.exe .\.yarn\releases\yarn-4.1.1.cjs add "koishi-plugin-github-release-group-file@file:./koishi-plugin-github-release-group-file-0.1.3.tgz"
```

不得在生产目录运行 `npm install`、`npm ci` 或任何 `npm audit fix`。

## Koishi 后台配置

```text
enabled = true
repositoryOwner = AUTO-MAS-Project
repositoryName = AUTO-MAS
startTag = v5.4.0-beta.2
includePrereleases = true
assetPattern = ^AUTO-MAS-Lite-Setup-v.+-x64\.zip$
targetGroupId = <你的 QQ 群号>
targetFolderName = AUTO-MAS软件分发
ownerUserId = <部署主人的 QQ 号>
pollIntervalMinutes = 5
downloadDirectory = data/github-release-group-file
downloadTimeoutMinutes = 30
downloadRetries = 1
keepDownloadedFiles = false
failureRetryMinutes = 15
maxAssetSizeMiB = 512
githubToken = 留空
```

`targetGroupId` 和 `ownerUserId` 没有默认值，留空时所有管理命令都会拒绝执行。
`downloadDirectory` 必须保持为实例内相对路径。插件最终传给 NapCat 的是解析后的
完整 Windows 绝对路径。公开仓库不需要 GitHub Token。

## 启动与主人绑定

1. 从 Koishi Desktop 启动 `default` 实例并检查启动日志。
   插件会等待 OneBot/NapCat 显示在线后再做启动检查；不会再在连接建立前调用
   群文件接口。若启动时暂时离线，连接恢复后会自动补查，不需要重复绑定。
2. 现有绑定通常会继续有效。使用 `ownerUserId` 对应的 QQ 号在目标群中发送：

   ```text
   发行文件状态
   ```

3. 回复必须显示群号、`AUTO-MAS软件分发`、非空 `folder_id`，并显示新的 Lite
   Setup 附件规则。若绑定不存在，再发送：

   ```text
   发行文件绑定
   ```

4. 后台检查空闲时发送一次：

   ```text
   发行文件检查
   ```

5. 在群文件夹中核对：

   ```text
   AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip
   105638256 bytes
   ```

下载阶段不经过 OneBot 请求。下载连接只有在连续 60 秒完全没有收到字节时才切换
来源，并非 60 秒内必须下完。上传调用若因 OneBot 60 秒等待超时，插件会回查群
文件夹并进入 15 分钟保护期，不会立刻重复上传；无需调整全局超时。

## 验证边界

- 工作区测试不会连接生产实例、QQ 群或生产 OneBot。
- 只有在生产实例完成绑定并看到真实上传结果，才能确认 NapCat 对该绝对路径具有
  读取权限。
- 上传失败时先看 Koishi 和 NapCat 日志；不要删除数据库或其他插件的数据。
- 整个流程由部署机主动访问下载源，不需要开放公网端口。
