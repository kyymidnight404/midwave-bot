# Midwave — Discord Game & Utility Bot

**Midwave** is a modular Discord bot built with **Node.js**, **discord.js**, and **Prisma (SQLite)**. It combines interactive mini-games, AI assistance, media utilities, and server automation—keeping AI conversation history strictly in ephemeral RAM (15-minute TTL) while storing only essential operational data (`AutoRole`, active/recent `GameSession`/`GameParticipant` state without usernames, and seeded `QuizQuestion` data) in SQLite with automatic retention cleanup.

---

## Core Features

### 1. Mini-Games & Social Interactions

* **Coin Flip** (`!coinflip` / `!cf`) — Solo predictions or 2-player multiplayer lobby with secret Heads/Tails buttons.
* **Rock Paper Scissors** (`!rps`) — Solo mode or Best of 3 multiplayer lobby with ephemeral secret choices.
* **Tic Tac Toe** (`!tictactoe` / `!ttt [@user]`) — 3×3 interactive button grid against server members.
* **Quiz Battle** (`!quiz [category] [difficulty]`) — Interactive lobby and direct chat answers (`a`/`b`/`c`/`d`) powered by 90 seeded questions across 6 categories and 3 difficulties in SQLite.
* **Social Interactions** (`/social action:<action> [@user]` & prefix `!<action> [@user]`) — 11 anime GIF actions (`hug`, `pat`, `slap`, `bonk`, `kick`, `poke`, `yeet`, `highfive`, `wave`, `laugh`, `cry`).

### 2. Utilities, Server Tools & AI

* **Midwave AI** (`/ai` & `!ai`) — Conversational AI assistant powered by **Google Gemini API** (`gemini-2.5-flash`) with temporary **15-minute RAM-only conversation context** per user/channel (auto-expired and manually clearable via `/ai question:reset`, `!ai reset`, or `!ai hapus riwayat`), automatic real-time web search (**Tavily Search**), >2,000-character Markdown-safe splitting, prompt delimiter escaping, and mention sanitization.
* **Media Downloader** (`/media action:download`, `!download` / `!dl`, & Auto-Downloader) — Powered by **yt-dlp** + **FFmpeg** via an isolated Python 3.11+ subprocess (strict environment variable allowlist without app secrets). Includes multi-hop HTTP/HTTPS SSRF & DNS-rebinding guards in Node.js and Python (`socket.getaddrinfo` pinning & `connect()` validation), symlink/junction canonical path checks, strict magic-byte validation, concurrency-bounded FIFO queueing, cumulative multi-item Discord size limits (25/50/100 MB), timeout process-tree termination, and automatic temporary directory cleanup.
* **Media Creative Tools** (`/media action:qc|brat|lyrics` & `!qc`, `!brat`, `!lyrics`, `!igf`) — Quote cards, Brat `1024×1024` PNG cards, song lyrics via LRCLIB/iTunes/Genius, and Instagram Post Frame PNGs.
* **BMKG Weather, Anime & Pinterest** (`/weather`, `/anime`, `/pin`, `/math` & prefix equivalents) — Official Indonesian BMKG weather forecasts, AniList lookup, Pinterest search, and safe math expression evaluator.
* **Server Tools & Feedback** (`/autorole <add|remove|list>`, `!clear <count>`, `!say <text>`, `!feedback`) — Auto-role on member join, administrator-only bulk delete, mention-safe repeat, and private staff feedback reports.

---

## Requirements

* **Node.js** `>= 20.6.0` (uses built-in `--env-file=.env` and `node:test`)
* **npm** `>= 10`
* **Python** `>= 3.11` with `yt-dlp` and `yt-dlp-ejs` (for Media Downloader)
* **FFmpeg** & **FFprobe** (for merging video/audio streams and audio extraction)
* **Deno** (recommended for full YouTube JavaScript challenge support)
* **PM2** (optional, for Ubuntu VPS production deployment)

---

## Installation & Setup

1. **Clone & install dependencies**
```bash
git clone <your-repo-url> midwave
cd midwave
npm install

```


2. **Configure Environment Variables**
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env

```


| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Bot token from the Discord Developer Portal |
| `CLIENT_ID` | Yes | Discord Application ID |
| `GUILD_ID` | Optional | Test server ID for instant slash command deployment |
| `PREFIX` | Optional | Custom command prefix (default: `!`) |
| `GEMINI_API_KEY` | Optional | Google AI Studio API key for `/ai` |
| `TAVILY_API_KEY` | Optional | Tavily API key for real-time web search in `/ai` |
| `RAPIDAPI` *(removed)* | — | *(No longer used; replaced by local `yt-dlp`)* |
| `PYTHON_PATH` | Optional | Path/command for Python 3.11+ executable (default: `python3` / `python`) |
| `YTDLP_PATH` | Optional | Path/command override for `yt-dlp` or standalone zipapp (default: `yt-dlp`) |
| `YTDLP_AUTO_DOWNLOAD` | Optional | Auto-download official `yt-dlp` zipapp (~3 MB) if `yt_dlp` module is missing (`true`/`false`) |
| `YTDLP_ZIPAPP_SHA256` | Optional | Expected SHA-256 hex digest to verify standalone `yt-dlp` zipapp integrity |
| `FFMPEG_PATH` | Optional | Custom path to `ffmpeg` binary or directory if not in `PATH` |
| `DENO_PATH` | Optional | Custom path to `deno` binary for YouTube EJS JS challenge solving |
| `DOWNLOAD_TEMP_DIR` | Optional | Temporary download folder (default: `./temp/downloads`) |
| `DOWNLOAD_MAX_SIZE_MB` | Optional | Max attachment size cap in MB (default: `25`, bounded by guild boost tier) |
| `DOWNLOAD_TIMEOUT_SECONDS` | Optional | Per-job download timeout in seconds (default: `60`) |
| `DOWNLOAD_MAX_CONCURRENT` | Optional | Max concurrent yt-dlp jobs (default: `3`) |
| `DOWNLOAD_MAX_DURATION_SECONDS` | Optional | Max media duration in seconds (`0` = unlimited, default: `900`) |
| `AUTO_DOWNLOAD_ENABLED` | Optional | Enable/disable chat Auto-Downloader for TikTok/Instagram links (`true`/`false`) |
| `GENIUS_API_KEY` | Optional | Genius API token for metadata & official links in `/lyrics` |


3. **Register Slash Commands**
```bash
# Development (Guild-scoped, instant propagation)
npm run deploy

# Production (Global across all servers, up to ~1 hour propagation)
npm run deploy:global

```


4. **Start the Bot**
```bash
npm start

```



> **Discord Portal Note:** Enable **Message Content Intent** under the *Bot* tab so prefix commands (`!`) and chat Auto-Downloader work properly. Grant `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, and `Manage Messages` (optional) permissions.

---

## Quick Command Reference

* **Slash Commands (`/`):** `/ai`, `/weather`, `/anime`, `/math`, `/pin`, `/media action:<download|qc|brat|lyrics>`, `/social`, `/autorole`, `/donate`, `/ping`, `/help`
* **Prefix Commands (`!`):** `!menu`, `!ai`, `!download` (`!dl`), `!qc`, `!brat`, `!lyrics` (`!lirik`), `!igf`, `!pin`, `!weather`, `!anime`, `!math`, `!feedback`, `!say`, `!clear` *(Administrator Only)*, `!coinflip` (`!cf`), `!rps`, `!tictactoe` (`!ttt`), `!quiz`

---

## Project Structure

```text
midwave/
├── assets/               # Image assets (embed logo & custom emojis)
├── prisma/               # Prisma schema & SQLite migrations
├── scripts/downloader/   # Python yt-dlp worker & VPS dependency installer
├── src/
│   ├── commands/         # Slash command definitions & handlers
│   ├── prefixCommands/   # Prefix command handlers
│   ├── data/             # Static trivia bank (90 questions), BMKG regions & Knowledge Base
│   ├── events/           # Discord event listeners (ready, interactionCreate, messageCreate, guildCreate, guildDelete, guildMemberAdd)
│   ├── games/            # Game Center engines, persistence & unified lobby
│   ├── handlers/         # Command, interaction, prefix, and AutoDownloader routers
│   ├── managers/         # In-memory session, invite, and AI conversation managers
│   ├── services/         # External API clients & media services (Gemini, Tavily, Knowledge, Downloader, Pinterest, Lyrics, Anime, Weather, Feedback, Servers, Help)
│   └── utils/            # Image renderers (Brat/IGF), formatters, cooldowns, sanitizers & validators
├── tests/                # Automated test suite (node:test)
├── deploy-commands.js    # Slash command registration script
├── ecosystem.config.cjs  # PM2 process configuration
└── package.json

```

---

## Privacy & Data Processing

Midwave minimizes data retention and isolates temporary contexts from third parties:

### Local Database (Prisma + SQLite) & Retention
* **Persisted Models (`prisma/schema.prisma`):**
  * `AutoRole`: stores `guildId` and configured `roleId` for new-member auto-role assignment.
  * `QuizQuestion`: stores seeded quiz bank questions (`90` static trivia items).
  * `GameSession` & `GameParticipant`: stores active/recent Game Center state (`ttt`, `rps`, `quiz`), Discord IDs (`guildId`, `channelId`, `hostId`, participant `userId`), and serialized match state in SQLite (`GameParticipant.username` is never stored — always persisted as `null`; schema model `GameStats` is defined for future use and currently unused).
* **Automatic Data Retention & Guild Cleanup:**
  * Finished, cancelled, or expired `GameSession` records (and cascaded `GameParticipant` rows) are automatically deleted after a 1-hour retention TTL via `purgeExpiredGameSessions()`.
  * When Midwave leaves or is removed from a server (`guildDelete`), all guild-scoped `AutoRole` and `GameSession` rows for that server are deleted via `purgeGuildPersistedData()`.

### Temporary AI Conversation Context (15-Minute TTL)
* **Ephemeral RAM Storage:** `/ai` and `!ai` store recent conversation turns strictly in RAM (scoped to `guildId`, `channelId`, and `userId`)—never saved permanently to disk or SQLite.
* **15-Minute Automatic Expiration:** Inactive conversation context automatically expires after **15 minutes** (`DEFAULT_AI_CONVERSATION_TTL_MS = 900,000 ms`) and is periodically swept from memory as well as cleared on bot shutdown.
* **On-Demand Deletion:** Users can immediately delete their temporary conversation history in the current channel at any time using `/ai question:reset`, `!ai reset`, `!ai clear`, or `!ai hapus riwayat`.

### Third-Party Services & Processed Data
* **Google Gemini (`@google/genai`)**:
  * **Purpose:** Generates responses for `/ai` and `!ai`.
  * **Data Processed:** User question text (up to 1,500 chars), temporary 15-minute RAM conversation context for that channel/user, optional sanitized message excerpt when replying to a message (`<replied_message_untrusted>`, **excluding third-party Discord display names/usernames**), plus matched local Knowledge Base or search snippets when applicable. Discord User IDs, bot secrets, and API keys are never sent.
* **Tavily (`Tavily Search API`)**:
  * **Purpose:** Provides real-time web search results for time-sensitive `/ai` / `!ai` queries.
  * **Data Processed:** Only the normalized search query string derived from the user's question (along with search topic and result limit settings). Conversation history, Discord user IDs, and bot credentials are never sent to Tavily.
* **Local Media Downloader (`yt-dlp` + `FFmpeg`)**:
  * **Purpose:** Extracts and downloads public media via `/media action:download`, `!download`, and chat Auto-Downloader (TikTok/Instagram).
  * **Data Processed:** Only validated public HTTP/HTTPS URLs (with tracking query parameters stripped and private/internal IPs, redirects, and custom ports blocked across both Node.js and Python) are passed via `child_process.spawn` argument arrays with an isolated allowlist environment (`buildSafeSubprocessEnv`, no secrets passed). No personal browser cookies are read, and temporary downloaded files are deleted immediately after upload (plus periodic stale sweep).

### Feedback & Confidential Admin Channel Privacy
* `/feedback` and `!feedback` strictly require `FEEDBACK_CHANNEL_ID` to point to a **private staff text channel** (`ChannelType.GuildText`) inaccessible to `@everyone` (`View Channel` denied), with prompt ownership/context checks and staff permission validation.
* Confidential admin/owner prefix outputs (`!servers`, `!knowledge`) are routed via DM when invoked in a guild channel and refused safely if DMs are closed—never leaked to public channels.

---

### Downloader Setup (`yt-dlp` + `FFmpeg` + `Deno`)

1. **Install runtime dependencies** (Ubuntu/Debian VPS):
```bash
bash scripts/downloader/setup_deps.sh
```
Or manually:
```bash
python3 -m pip install --user --upgrade yt-dlp yt-dlp-ejs
sudo apt-get install -y ffmpeg
curl -fsSL https://deno.land/install.sh | sh
```
On Windows:
```powershell
python -m pip install --upgrade yt-dlp yt-dlp-ejs
winget install Gyan.FFmpeg DenoLand.Deno
```
2. **Verify installation:**
```bash
python3 --version
python3 -m yt_dlp --version
ffmpeg -version
ffprobe -version
deno --version
```

> **Hosting / Wispbyte Note:** On managed Node.js containers like Wispbyte (`nodejs_22`) where `python3` is available without `pip` or `sudo`, Midwave automatically downloads the official standalone `yt-dlp` zipapp (~3 MB, including `yt-dlp-ejs`) into `./temp/bin/yt-dlp` on first use and uses `node` as the JS runtime fallback when `deno` is absent. Single-stream formats (TikTok, Instagram, X, etc.) work without `ffmpeg`; for 1080p stream merging on low-disk/RAM tiers (512 MB RAM / 1 GB disk), an Ubuntu VPS or Docker host with `ffmpeg` installed is recommended.

### Supported Platforms & Limitations
- `yt-dlp` supports thousands of extractors (including YouTube, TikTok, Instagram, Facebook, X/Twitter, Reddit, Twitch, SoundCloud, Vimeo, Dailymotion, and Bilibili).
- Actual download availability depends on each website's current layout, login/cookie walls, age restrictions, geographic blocks, and `yt-dlp` extractor updates.
- Files exceeding the Discord server upload limit (25 MB standard, 50 MB Boost Lv.2, 100 MB Boost Lv.3) are rejected cleanly with an informative message rather than sending raw external stream links.
- Playlists are restricted (`noplaylist`) to prevent flooding Discord when sharing single-video links with playlist parameters.

### Downloader Troubleshooting
- **`Engine downloader (yt-dlp) belum terpasang`**: Run `python3 -m pip install --upgrade yt-dlp yt-dlp-ejs` in the environment pointed to by `PYTHON_PATH`.
- **`Dependensi FFmpeg tidak ditemukan`**: Install `ffmpeg` and `ffprobe`, or set `FFMPEG_PATH` in `.env`.
- **YouTube extraction / signature errors**: Ensure `yt-dlp`, `yt-dlp-ejs`, and `deno` are up to date (`pip install -U yt-dlp yt-dlp-ejs`).
- **Private / Login / Age-restricted / Geo-blocked errors**: Midwave intentionally does not ship or read personal browser cookies; private or authenticated posts cannot be downloaded.

## VPS Deployment (PM2) & Testing

* **Run Tests & Benchmarks:**
```bash
npm test
npm run bench:c4

```


* **Run in Production with PM2** *(keep `instances: 1` for consistent in-memory session state)*:
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup

```
