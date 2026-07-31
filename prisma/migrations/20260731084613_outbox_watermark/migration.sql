-- CreateTable
CREATE TABLE "OutboxWatermark" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "prunedUpTo" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OutboxWatermark_pkey" PRIMARY KEY ("id")
);

