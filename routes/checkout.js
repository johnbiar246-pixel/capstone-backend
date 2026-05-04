import express from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";

const prisma = new PrismaClient();
const router = express.Router();

// Unified checkout endpoint - creates Order + Sale atomically
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
          status: "PREPARING",
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
          ...(userId && { user: { connect: { id: userId } } }),
          ...(tableId && { table: { connect: { id: String(tableId) } } }),
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
      message: "Checkout completed successfully",
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
    console.error("Checkout error:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Checkout failed",
    });
  }
});

export default router;
