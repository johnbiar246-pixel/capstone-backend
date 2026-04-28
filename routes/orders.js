import express from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";

const prisma = new PrismaClient();
const router = express.Router();

// Helper function to generate next order number
async function generateOrderNumber() {
  // Workaround: Count existing orders and add 1
  // This avoids using orderNumber field which may not be recognized by Prisma client
  const count = await prisma.order.count();
  return count + 1;
}

// Get all orders (for staff)
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, tableId } = req.query;
    const where = {};

    if (status) {
      where.status = status;
    }

    if (tableId) {
      where.tableId = tableId;
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        orderItems: {
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
      data: orders,
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
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

    // Get orders for this table
    const orders = await prisma.order.findMany({
      where: {
        tableId: table.id,
        // Only show recent orders (last 24 hours)
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
      include: {
        orderItems: {
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
      data: orders,
    });
  } catch (error) {
    console.error("Error fetching orders by table:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Create a new order (from guest - no auth required)
router.post("/", async (req, res) => {
  try {
    const { 
      userId, 
      items, 
      tableId, 
      status, 
      paymentMethod, 
      referenceNo, 
      amountTendered, 
      customerType,
      foodSubtotal,
      nonFoodSubtotal,
      discount,
      serviceCharge,
      totalAmount 
    } = req.body;

    // Log incoming request for debugging
    console.log("Creating order:", {
      userId,
      itemCount: items?.length,
      tableId,
      status,
      paymentMethod,
      customerType,
      breakdown: { foodSubtotal, nonFoodSubtotal, discount, serviceCharge, totalAmount },
    });

    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Items array is required",
      });
    }

    // Validate user if provided
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });
      if (!user) {
        return res.status(400).json({
          success: false,
          message: "Invalid userId - user not found",
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

    // Validate status if provided (for POS direct to PREPARING)
    const orderStatus = status || "PENDING";
    const validStatuses = ["PENDING", "PREPARING", "COMPLETED", "CANCELLED"];
    if (!validStatuses.includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Validate breakdown if provided
    if (foodSubtotal !== undefined && (foodSubtotal < 0 || !Number.isFinite(foodSubtotal))) {
      return res.status(400).json({ success: false, message: "Invalid foodSubtotal" });
    }
    if (nonFoodSubtotal !== undefined && (nonFoodSubtotal < 0 || !Number.isFinite(nonFoodSubtotal))) {
      return res.status(400).json({ success: false, message: "Invalid nonFoodSubtotal" });
    }
    if (discount !== undefined && (discount < 0 || !Number.isFinite(discount))) {
      return res.status(400).json({ success: false, message: "Invalid discount" });
    }
    if (serviceCharge !== undefined && (serviceCharge < 0 || !Number.isFinite(serviceCharge))) {
      return res.status(400).json({ success: false, message: "Invalid serviceCharge" });
    }
    if (totalAmount !== undefined && (totalAmount < 0 || !Number.isFinite(totalAmount))) {
      return res.status(400).json({ success: false, message: "Invalid totalAmount" });
    }

    // If creating directly as PREPARING, validate payment method
    if (orderStatus === "PREPARING") {
      if (!paymentMethod || !["CASH", "GCASH"].includes(paymentMethod)) {
        return res.status(400).json({
          success: false,
          message:
            "Valid paymentMethod (CASH or GCASH) is required for PREPARING orders",
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
    }

    let subtotal = 0;
    const orderItemsData = [];

    // Validate items and calculate subtotal
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

      const itemTotal = product.price * quantity;
      subtotal += itemTotal;

      orderItemsData.push({
        productId,
        quantity,
        price: product.price,
      });
    }

// Compute proper breakdown and totalAmount
    const discountValue = discount !== undefined ? discount : 0;
    const serviceChargeValue = serviceCharge !== undefined ? serviceCharge : 0;
    const foodSubtotalValue = subtotal; // All items as food for simplicity
    const nonFoodSubtotalValue = 0;
    const computedTotalAmount = subtotal + serviceChargeValue - discountValue;

    let changeValue = 0;
    if (amountTendered !== undefined && orderStatus === "PREPARING") {
      if (amountTendered < computedTotalAmount) {
        return res.status(400).json({
          success: false,
          message: `Amount tendered (₱${amountTendered.toFixed(2)}) must be >= total (₱${computedTotalAmount.toFixed(2)})`
        });
      }
      changeValue = parseFloat((amountTendered - computedTotalAmount).toFixed(2));
      console.log(`Computed change: ₱${changeValue} for tendered ₱${amountTendered} - total ₱${computedTotalAmount}`);
    }

    if (computedTotalAmount < 0) {
      return res.status(400).json({ success: false, message: "Computed totalAmount cannot be negative" });
    }

    // Generate order number manually (workaround for Prisma autoincrement issue)
    const orderNumber = await generateOrderNumber();

    // Create order and order items in a transaction
    const order = await prisma.$transaction(async (tx) => {
      // Create order with optional payment info + breakdown
      const orderData = {
        userId,
        tableId: tableId ? String(tableId) : null,
        status: orderStatus,
        orderNumber,
        customerType,
        foodSubtotal: foodSubtotalValue,
        nonFoodSubtotal: nonFoodSubtotalValue,
        discount: discountValue,
        serviceCharge: serviceChargeValue,
        totalAmount: computedTotalAmount,
        ...(amountTendered !== undefined && { amountTendered }),
        ...(changeValue > 0 && { change: changeValue }),
        orderItems: {
          create: orderItemsData,
        },
      };

      // Add payment info if creating as PREPARING
      if (orderStatus === "PREPARING") {
        orderData.paymentMethod = paymentMethod;
        orderData.referenceNo = referenceNo ? referenceNo.trim() : null;
      }

      const newOrder = await tx.order.create({
        data: orderData,
        include: {
          orderItems: {
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

      return newOrder;
    });

    res.status(201).json({
      success: true,
      message: `Order created successfully with status: ${orderStatus}`,
      data: order,
    });
  } catch (error) {
    console.error("Error creating order:", error);
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);
    console.error("Error meta:", error.meta);
    console.error("Request body:", req.body);
    
    // Return more detailed error in development, generic in production
    const isDevelopment = process.env.NODE_ENV === 'development';
    res.status(500).json({
      success: false,
      message: isDevelopment ? `Error: ${error.message}` : "Internal server error",
      error: isDevelopment ? {
        message: error.message,
        code: error.code,
        meta: error.meta,
      } : undefined,
    });
  }
});

// Update order status (accept/decline/cancel)
router.patch("/:id/status", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, paymentMethod, referenceNo, amountTendered } = req.body;

    // Validate status
    const validStatuses = ["PENDING", "PREPARING", "COMPLETED", "CANCELLED"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Check if order exists
    const existingOrder = await prisma.order.findUnique({
      where: { id },
      include: {
        orderItems: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // If marking as PREPARING, store payment method
    if (status === "PREPARING") {
      // Validate payment method
      if (!paymentMethod || !["CASH", "GCASH"].includes(paymentMethod)) {
        return res.status(400).json({
          success: false,
          message:
            "Valid paymentMethod (CASH or GCASH) is required to accept order",
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

      // Update order with payment method
      // Validate amountTendered
      if (!amountTendered || amountTendered <= 0 || amountTendered < existingOrder.totalAmount) {
        return res.status(400).json({
          success: false,
          message: `Amount tendered (₱${amountTendered?.toFixed(2) || 0}) must be >= total (₱${existingOrder.totalAmount?.toFixed(2) || 0})`,
        });
      }

      const change = parseFloat((amountTendered - (existingOrder.totalAmount || 0)).toFixed(2));

      const updatedOrder = await prisma.order.update({
        where: { id },
        data: {
          status,
          paymentMethod,
          referenceNo: referenceNo ? referenceNo.trim() : null,
          amountTendered,
          change,
        },
        include: {
          orderItems: {
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

      return res.status(200).json({
        success: true,
        message: `Order accepted and status updated to ${status}`,
        data: updatedOrder,
      });
    }

    // If marking as COMPLETED, convert to Sale
    if (status === "COMPLETED") {
      // Use stored payment method or provided one
      const finalPaymentMethod = existingOrder.paymentMethod || paymentMethod;
      const finalReferenceNo = existingOrder.referenceNo || referenceNo;

      // Validate payment method
      if (
        !finalPaymentMethod ||
        !["CASH", "GCASH"].includes(finalPaymentMethod)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Valid paymentMethod (CASH or GCASH) is required to complete order",
        });
      }

      // Validate referenceNo for GCASH
      if (
        finalPaymentMethod === "GCASH" &&
        (!finalReferenceNo || finalReferenceNo.trim() === "")
      ) {
        return res.status(400).json({
          success: false,
          message: "Reference number is required for GCASH payments",
        });
      }

      // Create sale from order
      const sale = await prisma.$transaction(async (tx) => {
        // Create sale
        const newSale = await tx.sale.create({
          data: {
            userId: existingOrder.userId,
            totalAmount: existingOrder.orderItems.reduce(
              (sum, item) => sum + item.price * item.quantity,
              0,
            ),
            paymentMethod: finalPaymentMethod,
            tableId: existingOrder.tableId,
            referenceNo: finalReferenceNo ? finalReferenceNo.trim() : null,
            status: "COMPLETED",
            saleItems: {
              create: existingOrder.orderItems.map((item) => ({
                productId: item.productId,
                quantity: item.quantity,
                price: item.price,
              })),
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
        for (const item of existingOrder.orderItems) {
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock: {
                decrement: item.quantity,
              },
            },
          });
        }

        // Delete order items first (to avoid foreign key constraint)
        await tx.orderItem.deleteMany({
          where: { orderId: id },
        });

        // Delete the order
        await tx.order.delete({
          where: { id },
        });

        return newSale;
      });

      return res.status(200).json({
        success: true,
        message: "Order completed and converted to sale",
        data: sale,
      });
    }

    // For other status updates (CANCELLED), just update the order
    const updatedOrder = await prisma.order.update({
      where: { id },
      data: { status },
      include: {
        orderItems: {
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

    return res.status(200).json({
      success: true,
      message: `Order status updated to ${status}`,
      data: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating order status:", error);
    console.error("Error details:", error.message);
    if (error.code) console.error("Error code:", error.code);
    if (error.meta) console.error("Error meta:", error.meta);
    res.status(500).json({
      success: false,
      message: "Internal server error: " + error.message,
    });
  }
});

// Generate receipt data for order (used by frontend ReceiptModal) - use stored breakdown
router.post("/:id/receipt", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        orderItems: {
          include: {
            product: true
          }
        },
        table: true,
        user: {
          select: { name: true }
        }
      }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    // Use stored breakdown values (prioritize), fallback to recompute
    let subtotal = 0;
    let foodSubtotal = order.foodSubtotal || 0;
    let nonFoodSubtotal = order.nonFoodSubtotal || 0;
    let discount = order.discount || 0;
    let serviceCharge = order.serviceCharge || 0;
    let total = order.totalAmount || 0; // Use stored computed total
    const customerType = order.customerType || 'REGULAR';
    const items = [];
    const tendered = order.amountTendered || 0;
    const changeDue = order.change || 0;

    // Always compute items and subtotal for display
    for (const item of order.orderItems) {
      const itemTotal = item.price * item.quantity;
      subtotal += itemTotal;
      items.push({
        name: item.product.name,
        quantity: item.quantity,
        price: item.price,
        total: itemTotal
      });
    }

    const receiptData = {
      orderNumber: order.orderNumber,
      orderId: order.id,
      date: new Date(order.createdAt).toLocaleString('en-US', { 
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      table: order.table?.number || 'N/A',
      cashier: req.user?.name || 'Cashier',
      customerType,
      subtotal: parseFloat(subtotal.toFixed(2)),
      foodSubtotal: parseFloat(foodSubtotal.toFixed(2)),
      nonFoodSubtotal: parseFloat(nonFoodSubtotal.toFixed(2)),
      discount: parseFloat(discount.toFixed(2)),
      serviceCharge: parseFloat(serviceCharge.toFixed(2)),
      total: parseFloat(total.toFixed(2)),
      tendered,
      change: changeDue,
      items
    };

    res.status(200).json({
      success: true,
      data: receiptData
    });
  } catch (error) {
    console.error("Receipt generation error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate receipt data"
    });
  }
});

export default router;
