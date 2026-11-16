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
* **Media Downloader** (`/media action:download` & Auto-Downloader) — Downloads public **Instagram** and **TikTok** photos, videos/reels, and carousels via RapidAPI with strict domain allowlisting, anti-SSRF & magic-byte validation, automatic chat link detection, and direct CDN button fallbacks for large files.
* **Lyrics Finder** (`/lyrics` & `!lyrics`) — Fetches song lyrics via **LRCLIB API** enriched with cover art (iTunes / optional Genius API) and interactive pagination buttons.
* **Brat Generator** (`/brat`) — Generates minimalist `1024×1024` Brat-style PNG images directly in memory.
* **Instagram Post Frame** (`!igf`) — Generates a transparent `1080×1080` Instagram Post Card PNG using the user's Discord avatar and display name.

---

## Requirements

* **Node.js** `>= 20.6.0` (uses built-in `--env-file=.env` and `node:test`)
* **npm** `>= 10`
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
| `RAPIDAPI_KEY` | Optional | RapidAPI key (`social-media-video-downloader`) for `/download` |
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
* **Utilities:** `/ai <question>`, `/download <url>`, `/lyrics <title> [artist]`, `/brat <text>`, `!igf [caption]`
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
│   ├── services/         # External API clients (Gemini, Tavily, LRCLIB, RapidAPI)
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
* **RapidAPI**:
  * **Purpose:** Extracts public media download URLs for **Instagram** and **TikTok** via `/media action:download` and Auto-Downloader.
  * **Data Processed:** Only validated public HTTPS URLs (or Instagram shortcodes) belonging strictly to allowlisted **Instagram** (`instagram.com`, `instagr.am`) and **TikTok** (`tiktok.com`) domains, with tracking query parameters stripped beforehand. Non-TikTok/Instagram URLs are rejected before calling RapidAPI, user URLs are neither persisted nor logged unnecessarily, and temporary downloaded files are deleted immediately after upload.

### Feedback Channel Privacy (`FEEDBACK_CHANNEL_ID`)
* `/feedback` and `!feedback` strictly require `FEEDBACK_CHANNEL_ID` to point to a **private staff channel** inaccessible to `@everyone` (`View Channel` denied). Reports are rejected if the channel is accessible to `@everyone` or if channel privacy permissions cannot be verified.

---

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
