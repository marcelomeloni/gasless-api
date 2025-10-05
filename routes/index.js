import express from 'express';
import paymentRoutes from './payment/paymentRoutes.js';
// Importar outras rotas conforme criar

const router = express.Router();

// Aqui você pode agrupar todas as rotas
router.use('/payment', paymentRoutes);
// router.use('/events', eventRoutes);
// router.use('/tickets', ticketRoutes);

export default router;
