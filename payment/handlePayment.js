import { MercadoPagoService } from '../lib/mercadopago.js';

export class PaymentHandler {
  /**
   * Generate QR code payment for ticket purchase
   * @param {Object} paymentData - Payment information
   * @returns {Promise<Object>} QR code data and payment info
   */
  static async generateQRCodePayment(paymentData) {
    const {
      eventAddress,
      tierIndex,
      priceBRLCents,
      userName,
      userEmail,
      tierName,
      eventName
    } = paymentData;

    // Generate unique external reference for tracking
    const externalReference = `TICKET_${eventAddress}_${tierIndex}_${Date.now()}`;
    
    const amount = parseFloat((priceBRLCents / 100).toFixed(2));
    const description = `Ingresso: ${eventName} - ${tierName}`;

    try {
      const qrCodeData = await MercadoPagoService.createQRCodeOrder(
        amount,
        description,
        externalReference
      );

      return {
        ...qrCodeData,
        externalReference,
        paymentStatus: 'pending',
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Payment generation error:', error);
      throw error;
    }
  }

  /**
   * Verify payment status and process ticket if paid
   * @param {string} externalReference - External reference from QR code order
   * @returns {Promise<Object>} Payment verification result
   */
  static async verifyAndProcessPayment(externalReference) {
    try {
      const order = await MercadoPagoService.findOrderByExternalReference(externalReference);
      
      if (!order) {
        return { status: 'not_found', paid: false };
      }

      const paymentStatus = order.status;
      const isPaid = paymentStatus === 'paid';
      
      return {
        status: paymentStatus,
        paid: isPaid,
        orderId: order.id,
        transactionAmount: order.transaction_amount,
        currency: order.currency_id,
        lastUpdated: order.last_updated,
      };
    } catch (error) {
      console.error('Payment verification error:', error);
      throw error;
    }
  }

  /**
   * Poll payment status until confirmed or timeout
   * @param {string} externalReference - External reference to poll
   * @param {number} timeoutMs - Timeout in milliseconds (default: 15 minutes)
   * @param {number} intervalMs - Polling interval in milliseconds (default: 5 seconds)
   */
  static async pollPaymentStatus(externalReference, timeoutMs = 15 * 60 * 1000, intervalMs = 5000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const pollInterval = setInterval(async () => {
        try {
          const paymentStatus = await this.verifyAndProcessPayment(externalReference);
          
          if (paymentStatus.paid) {
            clearInterval(pollInterval);
            resolve({ status: 'paid', data: paymentStatus });
            return;
          }
          
          if (paymentStatus.status === 'cancelled' || paymentStatus.status === 'expired') {
            clearInterval(pollInterval);
            resolve({ status: 'failed', data: paymentStatus });
            return;
          }
          
          // Check timeout
          if (Date.now() - startTime > timeoutMs) {
            clearInterval(pollInterval);
            resolve({ status: 'timeout', data: paymentStatus });
            return;
          }
        } catch (error) {
          clearInterval(pollInterval);
          reject(error);
        }
      }, intervalMs);
    });
  }
}
