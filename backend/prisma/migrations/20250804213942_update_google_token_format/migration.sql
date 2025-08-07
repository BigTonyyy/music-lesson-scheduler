/*
  Warnings:

  - You are about to drop the column `refreshToken` on the `User` table. All the data in the column will be lost.
  - The `googleToken` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "public"."User" DROP COLUMN "refreshToken",
ADD COLUMN     "calendarId" TEXT,
DROP COLUMN "googleToken",
ADD COLUMN     "googleToken" JSONB;
