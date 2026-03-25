-- DropForeignKey
ALTER TABLE `sale` DROP FOREIGN KEY `Sale_userId_fkey`;

-- DropIndex
DROP INDEX `Sale_userId_fkey` ON `sale`;

-- AlterTable
ALTER TABLE `sale` MODIFY `userId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `Sale` ADD CONSTRAINT `Sale_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
