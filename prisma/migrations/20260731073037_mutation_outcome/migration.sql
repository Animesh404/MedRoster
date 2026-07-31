-- CreateTable
CREATE TABLE "MutationOutcome" (
    "mutationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutationOutcome_pkey" PRIMARY KEY ("mutationId")
);

-- CreateIndex
CREATE INDEX "MutationOutcome_createdAt_idx" ON "MutationOutcome"("createdAt");

