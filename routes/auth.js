import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken"; // Make sure you import jwt
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

router.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    console.log("Login attempt for email:", email);

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPassword = password.trim();

    const user = await prisma.user.findFirst({
      where: { email: trimmedEmail },
    });

    console.log("User found:", !!user, user?.email);

    if (!user) {
      console.log("User not found");
      return res.status(400).json({
        success: false,
        message: `User with email ${trimmedEmail} does not exist`,
      });
    }

    const validPassword = await bcrypt.compare(trimmedPassword, user.password);
    console.log("Password valid:", validPassword);

    if (!validPassword) {
      return res.status(400).json({
        success: false,
        message: "Invalid password",
      });
    }

    // Check isVerified if exists
    if (user.isVerified === false) {
      console.log("User not verified");
      return res.status(403).json({
        success: false,
        message: "Account not verified. Please verify your email first.",
        needsVerification: true,
        user: { email: user.email, id: user.id },
      });
    }

    console.log("Login successful for user:", user.id);

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.TOKEN_SECRET,
      { expiresIn: "1h" },
    );

    const { password: _, ...userWithoutPassword } = user;
    return res.status(200).json({
      success: true,
      message: `You have successfully logged in as ${email}`,
      token,
      user: userWithoutPassword,
    });
  } catch (error) {
    console.error("Signin error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

router.get("/users", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });
    res.json({ success: true, data: users });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

router.put("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, password } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (role && !["ADMIN", "CASHIER"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role. Allowed roles: ADMIN, CASHIER",
      });
    }

    if (email && email !== existingUser.email) {
      const duplicate = await prisma.user.findUnique({ where: { email } });
      if (duplicate) {
        return res
          .status(400)
          .json({ success: false, message: "Email already exists" });
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (role !== undefined) updateData.role = role;

    if (password !== undefined && password !== "") {
      if (password.length < 6) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least 6 characters",
        });
      }
      updateData.password = await bcrypt.hash(password, 12);
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    const { password: _, ...userWithoutPassword } = updatedUser;
    return res.json({
      success: true,
      message: "User updated successfully",
      data: userWithoutPassword,
    });
  } catch (error) {
    console.error("Error updating user:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    await prisma.user.delete({ where: { id } });
    return res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Error deleting user:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
});

router.post("/create-user", async (req, res) => {
  try {
    console.log("=== CREATE USER REQUEST ===");
    console.log("Request body:", req.body);
    console.log("Request headers:", req.headers);

    const { name, email, password, role = "CASHIER" } = req.body;

    // Validate required fields
    if (!name || !email || !password) {
      console.log("Validation failed: Missing required fields");
      return res.status(400).json({
        success: false,
        message: "Name, email, and password are required",
      });
    }

    // Validate role
    if (!["ADMIN", "CASHIER"].includes(role)) {
      console.log("Validation failed: Invalid role:", role);
      return res.status(400).json({
        success: false,
        message: "Invalid role. Allowed roles: ADMIN, CASHIER",
      });
    }

    // Check for existing user
    console.log("Checking for existing user with email:", email);
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      console.log("User already exists with email:", email);
      return res
        .status(400)
        .json({ success: false, message: "Email already exists" });
    }

    // Hash password
    console.log("Hashing password...");
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    console.log("Creating user with data:", { name, email, role });
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role,
      },
    });

    console.log("User created successfully:", user.id);

    const { password: _, ...userWithoutPassword } = user;
    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: userWithoutPassword,
    });
  } catch (error) {
    console.error("=== CREATE USER ERROR ===");
    console.error("Error details:", error);
    console.error("Error message:", error.message);
    res.status(500).json({
      success: false,
      message: "Internal server error: " + error.message,
    });
  }
});

//  Export the router as default so server.js can import it
export default router;
