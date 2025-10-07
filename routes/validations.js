// routes/validations.js
import express from 'express';
import { validateById, validateByIdWithFrontendSignature, getValidatedTickets } from '../controllers/validationController.js';

const router = express.Router();

router.post('/validate-by-id/:registrationId', validateById);
router.post('/validate-by-id-frontend/:registrationId', validateByIdWithFrontendSignature);
router.get('/event/:eventAddress/validated-tickets', getValidatedTickets);

export default router;
