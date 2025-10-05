import express from 'express';
import { 
    generatePaymentQR, 
    checkPaymentStatus, 
    processPaidTicket,
    activePaymentSessions 
} from '../controllers/paymentController.js';

const router = express.Router();

router.post('/generate-payment-qr', generatePaymentQR);
router.get('/payment-status/:externalReference', checkPaymentStatus);
router.post('/process-paid-ticket', processPaidTicket);

export { activePaymentSessions };
export default router;
