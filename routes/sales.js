import express from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";

const prisma = new PrismaClient();
const router = express.Router();

//Get all sales
router.get("/", requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, userId } = req.query;
    const where = {};

    // Filter by userId if provided
    if (userId) {
      where.userId = userId;
    }

    if (dateFrom || dateTo) {
      const tzOffsetMinutes = 8 * 60; // Asia/Manila (UTC+08:00)
      const isValidYmd = (dateStr) => /^\d{4}-\d{2}-\d{2}$/.test(dateStr);

      if (
        (dateFrom && !isValidYmd(dateFrom)) ||
        (dateTo && !isValidYmd(dateTo))
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format. Use YYYY-MM-DD.",
        });
      }

      const toUtcFromPhDayStart = (dateStr) => {
        const [year, month, day] = dateStr.split("-").map(Number);
        const dt = new Date(
          Date.UTC(year, month - 1, day, 0, 0, 0, 0) -
            tzOffsetMinutes * 60 * 1000,
        );
        return Number.isNaN(dt.getTime()) ? null : dt;
      };

      const toUtcFromPhDayEnd = (dateStr) => {
        const [year, month, day] = dateStr.split("-").map(Number);
        const dt = new Date(
          Date.UTC(year, month - 1, day, 23, 59, 59, 999) -
            tzOffsetMinutes * 60 * 1000,
        );
        return Number.isNaN(dt.getTime()) ? null : dt;
      };

      const fromUtc = dateFrom ? toUtcFromPhDayStart(dateFrom) : null;
      const toUtc = dateTo ? toUtcFromPhDayEnd(dateTo) : null;

      if ((dateFrom && !fromUtc) || (dateTo && !toUtc)) {
        return res.status(400).json({
          success: false,
          message: "Invalid date value.",
        });
      }

      where.createdAt = {};
      if (fromUtc) where.createdAt.gte = fromUtc;
      if (toUtc) where.createdAt.lte = toUtc;
    }
    const sales = await prisma.sale.findMany({
      where,
      include: {
        saleItems: {
          include: {
            product: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        table: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    res.status(200).json({
      success: true,
      data: sales,
    });
  } catch (error) {
    console.error("Error fetching sales:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const { userId, paymentMethod, items, tableId, referenceNo } = req.body;

    // Validate required fields
    if (
      !paymentMethod ||
      !items ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "paymentMethod and items array are required",
      });
    }

    // Check if user exists only if userId is provided (guest orders allowed)
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });
      if (!user) {
        return res.status(400).json({
          success: false,
          message: "Invalid userId",
        });
      }
    }

    // Validate table if provided
    if (tableId) {
      const table = await prisma.table.findUnique({
        where: { id: String(tableId) },
      });
      if (!table) {
        return res.status(400).json({
          success: false,
          message: "Invalid tableId",
        });
      }
    }

    // Validate paymentMethod
    if (!["CASH", "GCASH"].includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Invalid paymentMethod. Must be CASH or GCASH",
      });
    }

    // Validate referenceNo for GCASH
    if (
      paymentMethod === "GCASH" &&
      (!referenceNo || referenceNo.trim() === "")
    ) {
      return res.status(400).json({
        success: false,
        message: "Reference number is required for GCASH payments",
      });
    }

    let totalAmount = 0;
    const saleItemsData = [];

    // Validate items and calculate total
    for (const item of items) {
      const { productId, quantity } = item;
      if (!productId || !quantity || quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: "Each item must have productId and positive quantity",
        });
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
      });
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product with id ${productId} not found`,
        });
      }

      if (product.stock < quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for product ${product.name}. Available: ${product.stock}`,
        });
      }

      const itemTotal = product.price * quantity;
      totalAmount += itemTotal;

      saleItemsData.push({
        productId,
        quantity,
        price: product.price,
      });
    }

    // Create sale and sale items in a transaction
    const sale = await prisma.$transaction(async (tx) => {
      // Create sale
      const newSale = await tx.sale.create({
        data: {
          userId,
          totalAmount,
          paymentMethod,
          ...(tableId && { tableId: String(tableId) }),
          ...(referenceNo && { referenceNo: referenceNo.trim() }),
          saleItems: {
            create: saleItemsData,
          },
        },
        include: {
          saleItems: {
            include: {
              product: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          table: true,
        },
      });

      // Update product stock
      for (const item of saleItemsData) {
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stock: {
              decrement: item.quantity,
            },
          },
        });
      }

      return newSale;
    });

    res.status(201).json({
      success: true,
      message: "Sale created successfully",
      data: sale,
    });
  } catch (error) {
    console.error("Error creating sale:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Get orders by table number (public endpoint for guests)
router.get("/by-table/:tableNumber", async (req, res) => {
  try {
    const { tableNumber } = req.params;

    // Find the table first
    const table = await prisma.table.findUnique({
      where: { number: parseInt(tableNumber) },
    });

    if (!table) {
      return res.status(404).json({
        success: false,
        message: "Table not found",
      });
    }

    // Get sales for this table
    const sales = await prisma.sale.findMany({
      where: {
        tableId: table.id,
        // Only show recent orders (last 24 hours)
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
      include: {
        saleItems: {
          include: {
            product: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        table: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.status(200).json({
      success: true,
      data: sales,
    });
  } catch (error) {
    console.error("Error fetching sales by table:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Update sale status (accept/decline/cancel)
router.patch("/:id/status", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ["PENDING", "PREPARING", "COMPLETED", "CANCELLED"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Check if sale exists
    const existingSale = await prisma.sale.findUnique({
      where: { id },
    });

    if (!existingSale) {
      return res.status(404).json({
        success: false,
        message: "Sale not found",
      });
    }

    // Update sale status
    const updatedSale = await prisma.sale.update({
      where: { id },
      data: { status },
      include: {
        saleItems: {
          include: {
            product: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        table: true,
      },
    });

    res.status(200).json({
      success: true,
      message: `Sale status updated to ${status}`,
      data: updatedSale,
    });
  } catch (error) {
    console.error("Error updating sale status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;
