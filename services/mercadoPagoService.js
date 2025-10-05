import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { MERCADOPAGO_ACCESS_TOKEN } from '../config/index.js';

const client = new MercadoPagoConfig({ 
    accessToken: MERCADOPAGO_ACCESS_TOKEN,
    options: { timeout: 5000 }
});

console.log(`[+] Mercado Pago configured.`);

export const createPreference = async (preferenceData) => {
    const preferenceClient = new Preference(client);
    return await preferenceClient.create({ body: preferenceData });
};

export const searchPayments = async (filters) => {
    const paymentClient = new Payment(client);
    return await paymentClient.search({ qs: filters });
};

export const getPayment = async (paymentId) => {
    const paymentClient = new Payment(client);
    return await paymentClient.get({ id: paymentId });
};

export { Payment, Preference };
