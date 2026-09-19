# AGENTS.md — GitHub Release Group File

## Scope

- This package polls GitHub Releases, streams selected assets to a controlled
  directory inside the Koishi instance, verifies them, and gives the absolute
  path to OneBot/NapCat for QQ group-folder upload.
- The initial use is `AUTO-MAS-Project/AUTO-MAS`, starting at
  `v5.4.0-beta.2`, on a Windows Koishi Desktop instance with NapCat.

## GitHub source and asset contract

- Use only official GitHub REST Release endpoints for release detection and
  authoritative Asset metadata.
- The default selector matches only
  `AUTO-MAS-Lite-Setup-v.+-x64.zip`.
- Do not upload Full, Lite portable, source archives, or an asset that fails
  repository URL validation.
- Include prereleases, exclude drafts, and start at `v5.4.0-beta.2`.
- Public AUTO-MAS needs no token. A future token is entered directly in the
  Koishi console and is never stored or requested in the workspace or chat.

## Local download contract

- Do not use OneBot `download_file`; its request can exceed the unchanged
  60-second OneBot response timeout.
- For AUTO-MAS Assets, try the same tag and filename in this order:
  `cnb.cool`, `download.auto-mas.top`, then the GitHub Asset URL.
- Treat GitHub API size and `sha256:` digest as authoritative regardless of
  which transfer source succeeds. A mirror mismatch must fail validation and
  fall through to the next source.
- Use a native Node HTTPS readable stream rather than converting the runtime
  global `fetch` response body; production demonstrated a zero-byte body
  stall in that conversion path while `curl.exe` could read the same Asset.
- Abort a connection after 60 seconds with no incoming bytes; this timer resets
  on each chunk and is not a 60-second total-file limit.
- Stream the response to disk without buffering the asset in Koishi memory.
- Resolve the configured relative download directory strictly beneath
  `ctx.baseDir`; reject absolute paths, traversal, and targets equal to the
  instance root.
- Write to a unique partial file, verify exact GitHub API size and the
  `sha256:` digest when present, then atomically rename to the final cache path.
- Give NapCat the final Windows absolute path only after validation succeeds.
- Keep a verified local file after upload failure. Remove only the
  plugin-owned file after confirmed delivery unless `keepDownloadedFiles` is
  enabled.

## Group binding and delivery contract

- `targetGroupId` and `ownerUserId` have no defaults; the default folder is
  `AUTO-MAS软件分发`. Never commit real group or user IDs to this repository.
- Configuration alone does not authorize uploads. The exact owner binds from
  the originating group.
- Resolve and persist the real `folder_id`; never pass the display name as the
  folder parameter, guess, create an alternative, or fall back to root.
- Do not call OneBot group-file APIs until the bound bot is `ONLINE` and its
  adapter request channel exists. Startup checks wait for that state; a poll
  that meets a disconnected transport skips without touching GitHub or
  creating a delivery failure, and an online transition schedules a recheck.
- Revalidate name and ID before every upload-capable poll.
- Persist by GitHub Asset ID. Same-name/same-size means delivered;
  same-name/different-size is a conflict. Never delete or overwrite group
  files.
- After an upload error or timeout, query the folder. If absent, keep the local
  file and defer another upload for the configured retry interval. Every retry
  checks the folder first.
- Notification failure after delivery never triggers another upload.

## Development and production

- Tests are non-production. The live test may read Release JSON but must not
  download the real asset or contact the production instance or QQ.
- Validate with `npm.cmd run check`, `npm.cmd test`, and
  `npm.cmd run test:live`; package with `npm.cmd pack`.
- Production uses bundled Yarn 4.1.1 only after backing up `package.json` and
  `yarn.lock`:

  ```powershell
  Set-Location -LiteralPath '<Koishi instance root>'
  node.exe .\.yarn\releases\yarn-4.1.1.cjs add "koishi-plugin-github-release-group-file@file:./koishi-plugin-github-release-group-file-0.1.3.tgz"
  ```
