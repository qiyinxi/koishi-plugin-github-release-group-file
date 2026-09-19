# koishi-plugin-github-release-group-file

监控 GitHub Release，由 Koishi 插件按镜像优先级在后台流式下载并校验附件，再把
本地绝对路径交给 OneBot/NapCat 上传到由部署主人确认过的 QQ 群文件夹。

## 安装

在 Koishi 插件市场搜索 `github-release-group-file`，或在实例目录中执行：

```bash
npm install koishi-plugin-github-release-group-file
```

依赖 `database` 与 `http` 服务，并需要已加载的 OneBot 适配器（推荐 NapCat）。

## 默认值

这个版本默认服务于 AUTO-MAS，仓库相关默认值如下；群号和主人 QQ 号没有默认值，
必须在 Koishi 后台自行填写：

| 项目 | 默认值 |
| --- | --- |
| 仓库 | `AUTO-MAS-Project/AUTO-MAS` |
| 监控起点 | `v5.4.0-beta.2` |
| 附件规则 | `^AUTO-MAS-Lite-Setup-v.+-x64\.zip$` |
| 下载顺序 | CNB → `download.auto-mas.top` → GitHub |
| 目标群 | 无默认值，填写你的 QQ 群号 |
| 群文件夹 | `AUTO-MAS软件分发` |
| 部署主人 | 无默认值，填写你的 QQ 号 |

起始版本中唯一匹配的附件是：

```text
AUTO-MAS-Lite-Setup-v5.4.0-beta.2-x64.zip
105638256 bytes（100.74 MiB）
sha256:d378d6644075c923edfc0b3c742c7e6b9f9d1f9ebd7493224386b4785977f625
```

`AUTO-MAS-Full-*`、`AUTO-MAS-Lite-*` 便携包以及 GitHub 自动生成的源码
ZIP/TAR 均不匹配，因此默认不会上传。

## 大文件链路

```text
GitHub Release API（版本、附件名、大小、SHA-256）
  → CNB 同标签同文件名
  → 失败时 download.auto-mas.top 同文件名
  → 再失败时 GitHub Release Asset
  → Node 原生 HTTPS 流写入实例内受控目录
  → 校验 GitHub API 声明的文件大小和 SHA-256
  → 将 Windows 绝对路径交给 NapCat upload_group_file
  → 上传到已绑定的 folder_id
```

镜像只用于传输，GitHub Release API 始终是附件元数据的可信来源。任一镜像返回的
大小或 SHA-256 不一致时，该内容会被丢弃并自动尝试下一个来源。

下载不调用 OneBot `download_file`，因此不占用 OneBot 的 60 秒响应窗口，也不
需要修改 OneBot 全局超时。文件内容不会载入 Koishi 内存，而是边接收边写盘、边
计算 SHA-256。

下载连接连续 60 秒没有收到任何字节时会切换来源。这个计时器每收到一块数据都会
重新开始，并不是要求约 101 MiB 的完整文件在 60 秒内下载完。

默认本地目录是相对于 Koishi 实例根目录的：

```text
data/github-release-group-file
```

后台只允许配置相对路径，禁止绝对路径和 `..` 跳出 Koishi 实例目录。传给 NapCat
时会转换成完整 Windows 绝对路径。

## 工作方式

1. 插件从部署机主动轮询 GitHub 公共 Release API，不需要开放公网 Webhook。
2. 部署主人必须在目标群运行一次 `发行文件绑定`。
3. 绑定命令读取群根目录，按精确名称找到 `AUTO-MAS软件分发`，保存真实
   OneBot `folder_id`、机器人账号和群号。
4. 插件从 `v5.4.0-beta.2` 开始，只选择符合附件正则的已上传 Asset。
5. 插件依次尝试 CNB、AUTO-MAS 下载站和 GitHub，并使用 GitHub 的大小与
   SHA-256 校验最终文件。
6. 校验通过后调用
   `upload_group_file(group, absolutePath, name, folderId)`。
7. 每个 GitHub Asset ID 的处理结果保存在 Koishi 数据库中，重启不会重复上传。

群号虽然在后台配置，但完成目标群内的主人绑定之前，插件不会访问 GitHub、下载
附件或上传文件。文件夹不存在、出现多个同名文件夹或 `folder_id` 变化时，插件会
停止并要求重新绑定，不会自动创建或猜测目录。

启动检查会等待绑定的 OneBot/NapCat 机器人进入在线状态且请求通道已经建立。
若定时检查正好遇到断线，会跳过本轮而不访问 GitHub、不创建失败记录；机器人
重新上线后会自动补查。

## 超时、缓存与同名文件

- 每个下载源失败后按 `downloadRetries` 重试，再切换到下一个来源。
- 单次来源下载仍受 `downloadTimeoutMinutes` 总时限保护，默认 30 分钟。
- OneBot 上传在 60 秒后返回超时时，插件会立即回查群文件夹。
- 若已经出现同名同大小文件，记录为成功，不再上传。
- 若暂时还没出现，保留已校验的本地文件，并默认等待 15 分钟后再检查和重试。
- 下一轮重试前仍会先查群文件夹，避免 NapCat 后台已完成上传时产生重复文件。
- 同名且大小相同：视为已经存在。
- 同名但大小不同：停止并报错。
- 插件不会自动删除、覆盖或移动任何群文件。
- 上传成功后默认删除插件自己的本地缓存；上传失败时保留缓存供下次复用。

## 指令

以下管理指令同时受 Koishi 权限等级和 `ownerUserId` 精确校验，并且只能在后台
配置的目标群中执行：

```text
发行文件绑定
发行文件状态
发行文件检查
发行文件解绑
```

也可使用完整英文指令：

```text
github-release-group-file.bind
github-release-group-file.status
github-release-group-file.check
github-release-group-file.unbind
```

`发行文件检查` 只负责启动后台任务并立即返回。大文件下载和 QQ 群文件上传可能
需要几分钟，可稍后使用 `发行文件状态` 查看结果。

## 开发验证

以下命令仅用于本开发包目录，不得在生产 Koishi Desktop 实例中运行：

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
npm.cmd run test:live
npm.cmd pack
```

单元测试使用很小的分块可读流验证流式写盘、来源回退、缓存、大小和 SHA-256，
不下载真实大文件。`test:live` 只读取一次 GitHub Release JSON，也不会下载附件
或访问 QQ 与生产实例。

## 生产部署

Koishi Desktop 实例使用其自带的 Yarn 4，不要在实例目录里运行 npm。完整步骤见
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

归档已经放入实例根目录后，安装命令为（把路径换成你自己的实例根目录）：

```powershell
Set-Location -LiteralPath '<Koishi 实例根目录>'
node.exe .\.yarn\releases\yarn-4.1.1.cjs add "koishi-plugin-github-release-group-file@file:./koishi-plugin-github-release-group-file-0.1.3.tgz"
```

安装后通过 Koishi Desktop 添加插件、在后台填写 `targetGroupId` 和 `ownerUserId`、
启动实例并检查启动日志，最后由部署主人在目标群中发送 `发行文件绑定`。

## 许可

[MIT](LICENSE)
