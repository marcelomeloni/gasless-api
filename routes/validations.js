// routes/validations.js
import express from 'express';
import { validateById, validateByIdWithFrontendSignature,getTicketInfo,checkEventValidatorStatus, getValidatedTickets } from '../controllers/validationController.js';

const router = express.Router();

router.post('/validate-by-id/:registrationId', validateById);
router.post('/validate-by-id-frontend/:registrationId', validateByIdWithFrontendSignature);
router.get('/event/:eventAddress/validated-tickets', getValidatedTickets);
router.get('/ticket-info/:registrationId', getTicketInfo);
router.get('/event-status/:eventAddress/:validatorAddress', checkEventValidatorStatus);
export default router;
