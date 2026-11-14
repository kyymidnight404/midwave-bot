# Midwave — Discord Game & Utility Bot

**Midwave** is a lightweight, modular Discord bot built with **Node.js** and **discord.js**. It brings together 7 interactive mini-games (Solo & 2-Player Multiplayer) and modern utility tools in a single **zero-database** package—storing all active sessions, invites, and caches strictly in RAM with automatic TTL cleanup.

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

* **Midwave AI** (`/ai` & `!ai`) — **Stateless** chatbot powered by **Google Gemini API** (`gemini-2.5-flash`) with automatic real-time web search (**Tavily Search**), >2,000-character Markdown-safe splitting, and mention sanitization.
* **Media Downloader** (`/download` & Auto-Downloader) — Downloads public **Instagram** and **TikTok** photos, videos/reels, and carousels via RapidAPI with anti-SSRF & magic-byte validation, automatic chat link detection, and direct CDN button fallbacks for large files.
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
