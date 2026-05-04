import express from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";

const prisma = new PrismaClient();
const router = express.Router();

/**
 * GET SALES ONLY (REPORTING)
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const { userId, dateFrom, dateTo, paymentMethod, tableId } = req.query;
    const where = {};

    if (userId) where.userId = String(userId);
    if (paymentMethod) where.paymentMethod = String(paymentMethod);
    if (tableId) where.tableId = String(tableId);

    const createdAtFilter = {};
    if (dateFrom) {
      const fromDate = new Date(String(dateFrom));
      if (!Number.isNaN(fromDate.getTime())) {
        createdAtFilter.gte = fromDate;
      }
    }
    if (dateTo) {
      const toDate = new Date(String(dateTo));
      if (!Number.isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        createdAtFilter.lte = toDate;
      }
    }
    if (Object.keys(createdAtFilter).length > 0) {
      where.createdAt = createdAtFilter;
    }

    const sales = await prisma.sale.findMany({
      where,
      include: {
        saleItems: { include: { product: true } },
        order: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: sales });
  } catch (error) {
    console.error("Sales fetch error:", error);
    res.status(500).json({ success: false });
  }
});

/**
 * GET SINGLE SALE
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const sale = await prisma.sale.findUnique({
      where: { id: req.params.id },
      include: {
        saleItems: { include: { product: true } },
        order: true,
      },
    });

    res.json({ success: true, data: sale });
  } catch (error) {
    console.error("Sale detail error:", error);
    res.status(500).json({ success: false });
  }
});

export default router;