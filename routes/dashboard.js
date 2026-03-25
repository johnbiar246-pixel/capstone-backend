import express from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";

const prisma = new PrismaClient();
const router = express.Router();

// Get dashboard summary data (auth required)
router.get("/summary", requireAuth, async (req, res) => {
  try {
    // Get total sales amount
    const totalSalesResult = await prisma.sale.aggregate({
      _sum: {
        totalAmount: true,
      },
    });
    const totalSales = totalSalesResult._sum.totalAmount || 0;

    // Get total orders count
    const totalOrders = await prisma.sale.count();

    // Calculate average order value
    const averageOrder = totalOrders > 0 ? totalSales / totalOrders : 0;

    // Get top selling items (by quantity sold)
    // Get top 5 products by total revenue: sum(quantity) * product.price
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const topItemsData = await prisma.saleItem.groupBy({
      by: ["productId"],
      _sum: {
        quantity: true,
      },
      where: {
        sale: {
          createdAt: {
            gte: thirtyDaysAgo,
          },
        },
      },
      orderBy: {
        _sum: {
          quantity: "desc",
        },
      },
      take: 10,
    });

    const topItemsWithPrices = await Promise.all(
      topItemsData.map(async (item) => {
        const product = await prisma.product.findUnique({
          where: { id: item.productId },
          select: { name: true, price: true },
        });
        if (product) {
          const qty = item._sum.quantity || 0;
          return {
            name: product.name,
            quantity: qty,
            revenue: qty * product.price,
          };
        }
        return null;
      }),
    );

    const topItems = topItemsWithPrices
      .filter(Boolean)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Get recent transactions
    const recentSales = await prisma.sale.findMany({
      take: 10,
      orderBy: {
        createdAt: "desc",
      },
      include: {
        saleItems: {
          include: {
            product: true,
          },
        },
      },
    });

    const recentTransactions = recentSales.map((sale) => {
      const firstItem = sale.saleItems[0];
      return {
        id: sale.id,
        item: firstItem?.product?.name || "Unknown Item",
        time: new Date(sale.createdAt).toLocaleString(),
        amount: sale.totalAmount,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        totalSales,
        totalOrders,
        averageOrder,
        topItems,
        recentTransactions,
      },
    });
  } catch (error) {
    console.error("Error fetching dashboard summary:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Get sales chart data (daily sales for the last 7 days) (auth)
router.get("/sales-chart", requireAuth, async (req, res) => {
  try {
    let days = parseInt(req.query.days);
    if (isNaN(days) || days < 1) days = 7;
    if (days > 90) days = 90; // Prevent overload
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const sales = await prisma.sale.findMany({
      where: {
        createdAt: {
          gte: startDate,
        },
      },
      select: {
        totalAmount: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    // Group sales by date
    const salesByDate = {};
    sales.forEach((sale) => {
      const date = new Date(sale.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      if (!salesByDate[date]) {
        salesByDate[date] = 0;
      }
      salesByDate[date] += sale.totalAmount;
    });

    // Convert to array format for chart
    const chartData = Object.entries(salesByDate).map(([date, amount]) => ({
      date,
      sales: amount,
    }));

    res.status(200).json({
      success: true,
      data: chartData,
    });
  } catch (error) {
    console.error("Error fetching sales chart data:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Get sales by category (auth)
router.get("/sales-by-category", requireAuth, async (req, res) => {
  try {
    const salesItems = await prisma.saleItem.findMany({
      include: {
        product: {
          include: {
            category: true,
          },
        },
      },
    });

    // Group by category
    const categoryData = {};
    salesItems.forEach((item) => {
      const categoryName = item.product?.category?.name || "Uncategorized";
      if (!categoryData[categoryName]) {
        categoryData[categoryName] = 0;
      }
      categoryData[categoryName] += item.price * item.quantity;
    });

    // Convert to array format
    const data = Object.entries(categoryData).map(([name, value]) => ({
      name,
      value,
    }));

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching sales by category:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;
