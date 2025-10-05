import express from 'express';
import { validateById, getValidatedTickets } from '../controllers/validationController.js';

const router = express.Router();

router.post('/validate-by-id/:registrationId', validateById);
router.get('/event/:eventAddress/validated-tickets', getValidatedTickets);

export default router;
