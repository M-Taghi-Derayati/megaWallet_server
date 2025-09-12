-- CreateTable
CREATE TABLE "public"."HdWalletState" (
    "id" TEXT NOT NULL,
    "nextIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HdWalletState_pkey" PRIMARY KEY ("id")
);
