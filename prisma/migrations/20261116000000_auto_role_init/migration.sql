CREATE TABLE "AutoRole" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "AutoRole_guildId_roleId_key" ON "AutoRole"("guildId", "roleId");
CREATE INDEX "AutoRole_guildId_idx" ON "AutoRole"("guildId");
