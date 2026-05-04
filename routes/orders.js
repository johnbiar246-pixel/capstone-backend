import express from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";

const prisma = new PrismaClient();
const router = express.Router();

/**
 * CREATE ORDER (POST) - Unified checkout endpoint
 */
router.post("/", async (req, res) => {
  try {
    let {
      userId,
      items,
      tableId,
      paymentMethod,
      referenceNo,
      amountTendered,
      customerType = "REGULAR",
      status = "PENDING",
      source = "CASHIER",
    } = req.body;

    // Validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Items array is required",
      });
    }

    if (!paymentMethod || !["CASH", "GCASH"].includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Valid paymentMethod (CASH or GCASH) is required",
      });
    }

    if (paymentMethod === "GCASH" && (!referenceNo || referenceNo.trim() === "")) {
      return res.status(400).json({
        success: false,
        message: "Reference number required for GCASH",
      });
    }

    // Validate status and source
    const validStatuses = ["PENDING", "PREPARING", "COMPLETED", "CANCELLED", "DECLINED"];
    const validSources = ["CASHIER", "CUSTOMER"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    if (!validSources.includes(source)) {
      return res.status(400).json({
        success: false,
        message: `Invalid source. Must be one of: ${validSources.join(", ")}`,
      });
    }

    if (!userId) {
      const user = await prisma.user.findFirst({
        where: { role: "CASHIER" },
      });

      if (!user) {
        return res.status(400).json({
          success: false,
          message: "No cashier user found",
        });
      }

      userId = user.id;
    }

    // Single atomic transaction
    const result = await prisma.$transaction(async (tx) => {
      let subtotal = 0;
      let foodSubtotal = 0;
      const orderItemsData = [];
      const saleItemsData = [];

      // Validate items + compute pricing
      for (const item of items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          include: { category: true },
        });

        if (!product) {
          throw new Error(`Product ${item.productId} not found`);
        }

        // validate stock
        if (!['main-dishes', 'appetizers'].includes(product.category.id) && product.stock < item.quantity) {
          throw new Error(`Insufficient stock for ${product.name}`);
        }

        const itemTotal = product.price * item.quantity;
        subtotal += itemTotal;

        // Food items get discount/service charge
        const isFood = ['appetizers', 'main-dishes'].includes(
          product.category?.name?.toLowerCase() || ''
        );
        if (isFood) foodSubtotal += itemTotal;

        const orderItem = {
          productId: item.productId,
          quantity: item.quantity,
          price: product.price,
        };

        orderItemsData.push(orderItem);
        saleItemsData.push(orderItem);

        // Pre-decrement stock (will rollback on failure)
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      // Pricing rules
      const discountRate = customerType === "PWD" || customerType === "SENIOR" ? 0.2 : 0;
      const discount = foodSubtotal * discountRate;
      const applicableAmount = subtotal - discount;
      const serviceCharge = applicableAmount * 0.1;
      const totalAmount = applicableAmount + serviceCharge;

      // Validate tendered amount
      if (paymentMethod === "CASH" && amountTendered && amountTendered < totalAmount) {
        throw new Error(`Amount tendered must be >= total: ₱${totalAmount.toFixed(2)}`);
      }

      const change = amountTendered ? parseFloat((amountTendered - totalAmount).toFixed(2)) : 0;

      // Generate order number
      const orderNumber = await prisma.order.count() + 1;

      // 1. Create Order + orderItems
      const order = await tx.order.create({
        data: {
          ...(userId && { user: { connect: { id: userId } } }),
          ...(tableId && { table: { connect: { id: String(tableId) } } }),
          status: status.toUpperCase(),
          // source: source.toUpperCase(),
          orderNumber,
          customerType,
          foodSubtotal: parseFloat(foodSubtotal.toFixed(2)),
          nonFoodSubtotal: parseFloat((subtotal - foodSubtotal).toFixed(2)),
          discount: parseFloat(discount.toFixed(2)),
          serviceCharge: parseFloat(serviceCharge.toFixed(2)),
          totalAmount: parseFloat(totalAmount.toFixed(2)) || 0,
          amountTendered: amountTendered ? parseFloat(amountTendered) : null,
          change: change > 0 ? parseFloat(change.toFixed(2)) : 0,
          paymentMethod,
          referenceNo: paymentMethod === "GCASH" ? referenceNo.trim() : null,
          orderItems: {
            create: orderItemsData,
          },
        },
        include: {
          orderItems: { include: { product: true } },
          user: { select: { id: true, name: true } },
          table: true,
        },
      });

      // 2. Create Sale + saleItems (linked via orderId)
      const sale = await tx.sale.create({
        data: {
          orderId: order.id,
          ...(userId && { userId }),
          ...(tableId && { tableId  }),
          totalAmount: parseFloat(totalAmount.toFixed(2)),
          paymentMethod,
          referenceNo: paymentMethod === "GCASH" ? referenceNo.trim() : null,
          saleItems: {
            create: saleItemsData,
          },
        },
        include: {
          saleItems: { include: { product: true } },
          user: { select: { id: true, name: true } },
          table: true,
          order: true,
        },
      });

      return { order, sale };
    });

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      data: {
        order: result.order,
        sale: result.sale,
        paymentDetails: {
          subtotal: parseFloat(result.order.foodSubtotal + result.order.nonFoodSubtotal).toFixed(2),
          discount: result.order.discount.toFixed(2),
          serviceCharge: result.order.serviceCharge.toFixed(2),
          total: result.order.totalAmount.toFixed(2),
          change: result.order.change.toFixed(2),
        },
      },
    });
  } catch (error) {
    console.error("Order creation error:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Order creation failed",
    });
  }
});

/**
 * GET ORDERS BY USER ID (QUERY PARAMETER)
 */
router.get("/", async (req, res) => {
  try {
    const { userId, status, source } = req.query;

    // Build where clause dynamically
    const whereClause = {};

    if (userId) {
      whereClause.userId = userId;
    }

    if (status) {
      whereClause.status = status.toUpperCase();
    }

    if (source) {
      whereClause.source = source.toUpperCase();
    }

    const orders = await prisma.order.findMany({
      where: whereClause,
      include: {
        orderItems: {
          include: { product: true }
        },
        table: true,
        user: {
          select: { id: true, name: true }
        }
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Orders fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
});

/**
 * GET PENDING ORDERS (FOR CASHIER VIEW - NO AUTH REQUIRED, ROUTE PROTECTED BY FRONTEND)
 */
router.get("/pending", async (req, res) => {
  try {
    const pendingOrders = await prisma.order.findMany({
      where: { 
        status: { 
          in: ["PENDING", "PREPARING", "READY"] 
        } 
      },
      include: {
        orderItems: {
          include: { product: true }
        },
        table: true,
        user: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: pendingOrders });
  } catch (error) {
    console.error("Pending orders fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch pending orders" });
  }
});

/**
 * GET ORDERS BY TABLE NUMBER (FOR GUEST USERS)
 */
router.get("/by-table/:tableNumber", async (req, res) => {
  try {
    const { tableNumber } = req.params;

    // Find table by number first
    const table = await prisma.table.findFirst({
      where: { number: parseInt(tableNumber) }
    });

    if (!table) {
      return res.status(404).json({ success: false, message: "Table not found" });
    }

    // Get orders for this table
    const orders = await prisma.order.findMany({
      where: { tableId: table.id },
      include: {
        orderItems: {
          include: { product: true }
        },
        table: true,
        user: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Orders by table fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to load orders" });
  }
});

/**
 * SERVE ORDER ITEM - Mark as served/completed
 */
router.patch("/:orderId/items/:itemId/serve", requireAuth, async (req, res) => {
  try {
    const { orderId, itemId } = req.params;

    // Get order item to validate
    const orderItem = await prisma.orderItem.findUnique({
      where: { id: itemId },
    });

    if (!orderItem) {
      return res.status(404).json({ success: false, message: "Order item not found" });
    }

    // Mark as fully served (servedQuantity = quantity)
    const updatedItem = await prisma.orderItem.update({
      where: { id: itemId },
      data: { 
        servedQuantity: orderItem.quantity 
      },
      include: { product: true }
    });

    // Broadcast update
    if (req.io) {
      const broadcastOrdersUpdate = req.app.locals.broadcastOrdersUpdate || (() => {});
      await broadcastOrdersUpdate();
    }

    res.json({ success: true, data: updatedItem });
  } catch (error) {
    console.error('Order item serve error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * UPDATE ORDER STATUS ONLY
 */
router.patch("/:id/status", requireAuth, async (req, res) => {
  try {
    const { status, paymentMethod, referenceNo, amountTendered = null } = req.body;

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: {
        status,
        ...(paymentMethod && { paymentMethod }),
        ...(referenceNo && { referenceNo }),
        ...(amountTendered && { amountTendered }),
      },
      include: {
        orderItems: { include: { product: true } },
        table: true,
      }
    });

    // Broadcast update to all clients
    if (req.io) {
      const broadcastOrdersUpdate = req.app.locals.broadcastOrdersUpdate || (() => {});
      await broadcastOrdersUpdate();
    }

    res.json({ success: true, data: order });
  } catch (error) {
    console.error('Order status update error:', error);
    res.status(500).json({ success: false });
  }
});

/**
 * GET RECEIPT FOR ORDER
 */
router.get("/:id/receipt", requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        orderItems: { include: { product: true } },
        table: true,
        user: true,
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Calculate totals
    const subtotal = order.orderItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const discount = order.discount || 0;
    const serviceCharge = order.serviceCharge || 0;
    const total = subtotal - discount + serviceCharge;

    // Format receipt data
    const receiptData = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      date: new Date(order.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      table: order.table?.number || 'N/A',
      customerType: order.customerType || 'Regular',
      items: order.orderItems.map(item => ({
        name: item.product?.name || 'Unknown Item',
        quantity: item.quantity,
        price: item.price,
        total: item.price * item.quantity
      })),
      subtotal: subtotal,
      discount: discount,
      serviceCharge: serviceCharge,
      total: total,
      tendered: order.amountTendered || 0,
      change: Math.max(0, (order.amountTendered || 0) - total),
      cashier: order.user?.name || order.user?.email || 'System'
    };

    console.log('order:', order);

    res.json({ success: true, data: receiptData });
  } catch (error) {
    console.error('Receipt generation error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate receipt' });
  }
});

export default router;
