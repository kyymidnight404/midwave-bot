# Midwave — Discord Game & Utility Bot

**Midwave** is a modular Discord bot built with **Node.js**, **discord.js**, and **Prisma (SQLite)**. It combines interactive mini-games, Game Center leaderboards, AI assistance, and utility tools—keeping active game sessions, invites, and AI conversation context strictly in ephemeral RAM with automatic TTL cleanup, while persisting only Game Center player statistics and Knowledge Base entries in SQLite.

---

## Core Features

### 1. 7 Mini-Games (Solo & Multiplayer)

Supports both Slash Commands (`/`) and Prefix Commands (`!` by default):

* **Number Guessing** (`/guess`) — Guess the secret number with *Higher/Lower* hints (Easy 1–50, Normal 1–100, Hard 1–200).
* **Rock Paper Scissors** (`/rps`) — Secret ephemeral choices until both players lock in.
* **Trivia Quiz** (`/trivia`) — 90 curated questions across 6 categories & 3 difficulties (5 rounds per match, 20s timer in multiplayer).
* **Coin Flip** (`/coinflip`) — Secret *Heads/Tails* predictions.
* **Dice Rolling** (`/dice`) — Roll 1–10 dice with 2–100 sides (default `1d6`).
* **Tic Tac Toe** (`/tictactoe` / `!ttt`) — 3×3 grid (`A1`–`C3`) against friends or AI (up to unbeatable Hard Minimax).
* **Connect Four** (`/connect4` / `!c4`) — 7×6 board against friends or time-budgeted Alpha-Beta AI.

### 2. Utilities & AI

* **Midwave AI** (`/ai` & `!ai`) — Conversational AI assistant powered by **Google Gemini API** (`gemini-2.5-flash`) with temporary **15-minute RAM-only conversation context** per user/channel (auto-expired and manually clearable via `/ai question:reset`, `!ai reset`, or `!ai hapus riwayat`), automatic real-time web search (**Tavily Search**), >2,000-character Markdown-safe splitting, and mention sanitization.
* **Media Downloader** (`/media action:download`, `!download`, & Auto-Downloader) — Powered by **yt-dlp** + **FFmpeg** via a Python 3.11+ subprocess. Supports YouTube, TikTok, Instagram, Facebook, X / Twitter, Reddit, Twitch, Vimeo, Dailymotion, Bilibili, and other public video extractors. Includes HTTP/HTTPS SSRF protection, magic-byte file inspection, concurrency-bounded FIFO queueing, timeout/process-tree termination, Discord attachment size limits (25/50/100 MB), and automatic temporary directory cleanup.
* **Lyrics Finder** (`/lyrics` & `!lyrics`) — Fetches song lyrics via **LRCLIB API** enriched with cover art (iTunes / optional Genius API) and interactive pagination buttons.
* **Brat Generator** (`/brat`) — Generates minimalist `1024×1024` Brat-style PNG images directly in memory.
* **Instagram Post Frame** (`!igf`) — Generates a transparent `1080×1080` Instagram Post Card PNG using the user's Discord avatar and display name.

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

* **General & Sessions:** `/games`, `/help`, `/game status`, `/game cancel`, `/invite accept`, `/invite decline`
* **Utilities:** `/ai <question>`, `/download <url>`, `/lyrics <title> [artist]`, `/brat <text>`, `!igf [caption]`, `!clear <jumlah>` *(Administrator Only)*
* **Games (Solo / Challenge):** `/guess`, `/rps`, `/trivia`, `/coinflip`, `/dice`, `/tictactoe`, `/connect4` *(all also available via `!` prefix)*

---

## Project Structure

```text
midwave/
├── assets/               # Image assets (embed logo)
├── scripts/              # Connect Four AI latency & event-loop benchmark
├── src/
│   ├── commands/         # Slash command definitions & handlers
│   ├── prefixCommands/   # Prefix-only command handlers (!igf)
│   ├── data/             # Trivia question bank (90 questions)
│   ├── events/           # Discord event listeners (ready, interactionCreate, messageCreate)
│   ├── games/            # Pure game engines & AI (Minimax / Alpha-Beta)
│   ├── handlers/         # Command, button interaction, and Auto-Downloader routers
│   ├── managers/         # In-memory session, invite, and game state managers
│   ├── services/         # External API clients & media services (Gemini, Tavily, LRCLIB, AniList, yt-dlp)
│   └── utils/            # Image renderers (Brat/IGF), formatters, cooldowns & validators
├── tests/                # Automated test suite (node:test)
├── deploy-commands.js    # Slash command registration script
├── ecosystem.config.cjs  # PM2 process configuration
└── package.json

```

---

## Privacy & Data Processing

Midwave minimizes data retention and keeps transient interaction context strictly in ephemeral memory (RAM):

### Temporary AI Conversation Context (15-Minute TTL)
* **Ephemeral RAM Storage:** `/ai` and `!ai` store recent conversation turns strictly in RAM (scoped to `guildId`, `channelId`, and `userId`)—never saved permanently to disk or SQLite without consent.
* **15-Minute Automatic Expiration:** Inactive conversation context automatically expires after **15 minutes** (`DEFAULT_AI_CONVERSATION_TTL_MS = 900,000 ms`) and is periodically swept from memory as well as cleared on bot shutdown.
* **On-Demand Deletion:** Users can immediately delete their temporary conversation history in the current channel at any time using `/ai question:reset`, `!ai reset`, `!ai clear`, or `!ai hapus riwayat`.

### Third-Party Services & Processed Data
* **Google Gemini (`@google/genai`)**:
  * **Purpose:** Generates responses for `/ai` and `!ai`.
  * **Data Processed:** User question text (up to 1,500 chars), temporary 15-minute RAM conversation context for that channel/user, optional excerpt of a Discord message the user explicitly replied to, plus matched local Knowledge Base or search snippets when applicable. Bot secrets and API keys are never sent as prompt content and are redacted from logs.
* **Tavily (`Tavily Search API`)**:
  * **Purpose:** Provides real-time web search results for time-sensitive `/ai` / `!ai` queries.
  * **Data Processed:** Only the normalized search query string derived from the user's question (along with search topic and result limit settings). Conversation history, Discord user IDs, and bot credentials are never sent to Tavily.
* **Local Media Downloader (`yt-dlp` + `FFmpeg`)**:
  * **Purpose:** Extracts and downloads public media via `/media action:download`, `!download`, and chat Auto-Downloader (TikTok/Instagram).
  * **Data Processed:** Only validated public HTTP/HTTPS URLs (with tracking query parameters stripped and private/internal IPs blocked via SSRF checks) are passed via `child_process.spawn` argument arrays to `yt-dlp`. No personal browser cookies are read, user URLs are neither persisted nor logged unnecessarily, and temporary downloaded files are deleted immediately after upload.

### Feedback Channel Privacy (`FEEDBACK_CHANNEL_ID`)
* `/feedback` and `!feedback` strictly require `FEEDBACK_CHANNEL_ID` to point to a **private staff channel** inaccessible to `@everyone` (`View Channel` denied). Reports are rejected if the channel is accessible to `@everyone` or if channel privacy permissions cannot be verified.

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
