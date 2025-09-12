-- CreateTable
CREATE TABLE "public"."BitcoinDepositAddress" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "address" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "receivedTxHash" TEXT,
    "receivedAmount" DECIMAL(30,8),

    CONSTRAINT "BitcoinDepositAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BitcoinDepositAddress_address_key" ON "public"."BitcoinDepositAddress"("address");

-- CreateIndex
CREATE UNIQUE INDEX "BitcoinDepositAddress_quoteId_key" ON "public"."BitcoinDepositAddress"("quoteId");

-- AddForeignKey
ALTER TABLE "public"."BitcoinDepositAddress" ADD CONSTRAINT "BitcoinDepositAddress_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "public"."Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
