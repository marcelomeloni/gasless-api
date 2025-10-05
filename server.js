import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';

// Importar rotas modularizadas
import paymentRoutes from './routes/payments.js';
import eventRoutes from './routes/events.js';
import ticketRoutes from './routes/tickets.js';
import validationRoutes from './routes/validations.js';

// Importar serviços para inicialização
import './services/solanaService.js';
import './services/supabaseService.js';
import './services/mercadoPagoService.js';

// --- INITIAL SETUP ---
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage() });

// Registrar rotas modularizadas
app.use('/api/payments', paymentRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/validations', validationRoutes);

// Webhook do Mercado Pago (mantido no app principal)
import { activePaymentSessions } from './controllers/paymentController.js';
import { getPayment } from './services/mercadoPagoService.js';

app.post('/webhooks/mercadopago', async (req, res) => {
    try {
        const { type, data } = req.body;
        
        if (type === 'payment') {
            const paymentId = data.id;
            console.log(`[Webhook] Received payment update for ID: ${paymentId}`);
            
            // Get payment details
            const payment = await getPayment(paymentId);
            const externalReference = payment.external_reference;
            
            if (payment.status === 'approved' && externalReference) {
                const paymentSession = activePaymentSessions.get(externalReference);
                
                if (paymentSession && paymentSession.status === 'pending') {
                    console.log(`[Webhook] Processing paid ticket for: ${externalReference}`);
                    
                    // Update session status
                    paymentSession.status = 'paid';
                    paymentSession.paymentId = paymentId;
                    activePaymentSessions.set(externalReference, paymentSession);
                }
            }
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Error processing webhook');
    }
});

// Rota de health check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        services: {
            solana: 'connected',
            supabase: 'connected',
            mercadoPago: 'configured'
        }
    });
});

// Rota raiz
app.get('/', (req, res) => {
    res.json({ 
        message: 'Gasless Ticketing API', 
        version: '1.0.0',
        endpoints: {
            payments: '/api/payments',
            events: '/api/events', 
            tickets: '/api/tickets',
            validations: '/api/validations'
        }
    });
});

// --- SERVER INITIALIZATION ---
app.listen(PORT, () => {
    console.log(`🚀 Gasless server running on port ${PORT}`);
    console.log(`📊 Health check available at: http://localhost:${PORT}/health`);
});
