import express from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";

const prisma = new PrismaClient();
const router = express.Router();

// Get dashboard summary data (auth required)
router.get("/summary", requireAuth, async (req, res) => {
  try {
    // Get total sales amount (PREPARING orders + Sales != CANCELLED)
    const preparingTotal = await prisma.order.aggregate({
      where: { status: "PREPARING" },
      _sum: { totalAmount: true }
    });
    const preparingOrdersTotal = preparingTotal._sum.totalAmount || 0;

    const salesTotalResult = await prisma.sale.aggregate({
      where: { status: { not: "CANCELLED" } },
      _sum: { totalAmount: true }
    });
    const salesTotal = salesTotalResult._sum.totalAmount || 0;
    const totalSales = preparingOrdersTotal + salesTotal;

    // Get total orders count (PREPARING + Sales)
    const preparingCount = await prisma.order.count({
      where: { status: "PREPARING" }
    });
    const salesCount = await prisma.sale.count({
      where: { status: { not: "CANCELLED" } }
    });
    const totalOrders = preparingCount + salesCount;

    // Calculate average order value
    const averageOrder = totalOrders > 0 ? totalSales / totalOrders : 0;

    // Get top selling items (PREPARING Orders + Sales)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Sales items
    const saleTopData = await prisma.saleItem.groupBy({
      by: ["productId"],
      _sum: {
        quantity: true,
      },
      where: {
        sale: {
          status: { not: "CANCELLED" },
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

    // Preparing orders items
    const orderTopData = await prisma.orderItem.groupBy({
      by: ["productId"],
      _sum: {
        quantity: true,
      },
      where: {
        order: {
          status: "PREPARING",
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

    // Combine quantities per product
    const productQuantities = new Map();
    [...saleTopData, ...orderTopData].forEach(item => {
      const current = productQuantities.get(item.productId) || 0;
      productQuantities.set(item.productId, current + (item._sum.quantity || 0));
    });

    const topItemsData = Array.from(productQuantities.entries()).map(([productId, quantity]) => ({ productId, _sum: { quantity } })).slice(0,10);

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

    // Recent transactions (PREPARING Orders + Sales)
    const recentPreparing = await prisma.order.findMany({
      where: { status: "PREPARING" },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        orderItems: {
          include: {
            product: true,
          },
        },
      },
    });

    const recentSalesData = await prisma.sale.findMany({
      where: { status: { not: "CANCELLED" } },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        saleItems: {
          include: {
            product: true,
          },
        },
      },
    });

    const recentTransactions = [...recentPreparing, ...recentSalesData]
      .map((record) => {
        const firstItem = (record.saleItems || record.orderItems)?.[0];
        return {
          id: record.id,
          item: firstItem?.product?.name || "Unknown Item",
          time: new Date(record.createdAt).toLocaleString(),
          amount: record.totalAmount,
          type: record.orderItems ? 'PREPARING' : 'COMPLETED',
        };
      })
      .slice(0, 10)
      .sort((a, b) => new Date(b.time) - new Date(a.time));

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

    // Sales
    const sales = await prisma.sale.findMany({
      where: {
        status: { not: "CANCELLED" },
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

    // PREPARING orders
    const preparingSales = await prisma.order.findMany({
      where: {
        status: "PREPARING",
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

    const allSalesData = [...sales, ...preparingSales];

    // Group sales by date
    const salesByDate = {};
    allSalesData.forEach((sale) => {
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
    // Sales items + Order items for PREPARING orders
    const saleItems = await prisma.saleItem.findMany({
      where: {
        sale: { status: { not: "CANCELLED" } }
      },
      include: {
        product: {
          include: {
            category: true,
          },
        },
      },
    });

    const orderItems = await prisma.orderItem.findMany({
      where: {
        order: { status: "PREPARING" }
      },
      include: {
        product: {
          include: {
            category: true,
          },
        },
      },
    });

    const salesItems = [...saleItems, ...orderItems];

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
