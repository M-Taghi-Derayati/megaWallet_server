/*
  Warnings:

  - Added the required column `bestExchange` to the `Quote` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fromAssetSymbol` to the `Quote` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fromNetworkId` to the `Quote` table without a default value. This is not possible if the table is not empty.
  - Added the required column `toAssetSymbol` to the `Quote` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."Quote" ADD COLUMN     "bestExchange" TEXT NOT NULL,
ADD COLUMN     "fromAssetSymbol" TEXT NOT NULL,
ADD COLUMN     "fromNetworkId" TEXT NOT NULL,
ADD COLUMN     "toAssetSymbol" TEXT NOT NULL;
