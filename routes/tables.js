import express from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const prisma = new PrismaClient();
const router = express.Router();

// Base URL for QR codes - can be configured via environment variable
const getBaseUrl = () => process.env.FRONTEND_URL || "http://localhost:5173";

// QR code route - uses scan-table for validation before redirecting to orders
const getQrUrl = (tableNumber) =>
  `${getBaseUrl()}/scan-table?table=${tableNumber}`;

// POST /tables - Generate multiple tables with QR codes (admin)
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tableNumbers } = req.body;

    if (
      !tableNumbers ||
      !Array.isArray(tableNumbers) ||
      tableNumbers.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "tableNumbers array is required",
      });
    }

    const baseUrl = getBaseUrl();
    const createdTables = [];

    for (const tableNumber of tableNumbers) {
      // Check if table already exists
      const existingTable = await prisma.table.findUnique({
        where: { number: tableNumber },
      });

      if (existingTable) {
        // Update existing table's qrValue
        const qrValue = getQrUrl(tableNumber);
        const updatedTable = await prisma.table.update({
          where: { id: existingTable.id },
          data: { qrValue },
        });
        createdTables.push(updatedTable);
      } else {
        // Create new table
        const qrValue = getQrUrl(tableNumber);
        const newTable = await prisma.table.create({
          data: {
            number: tableNumber,
            qrValue,
          },
        });
        createdTables.push(newTable);
      }
    }

    res.status(201).json({
      success: true,
      message: `Created/Updated ${createdTables.length} table(s)`,
      data: createdTables,
    });
  } catch (error) {
    console.error("Error creating tables:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// GET /tables - Get all tables (auth)
router.get("/", requireAuth, async (req, res) => {
  try {
    const tables = await prisma.table.findMany({
      orderBy: { number: "asc" },
    });

    res.status(200).json({
      success: true,
      data: tables,
    });
  } catch (error) {
    console.error("Error fetching tables:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// GET /tables/:number - Get table by number
router.get("/:number", async (req, res) => {
  try {
    const { number } = req.params;
    const tableNumber = parseInt(number);

    if (isNaN(tableNumber)) {
      return res.status(400).json({
        success: false,
        message: "Invalid table number",
      });
    }

    const table = await prisma.table.findUnique({
      where: { number: tableNumber },
      include: {
        orders: {
          where: { status: "PENDING" },
          include: {
            orderItems: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });

    if (!table) {
      return res.status(404).json({
        success: false,
        message: "Table not found",
      });
    }

    res.status(200).json({
      success: true,
      data: table,
    });
  } catch (error) {
    console.error("Error fetching table:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// DELETE /tables/:id - Delete a table
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const table = await prisma.table.findUnique({
      where: { id },
    });

    if (!table) {
      return res.status(404).json({
        success: false,
        message: "Table not found",
      });
    }

    await prisma.table.delete({
      where: { id },
    });

    res.status(200).json({
      success: true,
      message: "Table deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting table:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// PUT /tables/:id - Update table QR value
router.put("/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { number } = req.body;
    const baseUrl = getBaseUrl();

    const table = await prisma.table.findUnique({
      where: { id },
    });

    if (!table) {
      return res.status(404).json({
        success: false,
        message: "Table not found",
      });
    }

    const newTableNumber = number || table.number;
    const qrValue = getQrUrl(newTableNumber);

    const updatedTable = await prisma.table.update({
      where: { id },
      data: {
        number: newTableNumber,
        qrValue,
      },
    });

    res.status(200).json({
      success: true,
      message: "Table updated successfully",
      data: updatedTable,
    });
  } catch (error) {
    console.error("Error updating table:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;
