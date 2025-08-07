/*
  Warnings:

  - You are about to drop the column `googleRefreshToken` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `tokenExpiryDate` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."User" DROP COLUMN "googleRefreshToken",
DROP COLUMN "tokenExpiryDate",
ADD COLUMN     "workingEnd" TEXT,
ADD COLUMN     "workingStart" TEXT;
