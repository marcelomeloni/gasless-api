// routes/events.js
import express from 'express';
import multer from 'multer';
import { 
    createFullEvent, 
    getEventForManagement, 
    getActiveEvents, 
    getEventDetails,
    getNextFourEvents,
    sendSignedTransaction,
 getEventFromSupabase,
    addValidatorGasless,
    getEventDetailsFast,
    getEventsForManagementFast,
    getActiveEventsFast,
    cancelEventGasless,
    removeValidatorGasless
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
router.get('/supabase/:eventAddress', getEventFromSupabase);
router.get('/active/next-four', getNextFourEvents);
router.get('/active/fast', getActiveEventsFast);
router.get('/:eventAddress/fast', getEventDetailsFast);
router.get('/manage/fast/:userPublicKey', getEventsForManagementFast);
router.get('/active', getActiveEvents);
router.get('/:eventAddress', getEventDetails);
router.get('/manage/:eventAddress/:userPublicKey', getEventForManagement);
router.post('/send-signed-transaction', sendSignedTransaction); 
router.post('/:eventAddress/validators/add', addValidatorGasless);
router.post('/:eventAddress/validators/remove', removeValidatorGasless);
router.post('/:eventAddress/cancel', cancelEventGasless);

export default router;
