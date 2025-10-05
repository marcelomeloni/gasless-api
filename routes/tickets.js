import express from 'express';
import { 
    generateWalletAndMint, 
    generateWalletAndMintPaid, 
    mintForExistingUser, 
    getTicketData, 
    getUserTickets,
    checkOrganizerPermission
} from '../controllers/ticketController.js';

const router = express.Router();

router.post('/generate-wallet-and-mint', generateWalletAndMint);
router.post('/generate-wallet-and-mint-paid', generateWalletAndMintPaid);
router.post('/mint-for-existing-user', mintForExistingUser);
router.get('/ticket-data/:mintAddress', getTicketData);
router.get('/user-tickets/:ownerAddress', getUserTickets);
router.get('/check-organizer-permission/:walletAddress', checkOrganizerPermission);

export default router;
