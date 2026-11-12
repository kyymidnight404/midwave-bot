\# MIDWAVE

\## Product Requirements Document (PRD)

\### Discord Game Bot — MVP



\*\*Product Name:\*\* Midwave  

\*\*Product Type:\*\* Discord Gaming Bot  

\*\*Version:\*\* 1.0.0  

\*\*Development Status:\*\* Initial Development  

\*\*Primary Language:\*\* JavaScript  

\*\*Runtime:\*\* Node.js  

\*\*Discord Framework:\*\* discord.js  

\*\*Storage:\*\* In-memory (RAM only)  

\*\*Database:\*\* None  

\*\*Interface:\*\* Slash Commands + Discord Embeds



\---



\# 1. Product Overview



Midwave adalah Discord bot yang berfokus pada hiburan dan permainan interaktif untuk komunitas Discord.



Midwave memungkinkan pengguna memainkan berbagai mini-games secara solo melawan bot maupun multiplayer bersama pengguna Discord lainnya.



Seluruh interaksi dilakukan melalui Slash Commands, sedangkan informasi permainan, papan permainan, status pertandingan, dan hasil akhir ditampilkan menggunakan Discord Embeds.



Midwave dirancang sebagai aplikasi ringan, modular, dan mudah dikembangkan tanpa memerlukan database.



\## 1.1 Product Vision



Menjadikan Midwave sebagai game bot Discord yang sederhana, responsif, menyenangkan, dan memiliki identitas visual yang konsisten.



\## 1.2 Product Goals



\- Menyediakan tujuh permainan utama.

\- Mendukung mode Solo dan Multiplayer.

\- Menggunakan Slash Commands sebagai sistem interaksi utama.

\- Menggunakan Discord Embeds sebagai antarmuka visual.

\- Memastikan setiap permainan memiliki mekanisme yang benar.

\- Menggunakan penyimpanan sementara tanpa database.

\- Meminimalkan penggunaan resource server.

\- Mendukung deployment 24/7 pada cloud hosting.



\# 2. Technology Stack



| Component | Technology |

|---|---|

| Runtime | Node.js |

| Language | JavaScript |

| Discord API | discord.js |

| Module System | ES Modules |

| Interface | Slash Commands |

| Visual UI | Discord Embeds |

| Temporary Storage | JavaScript Map |

| Database | None |

| Deployment | Linux VPS / Oracle Cloud |

| Process Manager | PM2 |

| Version Control | Git + GitHub |



Gunakan versi stabil Node.js dan discord.js yang kompatibel saat implementasi dimulai.



Hindari framework atau dependency yang tidak diperlukan.



\# 3. Core Game Features



Midwave memiliki tujuh permainan utama. Seluruh permainan harus mempunyai mode yang relevan untuk Solo maupun Multiplayer.



\## 3.1 Number Guessing



Permainan menebak angka rahasia yang dipilih secara acak oleh bot.



\*\*Solo Mode\*\*

\- Pemain melawan bot.

\- Bot menentukan angka rahasia.

\- Pemain memasukkan tebakan melalui Slash Command.

\- Berikan petunjuk Higher atau Lower.

\- Batasi jumlah percobaan.



\*\*Multiplayer Mode\*\*

\- Dua pemain atau lebih bergantian menebak angka yang sama.

\- Setiap pemain mendapatkan giliran.

\- Pemain yang berhasil menebak angka menjadi pemenang.

\- Permainan berakhir ketika angka ditemukan atau batas percobaan habis.



\*\*Difficulty:\*\*

\- Easy: angka 1–50.

\- Normal: angka 1–100.

\- Hard: angka 1–200.



\## 3.2 Rock Paper Scissors



Permainan Batu, Gunting, Kertas.



\*\*Solo Mode\*\*

\- Pemain memilih Rock, Paper, atau Scissors.

\- Bot memilih secara acak.

\- Sistem menentukan hasil pertandingan.



\*\*Multiplayer Mode\*\*

\- Pemain mengundang lawan.

\- Kedua pemain memilih secara rahasia.

\- Hasil diperlihatkan setelah keduanya memilih.

\- Sistem menentukan pemenang.



\*\*Rules:\*\*

\- Rock mengalahkan Scissors.

\- Scissors mengalahkan Paper.

\- Paper mengalahkan Rock.

\- Pilihan sama menghasilkan Draw.



\## 3.3 Trivia Quiz



Permainan kuis pengetahuan umum.



\*\*Solo Mode\*\*

\- Pemain menjawab pertanyaan pilihan ganda.

\- Sediakan empat pilihan jawaban.

\- Sistem mengevaluasi jawaban.

\- Tampilkan skor akhir.



\*\*Multiplayer Mode\*\*

\- Beberapa pemain berkompetisi menjawab pertanyaan.

\- Setiap jawaban disampaikan secara privat menggunakan ephemeral response.

\- Jawaban tercepat dan benar mendapatkan poin.

\- Tampilkan skor sementara.

\- Tentukan pemenang berdasarkan skor akhir.



\*\*Categories:\*\*

\- General Knowledge

\- Science

\- Technology

\- Geography

\- History

\- Sports



\*\*Difficulty:\*\*

\- Easy

\- Normal

\- Hard



Gunakan question bank lokal berbentuk JSON. Siapkan minimal 50 pertanyaan awal dengan jawaban dan kategorinya.



Tidak perlu menggunakan API eksternal untuk mengambil pertanyaan.



\## 3.4 Coin Flip



Permainan lempar koin.



\*\*Solo Mode\*\*

\- Pemain memilih Heads atau Tails.

\- Bot mengacak hasil koin.

\- Sistem menentukan apakah tebakan benar.



\*\*Multiplayer Mode\*\*

\- Pemain mengundang lawan.

\- Kedua pemain memilih prediksi secara rahasia.

\- Bot melakukan coin flip.

\- Sistem menentukan hasil dan pemenang berdasarkan aturan permainan.



\## 3.5 Dice Rolling



Permainan lempar dadu.



\*\*Solo Mode\*\*

\- Pemain dapat menentukan jumlah dadu.

\- Pemain dapat menentukan jumlah sisi.

\- Bot menghasilkan angka secara acak.



\*\*Multiplayer Mode\*\*

\- Pemain menantang lawan.

\- Kedua pemain melempar dadu dengan konfigurasi yang sama.

\- Hasil dibandingkan.

\- Pemain dengan nilai tertinggi menang.



\*\*Default:\*\*

\- 1 dadu.

\- 6 sisi.



\*\*Limits:\*\*

\- Maksimal 10 dadu.

\- Maksimal 100 sisi per dadu.



Gunakan random number generator yang sesuai untuk hasil acak.



\## 3.6 Tic Tac Toe



Permainan papan 3×3 dengan simbol X dan O.



\*\*Solo Mode\*\*

\- Pemain melawan AI bot.

\- Pilihan difficulty Easy, Normal, Hard.

\- AI harus melakukan langkah yang legal.

\- Hard menggunakan algoritma Minimax.



\*\*Multiplayer Mode\*\*

\- Dua pemain berkompetisi.

\- Pemain pertama menggunakan X.

\- Pemain kedua menggunakan O.

\- Giliran dilakukan secara bergantian.



\*\*Game Rules:\*\*

\- Tiga simbol berurutan secara horizontal memenangkan permainan.

\- Tiga simbol berurutan secara vertikal memenangkan permainan.

\- Tiga simbol diagonal memenangkan permainan.

\- Jika papan penuh tanpa pemenang, hasilnya Draw.



\*\*Board Interface:\*\*

\- Tampilkan papan 3×3 menggunakan Discord Embed.

\- Setiap kotak mempunyai identitas koordinat.

\- Pemain melakukan langkah melalui Slash Command.

\- Perbarui embed setelah setiap langkah.



\## 3.7 Connect Four



Permainan menyusun empat keping secara berurutan.



\*\*Solo Mode\*\*

\- Pemain melawan AI.

\- AI harus memilih kolom yang legal.

\- Hard menggunakan algoritma pencarian langkah dengan evaluasi posisi.



\*\*Multiplayer Mode\*\*

\- Dua pemain berkompetisi.

\- Setiap pemain memiliki warna keping berbeda.

\- Pemain bergantian memasukkan keping ke dalam kolom.



\*\*Game Rules:\*\*

\- Board berukuran 7 kolom × 6 baris.

\- Keping jatuh ke posisi kosong paling bawah.

\- Empat keping horizontal memenangkan permainan.

\- Empat keping vertikal memenangkan permainan.

\- Empat keping diagonal memenangkan permainan.

\- Jika seluruh papan penuh tanpa pemenang, hasilnya Draw.



\*\*Board Interface:\*\*

\- Gunakan Discord Embed.

\- Tampilkan papan menggunakan karakter visual yang konsisten.

\- Pemain memilih kolom melalui Slash Command.



\# 4. Discord Command Structure



Semua permainan harus dapat diakses melalui Slash Commands.



Command utama:



| Command | Description |

|---|---|

| `/games` | Menampilkan seluruh daftar game |

| `/help` | Menampilkan panduan Midwave |

| `/game status` | Melihat pertandingan aktif |

| `/game cancel` | Membatalkan pertandingan |



Command permainan:



| Command | Description |

|---|---|

| `/guess` | Number Guessing |

| `/rps` | Rock Paper Scissors |

| `/trivia` | Trivia Quiz |

| `/coinflip` | Coin Flip |

| `/dice` | Dice Rolling |

| `/tictactoe` | Tic Tac Toe |

| `/connect4` | Connect Four |



Setiap command permainan memiliki subcommand sesuai kebutuhan.



Contoh:



\- `/guess solo difficulty`

\- `/guess challenge opponent difficulty`

\- `/guess play number`

\- `/rps solo`

\- `/rps challenge opponent`

\- `/rps choose choice`

\- `/trivia solo category difficulty`

\- `/trivia challenge opponent`

\- `/trivia answer option`

\- `/coinflip solo choice`

\- `/coinflip challenge opponent`

\- `/coinflip choose choice`

\- `/dice solo count sides`

\- `/dice challenge opponent`

\- `/tictactoe solo difficulty`

\- `/tictactoe challenge opponent`

\- `/tictactoe move position`

\- `/connect4 solo difficulty`

\- `/connect4 challenge opponent`

\- `/connect4 drop column`



Tambahkan:

\- `/invite accept`

\- `/invite decline`



Pastikan struktur command mengikuti batasan resmi Discord Application Commands.



\# 5. Multiplayer System



Multiplayer merupakan salah satu fitur utama Midwave.



\## 5.1 Invitation System



Alur pertandingan:



1\. Pemain A menggunakan command challenge.

2\. Pemain A menentukan lawan.

3\. Bot menampilkan invitation embed.

4\. Pemain B menerima atau menolak undangan.

5\. Jika diterima, pertandingan dimulai.

6\. Embed menampilkan status pertandingan.



\## 5.2 Session Management



Setiap pertandingan memiliki session ID unik.



Informasi sementara yang diperlukan:



\- Session ID.

\- Game type.

\- Channel ID.

\- Player IDs.

\- Current turn.

\- Game state.

\- Match status.

\- Start timestamp.

\- Timeout information.



\## 5.3 Match Rules



\- Pemain tidak boleh mengambil giliran pemain lain.

\- Pemain tidak boleh bergabung dengan pertandingan yang sudah berjalan.

\- Pemain tidak boleh membuat sesi duplikat yang bertentangan.

\- Pertandingan harus memiliki batas waktu.

\- Pemain dapat membatalkan pertandingan sesuai aturan.

\- Pertandingan otomatis berakhir apabila mencapai timeout.

\- Setiap pertandingan yang selesai harus menghapus data session dari RAM.



\# 6. UI / UX Design System



\## 6.1 Brand Identity



\*\*Name:\*\* Midwave



\*\*Visual Concept:\*\* Midnight Ocean



Gunakan desain minimalis, modern, clean, dan sedikit gaming atmosphere.



\## 6.2 Color Palette



| Token | Color | Hex |

|---|---|---|

| Primary | Deep Navy | `#101B2D` |

| Secondary | Ocean Blue | `#245B8F` |

| Accent | Soft Blue | `#63A9D8` |

| Text | White | `#FFFFFF` |

| Muted | Blue Grey | `#91A2B8` |

| Success | Green | `#43B581` |

| Danger | Red | `#ED4245` |

| Warning | Amber | `#FAA61A` |



Gunakan warna embed Discord yang sesuai.



\## 6.3 Embed Design



Setiap embed harus memiliki desain konsisten.



\*\*Game Embed Structure:\*\*

\- Game title.

\- Game description.

\- Game mode.

\- Player information.

\- Game status.

\- Current turn.

\- Game board atau game information.

\- Instructions.

\- Final result.



\*\*Lobby Embed:\*\*

\- Game title.

\- Host.

\- Opponent.

\- Invitation status.

\- Instructions untuk menerima undangan.



\*\*Result Embed:\*\*

\- Winner.

\- Loser.

\- Final score jika tersedia.

\- Game duration.

\- Result description.



Jangan memenuhi embed dengan informasi yang tidak diperlukan.



Gunakan footer `Midwave • Discord Game Bot`.



Gunakan logo Midwave pada embed jika aset tersedia.



\## 6.4 Interaction Design



Slash Commands adalah metode utama interaksi.



Discord Embeds digunakan sebagai tampilan informasi.



Gunakan ephemeral responses untuk:

\- Pilihan rahasia.

\- Jawaban Trivia.

\- Pesan kesalahan.

\- Informasi pribadi pemain.



Gunakan pesan publik untuk:

\- Lobby.

\- Status pertandingan.

\- Papan permainan.

\- Hasil akhir.



Tidak perlu membuat website atau dashboard pada MVP.



Tidak perlu menggunakan button atau select menu sebagai ketergantungan utama gameplay. Semua langkah permainan harus dapat dilakukan menggunakan Slash Commands.



\# 7. Temporary Storage Architecture



Midwave tidak menggunakan database.



Semua informasi permainan disimpan sementara menggunakan JavaScript Map.



Contoh:



```javascript

const activeGames = new Map();

const pendingInvites = new Map();

const playerSessions = new Map();

```



\*\*Storage Requirements:\*\*



\- Tidak menggunakan MySQL.

\- Tidak menggunakan PostgreSQL.

\- Tidak menggunakan MongoDB.

\- Tidak menggunakan Redis.

\- Tidak menyimpan statistik permanen.

\- Tidak membuat leaderboard permanen.

\- Tidak menyimpan riwayat pertandingan.

\- Tidak membuat user profile.

\- Tidak menyimpan informasi pemain ke file lokal.



Data hanya digunakan selama pertandingan berjalan.



Setelah pertandingan selesai, semua data session dihapus.



Gunakan TTL untuk membersihkan sesi yang tidak aktif.



Ketika bot restart, seluruh pertandingan sementara dianggap berakhir.



Catatan: Discord tetap menyimpan pesan sesuai sistem platformnya, tetapi Midwave tidak membuat penyimpanan data permanen sendiri.



\# 8. Project Architecture



Gunakan struktur modular.



```text

midwave/

│

├── src/

│   ├── commands/

│   │   ├── games.js

│   │   ├── help.js

│   │   ├── game.js

│   │   ├── invite.js

│   │   ├── guess.js

│   │   ├── rps.js

│   │   ├── trivia.js

│   │   ├── coinflip.js

│   │   ├── dice.js

│   │   ├── tictactoe.js

│   │   └── connect4.js

│   │

│   ├── games/

│   │   ├── GuessGame.js

│   │   ├── RPSGame.js

│   │   ├── TriviaGame.js

│   │   ├── CoinFlipGame.js

│   │   ├── DiceGame.js

│   │   ├── TicTacToeGame.js

│   │   └── ConnectFourGame.js

│   │

│   ├── managers/

│   │   ├── GameManager.js

│   │   ├── SessionManager.js

│   │   └── InviteManager.js

│   │

│   ├── handlers/

│   │   ├── CommandHandler.js

│   │   └── InteractionHandler.js

│   │

│   ├── utils/

│   │   ├── embeds.js

│   │   ├── random.js

│   │   ├── validators.js

│   │   └── constants.js

│   │

│   ├── data/

│   │   └── trivia.json

│   │

│   ├── events/

│   │   ├── ready.js

│   │   └── interactionCreate.js

│   │

│   └── index.js

│

├── tests/

│   ├── games/

│   ├── managers/

│   └── utils/

│

├── .env

├── .env.example

├── .gitignore

├── package.json

├── README.md

└── deploy-commands.js

```



Struktur dapat disesuaikan jika ada kebutuhan teknis, tetapi pemisahan game logic, command handler, dan session management harus dipertahankan.



\# 9. Performance \& Reliability



Midwave harus dirancang agar ringan dan stabil.



\*\*Requirements:\*\*



\- Tidak menggunakan database.

\- Tidak melakukan polling yang tidak diperlukan.

\- Tidak menggunakan dependency berlebihan.

\- Gunakan asynchronous operations dengan benar.

\- Hindari blocking operations.

\- Gunakan interaction defer/reply untuk mencegah Discord interaction timeout.

\- Tangani Discord API errors.

\- Tangani sesi yang kedaluwarsa.

\- Hindari memory leak.

\- Batasi jumlah sesi aktif secara wajar.

\- Gunakan cooldown untuk mencegah spam.

\- Bersihkan timer dan listener setelah game berakhir.



Untuk operasi random, gunakan `crypto.randomInt()` atau mekanisme random yang sesuai.



\# 10. Security



\- Token Discord wajib disimpan dalam `.env`.

\- Jangan pernah memasukkan token ke source code.

\- Jangan mengunggah `.env` ke GitHub.

\- Sediakan `.env.example`.

\- Validasi setiap command dan input.

\- Validasi identitas pemain sebelum memproses giliran.

\- Batasi penggunaan command sesuai status pertandingan.

\- Cegah pemain memanipulasi hasil pertandingan.

\- Cegah interaksi berulang yang menghasilkan state tidak konsisten.

\- Berikan error response yang informatif.



\# 11. Deployment



Target deployment awal adalah Oracle Cloud Always Free VM atau VPS Linux lainnya.



Requirements:



\- Ubuntu Linux.

\- Node.js.

\- npm.

\- PM2.

\- Git.



Bot harus dapat dijalankan dengan PM2 dan memiliki konfigurasi restart otomatis.



Sediakan dokumentasi deployment dari instalasi dependency hingga bot online.



Jangan membuat sistem hosting yang membutuhkan website tambahan.



\# 12. Testing Requirements



Seluruh game wajib diuji.



\*\*Functional Testing:\*\*

\- Solo mode berjalan.

\- Multiplayer mode berjalan.

\- Invitation berfungsi.

\- Accept dan decline berfungsi.

\- Validasi giliran berjalan.

\- Penentuan pemenang benar.

\- Draw dapat dideteksi.

\- Timeout berfungsi.

\- Pembatalan pertandingan berfungsi.



\*\*Game Logic Testing:\*\*

\- Number Guessing: higher/lower dan batas percobaan.

\- RPS: seluruh kombinasi kemenangan.

\- Trivia: validasi jawaban dan perhitungan skor.

\- Coin Flip: hasil acak dan evaluasi tebakan.

\- Dice: rentang nilai valid.

\- Tic Tac Toe: semua kondisi menang dan draw.

\- Connect Four: kemenangan horizontal, vertikal, diagonal, dan draw.



\*\*Storage Testing:\*\*

\- Session dibuat dengan benar.

\- Session diperbarui dengan benar.

\- Session dihapus setelah pertandingan.

\- Session dihapus setelah timeout.

\- Tidak ada data yang disimpan permanen.



\# 13. Acceptance Criteria



MVP dianggap selesai apabila:



\- \[ ] Bot berhasil login ke Discord.

\- \[ ] Semua Slash Commands terdaftar.

\- \[ ] Ketujuh game dapat dimainkan.

\- \[ ] Solo Mode berfungsi.

\- \[ ] Multiplayer Mode berfungsi.

\- \[ ] Invitation System berfungsi.

\- \[ ] Seluruh game memiliki embed yang konsisten.

\- \[ ] Game board diperbarui dengan benar.

\- \[ ] Semua mekanisme kemenangan valid.

\- \[ ] Timeout berfungsi.

\- \[ ] Session management berjalan.

\- \[ ] Tidak ada database.

\- \[ ] Tidak ada penyimpanan permanen.

\- \[ ] Error handling berjalan.

\- \[ ] Semua pengujian utama lulus.

\- \[ ] Bot siap untuk deployment.



\# 14. Out of Scope



Fitur berikut tidak termasuk dalam MVP:



\- Website dashboard.

\- Web control panel.

\- Database.

\- Persistent leaderboard.

\- User profiles.

\- Economy system.

\- Inventory system.

\- Shop.

\- Daily rewards.

\- Persistent match history.

\- Server premium subscription.

\- Payment integration.



Fokus sepenuhnya pada pengalaman bermain game di Discord.



\# 15. Future Roadmap



Setelah MVP stabil, pengembangan dapat dilanjutkan dengan:



\- Tambahan mini-games.

\- Tournament mode.

\- Team-based games.

\- Custom game rules.

\- Advanced AI.

\- Server-specific settings.

\- Website landing page.

\- Persistent leaderboard jika nantinya diperlukan.



Semua fitur roadmap bersifat opsional dan tidak boleh menghambat penyelesaian MVP.



\---



\# 16. Instructions for Gemini AI



Gunakan dokumen PRD ini sebagai acuan utama pengembangan Midwave.



Kamu bertindak sebagai Senior Discord.js Developer dan Software Architect.



\## Development Instructions



1\. Periksa terlebih dahulu isi repository dan kondisi project saat ini.

2\. Identifikasi file yang sudah tersedia sebelum membuat perubahan.

3\. Jangan menghapus atau menimpa konfigurasi yang masih diperlukan.

4\. Buat implementation plan berdasarkan PRD.

5\. Implementasikan project secara modular.

6\. Pastikan setiap game memiliki game logic yang terpisah.

7\. Pastikan seluruh interaksi Discord berjalan melalui Slash Commands.

8\. Gunakan Embeds sebagai tampilan utama.

9\. Terapkan session management berbasis RAM.

10\. Jangan menambahkan database atau penyimpanan permanen.

11\. Jangan menambahkan fitur di luar scope MVP tanpa alasan teknis yang kuat.

12\. Jangan menggunakan mock functionality untuk fitur yang seharusnya sudah bekerja.

13\. Implementasikan error handling dan validasi.

14\. Buat automated tests untuk game logic.

15\. Jalankan seluruh test dan lakukan perbaikan hingga lulus.

16\. Pastikan dokumentasi instalasi dan deployment tersedia.



\## Important Rules



\- Jangan hanya menghasilkan prototype UI.

\- Jangan membuat command yang hanya membalas pesan placeholder.

\- Jangan menganggap game selesai hanya karena command berhasil didaftarkan.

\- Seluruh game logic harus benar-benar berfungsi.

\- Jangan menyimpan data pengguna atau statistik secara permanen.

\- Jangan mengekspos token Discord.

\- Jangan mengklaim fitur selesai sebelum benar-benar diuji.



\## Expected Deliverables



1\. Source code lengkap Midwave.

2\. Seluruh tujuh permainan yang berfungsi.

3\. Sistem Solo dan Multiplayer.

4\. Slash Command Handler.

5\. Embed Design System.

6\. Session Management.

7\. Automated Tests.

8\. `.env.example`.

9\. `.gitignore`.

10\. `README.md`.

11\. Panduan konfigurasi Discord Developer Portal.

12\. Panduan deployment Linux VPS menggunakan PM2.

13\. Laporan hasil testing.



\*\*Final Objective:\*\*



Menghasilkan Discord Game Bot bernama Midwave yang modular, ringan, stabil, memiliki tujuh permainan utama, mendukung Solo dan Multiplayer, menggunakan Slash Commands serta Discord Embeds, dan tidak menggunakan database maupun penyimpanan data permanen.



Prioritaskan kualitas implementasi dan fungsionalitas daripada banyaknya fitur tambahan.



\*\*END OF PRD\*\*

