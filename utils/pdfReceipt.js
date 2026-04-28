import PDFDocument from 'pdfkit';

export async function generateReceiptPDF(res, receiptData) {
  res.setHeader('Content-Type', 'application/pdf');
res.setHeader('Content-Disposition', `attachment; filename="Receipt-${receiptData.orderNumber || receiptData.orderId}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  // Store Header
  doc.fontSize(24).font('Helvetica-Bold').text('Gulp Course POS', 72, 72, { align: 'center' });
  doc.fontSize(12).text('Restaurant & Bar', 72, 110, { align: 'center' });

  // Receipt Details
  let y = 160;
doc.fontSize(11).text(`Receipt #: ${receiptData.orderNumber || receiptData.orderId}`, 72, y);
  doc.text(`Table: ${receiptData.table}`, 72, y += 20);
  doc.text(`Date/Time: ${receiptData.date}`, 72, y += 20);
  doc.text(`Cashier: ${receiptData.cashier}`, 72, y += 20);
  doc.text(`Customer: ${receiptData.customerType}`, 72, y += 20);

  // Items Table Header
  y += 30;
  doc.font('Helvetica-Bold').fontSize(10)
    .text('ITEM', 72, y)
    .text('QTY', 300, y, { width: 40, align: 'center' })
    .text('PRICE', 360, y, { width: 60, align: 'right' })
    .text('TOTAL', 440, y, { width: 80, align: 'right' });

  // Divider
  doc.lineWidth(0.5).moveTo(72, y + 8).lineTo(550, y + 8).stroke();
  y += 20;

  // Items
  receiptData.items.forEach(item => {
    const priceStr = `₱${item.price.toFixed(2)}`;
    const totalStr = `₱${item.total.toFixed(2)}`;
    doc.fontSize(10).text(item.name.substring(0, 22), 72, y, { width: 220, lineGap: 2 })
      .text(item.quantity.toString(), 300, y, { width: 40, align: 'center' })
      .text(priceStr, 360, y, { width: 60, align: 'right' })
      .text(totalStr, 440, y, { width: 80, align: 'right' });
    y += 25;
  });

  // Final Divider
  doc.lineWidth(1).moveTo(72, y + 5).lineTo(550, y + 5).stroke();
  y += 25;

  // Totals Section
  const formatCurrency = (amount) => `₱${Math.abs(amount).toFixed(2)}`;
  doc.fontSize(11)
    .text(`Subtotal:`, 72, y).text(formatCurrency(receiptData.subtotal), 440, y, { align: 'right', width: 140 });
  y += 20;
  if (receiptData.foodSubtotal > 0 && receiptData.nonFoodSubtotal > 0) {
    doc.text(`Food:`, 72, y).text(formatCurrency(receiptData.foodSubtotal), 440, y, { align: 'right', width: 140 });
    y += 20;
    doc.text(`Non-Food:`, 72, y).text(formatCurrency(receiptData.nonFoodSubtotal), 440, y, { align: 'right', width: 140 });
    y += 20;
  }
  if (receiptData.discount > 0) {
    doc.text(`Discount:`, 72, y).text(`-${formatCurrency(receiptData.discount)}`, 440, y, { align: 'right', width: 140 });
    y += 25;
  }
  doc.text(`Service Charge:`, 72, y).text(formatCurrency(receiptData.serviceCharge), 440, y, { align: 'right', width: 140 });
  y += 30;

  // Total bold
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#D32F2F')
    .text('TOTAL AMOUNT:', 72, y).text(formatCurrency(receiptData.total), 440, y, { align: 'right' });
  y += 35;

  // Payment
  doc.fillColor('#000').fontSize(11)
    .text('Tendered:', 72, y).text(formatCurrency(receiptData.tendered), 440, y, { align: 'right' });
  y += 25;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#388E3C')
    .text('CHANGE:', 72, y).text(formatCurrency(receiptData.change), 440, y, { align: 'right' });

  // Footer
  y += 60;
  doc.lineWidth(1).moveTo(72, y).lineTo(550, y).stroke();
  y += 20;
  doc.fontSize(9).text('Thank you for dining with us!', { align: 'center' })
    .text('Gulp Course POS - v1.0', { align: 'center' });

  doc.end();
}
