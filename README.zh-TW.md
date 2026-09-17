[English](README.md) | [繁體中文](README.zh-TW.md)

# AutoMate Taskboard

AutoMate Taskboard 是一個本機的議題看板，用來把工作交給程式代理（coding agent）處理。它在你的電腦上執行一個小型 Node.js 服務與 SQLite 資料庫，提供 React 網頁介面與 `taskctl` 命令列工具。議題可以指派給 Codex 或 Claude Code，由它們在同一台電腦上執行並把進度回報到看板。

本專案是 [Dashi Taskboard](https://github.com/chuspeeism/dashi-taskboard)（Apache-2.0）的修改版本。修改內容摘要見 [NOTICE](NOTICE)。

## 需求

- Windows 10 或 11 x64（桌面啟動器、安裝檔與自動更新以 Windows 為主要平台；網頁服務與 CLI 也能在 macOS、Linux 執行）
- 開發需要 Node.js 22.5 以上
- 至少一個代理 CLI，並以你自己的帳號登入：
  - [Codex CLI](https://github.com/openai/codex) 或 Codex 桌面版
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- 建置 Windows 安裝檔：Rust 1.88 以上，以及含 C++ 工作負載與 Windows SDK 的 Visual Studio Build Tools
- 手機存取：電腦與手機都要安裝 [Tailscale](https://tailscale.com/)

## 從原始碼執行

```bash
npm install
npm run build
npm start
```

開啟 <http://127.0.0.1:47833>。資料存放在 `.data/taskboard.sqlite`。

開發時使用前端即時重載：

```bash
npm run dev
```

Vite 介面在 <http://127.0.0.1:5173>，API 請求會轉給本機服務。

## 命令列工具

```bash
npm run taskctl -- project create --id my-project --name "My project" --workspace-path /absolute/path/to/repository
npm run taskctl -- issue create --project my-project --title "Next step" --status todo --priority high
```

設定 `CODEX_TASKBOARD_URL` 可讓 CLI 連到其他服務。`skills/manage-automate-taskboard` 是一份 Skill，教代理透過 `taskctl` 讀取與更新議題；桌面版會把它安裝到 `%USERPROFILE%\.agents\skills\manage-automate-taskboard`。

## 建置 Windows 桌面版

```powershell
npm ci
npm run app:build:windows
```

NSIS 安裝檔輸出到 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。安裝內容包括系統匣啟動器、內建 Node 執行環境、服務、網頁介面、Skill 與 `taskctl.cmd`。資料存放在 `%APPDATA%\AutoMate Taskboard`，日誌在 `%LOCALAPPDATA%\AutoMate Taskboard\Logs`。建置產物沒有程式碼簽章。解除安裝後保留哪些資料，見 [Windows uninstall](docs/windows-uninstall.md)。

Tauri 應用程式識別碼為 `io.github.automate-taskboard`。macOS／Linux 發行 workflow 與 Tauri updater 設定沿用上游，本 fork 不維護：updater 公鑰仍是上游的，所以 macOS／Linux 自動更新無法使用。macOS 發行 workflow 在推版本標籤時執行，需要本 fork 沒有設定的 Apple 簽章憑證。

## 從共用資料夾自動更新（Windows）

Windows 版可以從你自己管理的資料夾（例如網路共用資料夾）更新。本儲存庫沒有設定任何更新來源。

1. 先產生一次簽章金鑰：

   ```bash
   npm run update:keygen
   ```

   私鑰寫到 `~/.automate-taskboard/update-ed25519.pem`（在儲存庫之外；可用 `--private-key` 指定其他位置）。公鑰寫進 `shared/update-public-key.mjs`，此檔在本儲存庫中是空的；產生金鑰之前，程式會拒絕所有更新。
2. 建置時指定資料夾：在 `npm run app:build:windows` 之前設定 `AUTOMATE_UPDATE_SOURCE=\\server\share\automate-updates`。沒設定就不會更新。單台電腦可用 `%APPDATA%\AutoMate Taskboard\update-source.json`（內容 `{ "source": "..." }`）覆寫建置值，`""` 表示關閉更新。
3. 先提高 `package.json` 的版本號並建置，再發佈：

   ```bash
   npm run release:publish -- --notes "更新內容"
   ```

   這會把 `AutoMateTaskboard-<version>-setup.exe` 複製到資料夾，並寫入已簽章的 `latest.json`。私鑰路徑也可用 `AUTOMATE_UPDATE_PRIVATE_KEY` 指定。

程式在啟動 30 秒後、每 6 小時、以及從系統匣選單手動檢查更新。安裝前會驗證檔案大小、SHA-256 與 ed25519 簽章。

## 透過 Tailscale 用手機存取

服務預設監聽區域網路。若要在區域網路外用手機操作看板：兩台裝置都安裝 Tailscale 並登入同一個 tailnet，在看板設定中開啟手機存取，再用畫面上的一次性配對碼或 QR code 配對手機。手機存取開啟時，來自 Tailscale 位址（100.64.0.0/10）的請求必須是已配對的手機。啟動、停止或引導代理執行，只接受來自本機或已配對手機的請求。

## 設定

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | 綁定位址；設為 `127.0.0.1` 可關閉區域網路存取 |
| `CODEX_TASKBOARD_PORT` | `47833` | HTTP 連接埠 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 資料目錄 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47833` | CLI 使用的服務網址 |
| `CODEX_TASKBOARD_TRUSTED_ORIGINS` | 未設定 | 允許經由本機反向通道連入的 HTTPS 來源（逗號分隔） |
| `AUTOMATE_UPDATE_SOURCE` | 未設定 | 建置時寫入 Windows 版的更新資料夾 |

每個 `CODEX_TASKBOARD_*` 變數也可以寫成 `AUTOMATE_TASKBOARD_*`。

區域網路模式沒有帳號驗證：同一網路中能連到該連接埠的人都能讀寫看板。不要把連接埠公開到網際網路。

選用的 Cloudflare 共享部署見 [Cloud collaboration](docs/cloud-collaboration.md)（英文）。資料處理方式見 [PRIVACY.md](PRIVACY.md)。

## 測試

```bash
npm run typecheck
npm run test:node
npm run test:components
```

`npm run check` 會執行以上全部並建置正式版網頁介面。

## 授權

Apache License 2.0。見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。本專案基於 chuspeeism 與其貢獻者的 Dashi Taskboard。
