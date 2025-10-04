import mercadopago from 'mercadopago';

// Configure Mercado Pago with your credentials
mercadopago.configure({
  access_token: process.env.MERCADOPAGO_ACCESS_TOKEN,
  sandbox: process.env.NODE_ENV !== 'production', // Use sandbox for testing
});

export class MercadoPagoService {
  /**
   * Create a QR code order for in-person payments
   * @param {number} amount - Amount in BRL
   * @param {string} description - Order description
   * @param {string} externalReference - Your internal reference ID
   * @returns {Promise<Object>} QR code data and order info
   */
  static async createQRCodeOrder(amount, description, externalReference) {
    try {
      const orderData = {
        external_reference: externalReference,
        title: description,
        description: description,
        notification_url: `${process.env.API_URL}/webhooks/mercadopago`,
        total_amount: amount,
        items: [
          {
            sku_number: 'TICKET001',
            category: 'event_tickets',
            title: description,
            unit_price: amount,
            quantity: 1,
            unit_measure: 'unit',
            total_amount: amount,
          },
        ],
        payments: [
          {
            payment_type: 'qr',
          },
        ],
      };

      const response = await mercadopago.orders.create(orderData);
      
      return {
        success: true,
        orderId: response.body.id,
        qrCode: response.body.qr_data,
        qrCodeImage: response.body.qr_code_base64,
        transactionAmount: response.body.transaction_amount,
        expirationDate: response.body.date_of_expiration,
      };
    } catch (error) {
      console.error('Error creating Mercado Pago order:', error);
      throw new Error(`Failed to create QR code order: ${error.message}`);
    }
  }

  /**
   * Get order status by ID
   * @param {string} orderId - Mercado Pago order ID
   */
  static async getOrderStatus(orderId) {
    try {
      const response = await mercadopago.orders.get(orderId);
      return response.body;
    } catch (error) {
      console.error('Error fetching order status:', error);
      throw new Error(`Failed to get order status: ${error.message}`);
    }
  }

  /**
   * Verify payment status by external reference
   * @param {string} externalReference - Your internal reference ID
   */
  static async findOrderByExternalReference(externalReference) {
    try {
      const filters = {
        external_reference: externalReference
      };
      
      const response = await mercadopago.orders.search({
        qs: filters
      });
      
      return response.body.results[0]; // Return first matching order
    } catch (error) {
      console.error('Error searching order:', error);
      throw new Error(`Failed to find order: ${error.message}`);
    }
  }
}
