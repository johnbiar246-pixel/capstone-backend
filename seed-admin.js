import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function createAdminAccount() {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const adminRole = process.env.ADMIN_ROLE;

    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({
      where: { email: adminEmail },
    });

    if (existingAdmin) {
      console.log("Administrator account already exists");
      return;
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(adminPassword, salt);

    // Create admin account
    const admin = await prisma.user.create({
      data: {
        id: "admin",
        name: "Administrator",
        email: adminEmail,
        password: hashedPassword,
        role: adminRole,
      },
    });

    console.log("Administrator account created successfully:", {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      name: admin.name,
    });
  } catch (error) {
    console.error("Error creating admin account:", error);
  } finally {
    await prisma.$disconnect();
  }
}

createAdminAccount();
