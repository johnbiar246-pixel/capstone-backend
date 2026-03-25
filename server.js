import cookieParser from "cookie-parser";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import dashboardRoutes from "./routes/dashboard.js";
import salesRoutes from "./routes/sales.js";
import productsRoutes from "./routes/products.js";
import authRoutes from "./routes/auth.js";
import tablesRoutes from "./routes/tables.js";

import { PrismaClient } from "@prisma/client";

dotenv.config();

const app = express();
const prisma = new PrismaClient(); // Prisma Client

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// Routes
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/tables", tablesRoutes);

// Test endpoint
app.get("/", async (req, res) => {
  try {
    const usersCount = await prisma.user.count();
    res.send(`Server is live! Total users: ${usersCount}`);
  } catch (err) {
    res.status(500).send("Server error: " + err.message);
  }
});

// Start server
const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
