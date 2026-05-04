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

    // Enforce maximum 20 tables
    const currentCount = await prisma.table.count();
    if (currentCount >= 20) {
      return res.status(400).json({
        success: false,
        message: "Maximum of 20 tables reached. Please delete some tables before creating new ones.",
      });
    }

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

// GET /tables/:number - Get table by number (public for QR validation)
router.get("/:number", async (req, res) => {
  let tableNumber = null;
  let tableNumberStr = null;
  
  try {
    const { number } = req.params;
    
    // Robust parsing: extract digits before first non-digit (handles "1:1", "table1", etc.)
    const tableNumberMatch = number.match(/^(\d+)/);
    if (!tableNumberMatch) {
      return res.status(400).json({
        success: false,
        message: "Invalid table number format",
      });
    }
    
    tableNumberStr = tableNumberMatch[1];
    tableNumber = parseInt(tableNumberStr);

    const table = await prisma.table.findUnique({
      where: { number: tableNumber },
      include: {
        orders: {
          where: { status: "PENDING" },
          include: {
            orderItems: {
              select: {  // Safer: select specific fields, avoid full relation
                id: true,
                quantity: true,
                price: true,
                product: {
                  select: {
                    id: true,
                    name: true,
                    price: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!table) {
      return res.status(404).json({
        success: false,
        message: `Table ${tableNumber} not found`,
      });
    }

    res.status(200).json({
      success: true,
      data: table,
    });
  } catch (error) {
    console.error(`Error fetching table ${req.params.number}:`, {
      rawNumber: req.params.number,
      parsedNumber: tableNumberStr,
      tableNumber,
      error: error.message,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
    });
    
    // Fallback: return basic table info without relations
    if (tableNumber) {
      try {
        const safeTable = await prisma.table.findUnique({
          where: { number: tableNumber },
        });
        if (safeTable) {
          return res.status(200).json({
            success: true,
            data: { 
              ...safeTable, 
              orders: [], 
              _warnings: ['Partial data: some orders may have missing products'] 
            },
          });
        }
      } catch (safeError) {
        console.error("Safe table query failed:", safeError.message);
      }
    }
    
    res.status(500).json({
      success: false,
      message: "Unable to fetch table details",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
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
