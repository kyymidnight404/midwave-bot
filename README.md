# Midwave — Discord Game Bot (MVP)

Midwave is a lightweight, modular Discord gaming bot built with **Node.js** and **discord.js**. It provides seven interactive mini-games supporting both **Solo** and **2-player Multiplayer** modes through **Slash Commands** and **Discord Embeds** using the *Midnight Ocean* design system.

Midwave stores active sessions and invitations purely in **in-memory JavaScript `Map` structures** with automatic TTL cleanup—no database or persistent storage is used.

---

## Features

- **7 Core Mini-Games** (Solo & 2-player Multiplayer):
  1. **Number Guessing** (`/guess`) — Easy (1–50, 8 attempts), Normal (1–100, 10 attempts), Hard (1–200, 12 attempts) with Higher/Lower hints.
  2. **Rock Paper Scissors** (`/rps`) — Secret choices via ephemeral replies until both players lock in.
  3. **Trivia Quiz** (`/trivia`) — 90 curated questions across 6 categories × 3 difficulties (5 rounds per match, no repeats, 20-second round timer in multiplayer).
  4. **Coin Flip** (`/coinflip`) — Secret Heads/Tails predictions; identical predictions yield a Draw.
  5. **Dice Rolling** (`/dice`) — Configurable 1–10 dice and 2–100 sides (default `1d6`).
  6. **Tic Tac Toe** (`/tictactoe`) — 3×3 board (`A1`–`C3`) with Easy, Normal, and unbeatable Hard (Minimax) AI.
  7. **Connect Four** (`/connect4`) — 7×6 board with Easy, Normal, and time-budgeted Alpha-Beta AI.
- **Utility Feature — Brat Generator** (`/brat`):
  - Generates minimalist `1024 × 1024` PNG images (`midwave-brat.png`) directly in memory with a solid white (`#FFFFFF`) background, top-left aligned black (`#000000`) regular sans-serif lowercase typography, subtle soft lo-fi blur, automatic font sizing/wrapping, SVG escaping, and per-user cooldown protection.
- **Utility Feature — Instagram Post Frame** (`!igf`):
  - Generates a `1080 × 1080` transparent-background Instagram Post Card PNG (`midwave-igf.png`) directly in memory using the caller's Discord avatar and display name.
- **AI Chatbot — Midwave AI** (`/ai` & `!ai`):
  - Powered by **Google Gemini API** (`@google/genai`, default `gemini-2.5-flash`) for programming, technology, education, general knowledge, and casual Q&A in Indonesian by default (or other languages on request).
  - Strictly **stateless** (no conversation history, no chat memory, no database) with per-user cooldown protection, `@everyone`/`@here` sanitization, and automatic >2,000 character Markdown-safe message splitting.
- **Utility Feature — Lyrics Finder** (`/lyrics`):
  - Searches song lyrics by title (`query`) and optional `artist` via **LRCLIB REST API** (`lrclib.net`), enriched with album metadata, cover art thumbnail, and official source links (**Apple Music iTunes Search API** and optional official **Genius REST API** via `GENIUS_API_KEY`).
  - Features interactive `Previous` / `Page X/Y` / `Next` button pagination (owner-locked with automatic button disable on timeout), in-memory TTL caching (10 minutes), and per-user cooldown protection.
- **Slash Command & Prefix Command Support** — Supports both Discord Slash Commands (`/`) and Prefix Commands (`!` by default, configurable via `PREFIX` in `.env`), sharing the same game engines, sessions, invites, and cooldowns.
- **In-Memory Session & Invite Lifecycle** — Automatic invite expiration (60s), idle session timeout (120s), per-session concurrency lock, cooldowns, and clean timer/listener disposal.
- **Zero Database** — All temporary match state lives in RAM and resets cleanly on bot restart.

---

## Requirements

- **Node.js** `>= 20.6.0` (uses built-in `--env-file=.env` and `node:test`; verified on Node.js `v24.22.1`)
- **npm** `>= 10`
- A Discord Application & Bot Token from the [Discord Developer Portal](https://discord.com/developers/applications)
- **PM2** (for production deployment on Ubuntu VPS)

---

## Project Structure

```text
midwave/
├── assets/
│   └── logo.png                  # Midwave embed thumbnail asset
├── scripts/
│   └── bench-c4.js               # Connect Four AI latency & event-loop benchmark
├── src/
│   ├── commands/                 # Slash command definitions & thin handlers
│   │   ├── ai.js                 # /ai stateless Gemini chatbot command
│   │   ├── brat.js
│   │   ├── coinflip.js
│   │   ├── connect4.js
│   │   ├── dice.js
│   │   ├── game.js
│   │   ├── games.js
│   │   ├── guess.js
│   │   ├── help.js
│   │   ├── invite.js
│   │   ├── lyrics.js             # /lyrics interactive paginated Lyrics Finder command
│   │   ├── rps.js
│   │   ├── tictactoe.js
│   │   └── trivia.js
│   ├── data/
│   │   └── trivia.json           # 90 validated trivia questions (6 categories × 3 difficulties × 5)
│   ├── events/
│   │   ├── interactionCreate.js
│   │   ├── messageCreate.js
│   │   └── ready.js
│   ├── games/                    # Pure, Discord-independent game engines
│   │   ├── ai/
│   │   │   ├── connectFourAI.js
│   │   │   └── ticTacToeAI.js
│   │   ├── CoinFlipGame.js
│   │   ├── ConnectFourGame.js
│   │   ├── DiceGame.js
│   │   ├── GuessGame.js
│   │   ├── RPSGame.js
│   │   ├── TicTacToeGame.js
│   │   ├── TriviaBank.js
│   │   └── TriviaGame.js
│   ├── handlers/
│   │   ├── CommandHandler.js
│   │   ├── InteractionHandler.js
│   │   ├── MessageCommandAdapter.js
│   │   └── PrefixCommandHandler.js
│   ├── managers/
│   │   ├── GameManager.js
│   │   ├── InviteManager.js
│   │   └── SessionManager.js
│   ├── prefixCommands/
│   │   └── igf.js                # !igf Instagram Post Frame command
│   ├── services/
│   │   ├── gemini.js             # Stateless Google Gemini API client
│   │   └── lyricsService.js      # LRCLIB + Apple Music / optional Genius REST lyrics service
│   ├── utils/
│   │   ├── aiFormatter.js        # Markdown-safe 2000-char splitter & mention sanitizer
│   │   ├── bratEmoji.js
│   │   ├── bratGenerator.js      # In-memory SVG -> PNG Brat image renderer
│   │   ├── constants.js
│   │   ├── cooldown.js
│   │   ├── discordBoard.js
│   │   ├── embeds.js
│   │   ├── gameCommandHelpers.js
│   │   ├── igfGenerator.js       # In-memory 1080x1080 Canvas Instagram frame renderer
│   │   ├── lyricsFormatter.js    # Word-safe lyrics pagination, embed & button builders
│   │   ├── prefixParser.js       # Prefix command parser & argument validator
│   │   ├── random.js
│   │   └── validators.js
│   └── index.js                  # Application wiring & startup
├── tests/                        # Automated tests (node:test)
├── .env.example                  # Environment variable template
├── .gitignore
├── deploy-commands.js            # Guild / global slash command registration
├── ecosystem.config.cjs          # PM2 process configuration
└── package.json
```

---

## Discord Developer Portal Setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Go to the **Bot** tab:
   - Click **Reset Token** and copy your bot token (keep it strictly inside `.env`).
   - Scroll to **Privileged Gateway Intents** and **enable `Message Content Intent`** (required for `!` prefix commands alongside `Guilds` and `GuildMessages` intents; `Server Members` and `Presence` are not required).
3. Copy your **Application ID** from **General Information** (`CLIENT_ID`).
4. Go to **OAuth2 → URL Generator**:
   - **Scopes**: select `bot` and `applications.commands`.
   - **Bot Permissions**: select:
     - `View Channels`
     - `Send Messages`
     - `Embed Links`
     - `Attach Files` (for the Midwave logo thumbnail and `/brat`)
     - `Manage Messages` *(optional, recommended so the bot can delete secret multiplayer prefix choice messages such as `!rps choose`)*
     - `Read Message History`
5. Open the generated URL to invite the bot to your test or production server.
6. *(Development)* Enable **Developer Mode** in Discord (`User Settings → Advanced → Developer Mode`), right-click your test server, and click **Copy Server ID** (`GUILD_ID`).

---

## Local Installation & Running

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment variables**

   Copy `.env.example` to `.env` and fill in your credentials:

   ```bash
   cp .env.example .env
   ```

   Example `.env` (never commit `.env` to Git):

   ```dotenv
   DISCORD_TOKEN=your_discord_bot_token_here
   CLIENT_ID=your_discord_application_id_here
   PREFIX=!
   GUILD_ID=your_test_guild_id_here
   GEMINI_API_KEY=your_gemini_api_key_here
   GEMINI_MODEL=gemini-2.5-flash
   ```

   > **How to get a Gemini API Key:** Sign in to [Google AI Studio](https://aistudio.google.com/apikey), click **Create API key**, copy the generated key into `GEMINI_API_KEY` inside your local `.env` (or Wispbyte environment variables), and never commit `.env` to Git.

3. **Register Slash Commands**

   - **Development (Guild-scoped, instant propagation):**
     ```bash
     npm run deploy
     ```
   - **Production (Global across all servers, up to ~1 hour propagation):**
     ```bash
     npm run deploy:global
     ```

4. **Start the bot**

   ```bash
   npm start
   ```

---

## Slash Commands Reference

### Core, Utility & Session Management

| Command | Description |
|---|---|
| `/games` | Lists all 7 games and their Solo/Multiplayer commands |
| `/help` | Shows bot usage instructions, utility commands, and match rules |
| `/ai question` | Asks Midwave AI (Google Gemini) a single independent question |
| `/brat text` | Generates a 1024×1024 Brat-style PNG image (`midwave-brat.png`, max 100 chars) |
| `/lyrics query [artist]` | Searches song lyrics with album art, source link, and paginated buttons |
| `/game status` | Displays your active match or pending invite (ephemeral) |
| `/game cancel` | Cancels your active match or outgoing pending invite |
| `/invite accept` | Accepts the latest pending multiplayer challenge |
| `/invite decline` | Declines an incoming multiplayer challenge |

### Game Commands

| Game | Solo | Multiplayer |
|---|---|---|
| Number Guessing | `/guess solo [difficulty]` → `/guess play number` | `/guess challenge opponent [difficulty]` → `/guess play number` |
| Rock Paper Scissors | `/rps solo choice` | `/rps challenge opponent` → `/rps choose choice` |
| Trivia Quiz | `/trivia solo [category] [difficulty]` → `/trivia answer option` | `/trivia challenge opponent [category] [difficulty]` → `/trivia answer option` |
| Coin Flip | `/coinflip solo choice` | `/coinflip challenge opponent` → `/coinflip choose choice` |
| Dice Rolling | `/dice solo [count] [sides]` | `/dice challenge opponent [count] [sides]` |
| Tic Tac Toe | `/tictactoe solo [difficulty]` → `/tictactoe move position` | `/tictactoe challenge opponent` → `/tictactoe move position` |
| Connect Four | `/connect4 solo [difficulty]` → `/connect4 drop column` | `/connect4 challenge opponent` → `/connect4 drop column` |

---

## Prefix Commands Reference (`!` default)

Midwave supports configurable prefix commands (`PREFIX=!` in `.env`) using the same underlying game engines, `SessionManager`, `InviteManager`, and cooldowns as Slash Commands:

- **Core & Utility**: `!games`, `!help`, `!ai <pertanyaan>`, `!brat <text>`, `!igf [caption]`, `!game status`, `!game cancel`, `!invite accept`, `!invite decline`
- **Solo**: `!guess [easy|normal|hard]`, `!rps <rock|paper|scissors>`, `!trivia [category] [difficulty]`, `!coinflip <heads|tails>`, `!dice [count] [sides]` (or `!dice 2d6`), `!tictactoe [easy|normal|hard]` (alias `!ttt`), `!connect4 [easy|normal|hard]` (alias `!c4`)
- **In-Game Moves**: `!guess <number>`, `!rps choose <choice>`, `!trivia <A|B|C|D>`, `!coinflip choose <choice>`, `!tictactoe <A1-C3>`, `!connect4 <1-7>`
- **Multiplayer**: `!guess @user [difficulty]`, `!rps challenge @user`, `!trivia @user [category] [difficulty]`, `!coinflip challenge @user`, `!dice @user [2d6]`, `!tictactoe challenge @user`, `!connect4 challenge @user`

> **Privacy Note:** For secret multiplayer choices (`rps`, `coinflip`, `trivia`), Slash Commands use native ephemeral replies, while prefix commands attempt to delete your trigger message (requires `Manage Messages`) and DM your confirmation.

---

## Midwave AI (Google Gemini Chatbot)

- **Usage**:
  - Slash Command: `/ai question: Apa itu JavaScript?`
  - Prefix Command: `!ai Apa itu JavaScript?` (seluruh teks setelah `!ai` dikirim sebagai satu pertanyaan utuh; maksimal 1.500 karakter).
- **Stateless (Tanpa Riwayat Percakapan)**: Setiap pertanyaan dikirim secara independen ke Gemini API. Bot **tidak** menyimpan riwayat chat, tidak memakai database, dan tidak meneruskan jawaban sebelumnya sebagai konteks.
- **Environment Variables**:
  - `GEMINI_API_KEY`: API key dari [Google AI Studio](https://aistudio.google.com/apikey) (wajib diisi di `.env` / panel hosting).
  - `GEMINI_MODEL`: Nama model Gemini (default: `gemini-2.5-flash`).
- **Free Tier & Rate Limits**:
  - Gemini API free tier memiliki batas permintaan per menit (RPM), token per menit (TPM), dan permintaan harian (RPD) sesuai kebijakan Google AI Studio.
  - Midwave menerapkan cooldown khusus AI (8 detik per pengguna) dan batas pertanyaan 1.500 karakter untuk mencegah spam serta menghemat kuota free tier. Jika rate limit atau kuota habis, bot akan menampilkan pesan error informatif tanpa menghentikan fitur lain.

---

## Lyrics Finder (`/lyrics`)

- **Usage**:
  - `/lyrics query: APT`
  - `/lyrics query: Love artist: wave to earth`
  - `/lyrics query: Blue`
- **Architecture & Library Choice**:
  - Uses Node.js built-in `fetch` (`AbortSignal.timeout`) with **zero extra npm dependencies** (avoiding `lyrics-finder`'s fragile Google scraping, `genius-lyrics`'s Cloudflare `403` HTML scraping blocks, and `lyricsgenius`'s Python runtime requirement).
  - **Lyrics source**: [LRCLIB](https://lrclib.net) open REST API (`/api/search`), with in-memory TTL caching (10 minutes) and 5-second per-user cooldown.
  - **Metadata & cover art**: Official **Apple iTunes Search API** (no API key needed) and optional **Official Genius API** (`GENIUS_API_KEY` in `.env`, metadata + official Genius URL only, zero HTML scraping).
- **Environment Variables**:
  - None required! `/lyrics` works out-of-the-box without extra keys.
  - Optional `GENIUS_API_KEY`: Client Access Token from [Genius API Clients](https://genius.com/api-clients) to prioritize Genius album thumbnails and official `genius.com` links.
- **Deployment**: Run `npm run deploy` (guild) or `npm run deploy:global` (global) to register `/lyrics` with Discord, then start the bot (`npm start` or restart Wispbyte/PM2).
- **Limitations & Attribution**:
  - Availability of lyrics depends on LRCLIB's community catalog; instrumental tracks or unlisted songs return an informative status message without fabricating lyrics.
  - Every embed displays source attribution and a link to the official/provider URL.

---

## Testing & Benchmarking

Run the full automated test suite (`node:test`):

```bash
npm test
```

Run the Connect Four AI latency and event-loop delay benchmark:

```bash
npm run bench:c4
```

---

## Ubuntu VPS Deployment (PM2)

1. **Install Node.js (v20.6+ or v24 LTS), Git, and PM2**

   ```bash
   sudo apt update && sudo apt install -y git curl
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   sudo npm install -g pm2
   ```

2. **Clone and set up the project**

   ```bash
   git clone <your-repo-url> midwave
   cd midwave
   npm ci --omit=dev
   cp .env.example .env
   nano .env
   ```

3. **Register global slash commands**

   ```bash
   npm run deploy:global
   ```

4. **Start with PM2**

   `ecosystem.config.cjs` is preconfigured with `autorestart: true`, `--env-file=.env`, and `instances: 1` (required for consistent in-memory session storage).

   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup
   ```

   Useful PM2 commands:

   ```bash
   pm2 status
   pm2 logs midwave-bot
   pm2 restart midwave-bot
   ```

---

## Troubleshooting

- **`Missing DISCORD_TOKEN environment variable`**: Ensure `.env` exists in the project root and you run commands via `npm start` / `npm run deploy` (which pass `--env-file=.env`) or `pm2 start ecosystem.config.cjs`.
- **Slash commands do not appear in Discord**: For instant testing, use `npm run deploy` with `GUILD_ID` set. Global commands (`npm run deploy:global`) can take up to 1 hour to propagate across Discord servers. Ensure the bot was invited with the `applications.commands` scope.
- **`Missing Permissions` / board does not update**: Verify the bot role has `View Channels`, `Send Messages`, `Embed Links`, and `Attach Files` in the target channel.
- **Sessions disappear after restart**: Expected behavior—Midwave stores active games solely in RAM (`Map`) and does not persist match data across restarts.
