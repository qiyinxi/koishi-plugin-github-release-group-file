# OneBot 60 秒保持不变

目标 Lite Setup 附件为 `105638256` 字节（100.74 MiB）。本插件不调用 OneBot
`download_file`：

```text
GitHub API 确认附件元数据
→ CNB、AUTO-MAS 下载站、GitHub 依次尝试
→ Node 原生 HTTPS 流式下载到实例内目录
→ 校验 GitHub 声明的文件大小和 SHA-256
→ NapCat upload_group_file 接收本地绝对路径
```

因此大文件下载不占用 OneBot 的 60 秒响应等待，无需修改 OneBot 全局
`responseTimeout`。

下载器自身有 60 秒“无数据”保护：只有连接连续 60 秒没有收到任何字节时才失败
并切换来源；每收到一块数据都会重新计时。这不是完整文件的下载时限。单次来源的
总下载时限仍由 `downloadTimeoutMinutes` 控制，默认 30 分钟。

`upload_group_file` 本身仍可能超过 60 秒。对此插件采用幂等保护：

1. 上传调用返回错误或超时后，立即查询目标文件夹。
2. 找到同名同大小文件即记为成功。
3. 暂未找到时保留本地已校验文件，并进入默认 15 分钟保护期。
4. 保护期内的轮询只回查，不重复上传。
5. 保护期后仍先回查；文件不存在才复用本地缓存重新上传。

上线前只需确认 NapCat 进程能够读取插件显示的本地绝对路径。不要为此修改 OneBot
endpoint、token、secret、selfId 或全局超时。
