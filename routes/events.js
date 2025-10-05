// routes/events.js
import express from 'express';
import multer from 'multer';
import { 
    createFullEvent, 
    getEventForManagement, 
    getActiveEvents, 
    getEventDetails,
    sendSignedTransaction // ✅ ADICIONE ESTA IMPORT
} from '../controllers/eventController.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post(
    '/create-full-event',
    upload.fields([
        { name: 'image', maxCount: 1 },
        { name: 'organizerLogo', maxCount: 1 }
    ]),
    createFullEvent
);

router.get('/active', getActiveEvents);
router.get('/:eventAddress', getEventDetails);
router.get('/manage/:eventAddress/:userPublicKey', getEventForManagement);
router.post('/send-signed-transaction', sendSignedTransaction); // ✅ CORRIGIDO

export default router;
