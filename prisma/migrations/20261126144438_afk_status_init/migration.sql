-- CreateTable
CREATE TABLE "AfkStatus" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL DEFAULT 'Tidak ada alasan',
    "since" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
