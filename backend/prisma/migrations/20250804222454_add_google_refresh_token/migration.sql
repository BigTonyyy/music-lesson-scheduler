-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "googleRefreshToken" TEXT,
ADD COLUMN     "tokenExpiryDate" TIMESTAMP(3);
