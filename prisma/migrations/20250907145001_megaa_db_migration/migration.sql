-- CreateTable
CREATE TABLE "public"."Quote" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "fromAssetId" TEXT NOT NULL,
    "toAssetId" TEXT NOT NULL,
    "fromAmount" DECIMAL(30,18) NOT NULL,
    "finalReceiveAmount" DECIMAL(30,18) NOT NULL,
    "exchangeRate" DECIMAL(30,18) NOT NULL,
    "exchangeFee" DECIMAL(30,18) NOT NULL,
    "ourFee" DECIMAL(30,18) NOT NULL,
    "gasCosts" DECIMAL(30,18) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Trade" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "txHashContractCall" TEXT,
    "txHashFinalTransfer" TEXT,
    "failureReason" TEXT,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Trade_quoteId_key" ON "public"."Trade"("quoteId");

-- AddForeignKey
ALTER TABLE "public"."Trade" ADD CONSTRAINT "Trade_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "public"."Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
