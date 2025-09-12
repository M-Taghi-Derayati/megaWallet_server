/*
  Warnings:

  - Added the required column `grossReceiveAmount` to the `Quote` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."Quote" ADD COLUMN     "grossReceiveAmount" DECIMAL(30,18) NOT NULL;
