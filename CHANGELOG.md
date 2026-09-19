# Changelog

## 0.1.3

- 启动检查等待绑定的 OneBot/NapCat 机器人进入在线状态且请求通道已建立后再执行；
  修复 0.1.2 在连接建立前调用群文件接口导致的 `this._request is not a function`。
- 定时检查遇到断线时跳过本轮，不访问 GitHub、不创建失败记录；重连后自动补查。

## 0.1.2

- 改用 Node 原生 HTTPS 可读流下载附件，修复全局 `fetch` 响应体在部分 Windows
  环境下不产出数据、临时文件保持 0 字节的问题。
- 下载源按 CNB → `download.auto-mas.top` → GitHub 顺序回退；任一来源的大小或
  SHA-256 与 GitHub API 不一致时丢弃并切换下一个来源。
- 默认附件规则改为 `^AUTO-MAS-Lite-Setup-v.+-x64\.zip$`。
- 下载连接连续 60 秒无数据时切换来源；每收到一块数据重新计时。

## 0.1.1

- 首个可用版本：轮询 GitHub Release，流式下载并校验附件，通过 NapCat
  `upload_group_file` 上传到主人绑定的 QQ 群文件夹。
