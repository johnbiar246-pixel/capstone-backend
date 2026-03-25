-- AlterTable
ALTER TABLE `order` ADD COLUMN `paymentMethod` ENUM('CASH', 'GCASH') NULL,
    ADD COLUMN `referenceNo` VARCHAR(191) NULL;
