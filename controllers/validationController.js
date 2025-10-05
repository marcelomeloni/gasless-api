import { program, getAssociatedTokenAddress, PublicKey } from '../services/solanaService.js';
import supabase from '../services/supabaseService.js';
import anchor from '@coral-xyz/anchor';

export const validateById = async (req, res) => {
    const { registrationId } = req.params;
    const { validatorAddress } = req.body;

    if (!registrationId || !validatorAddress) {
        return res.status(400).json({ success: false, error: "ID do registro e endereço do validador são obrigatórios." });
    }
    console.log(`[+] Iniciando validação para o registro: ${registrationId}`);

    try {
        const { data: registration, error: dbError } = await supabase
            .from('registrations')
            .select('*')
            .eq('id', registrationId)
            .single();

        if (dbError || !registration) {
            return res.status(404).json({ success: false, error: "Ingresso não encontrado (ID inválido)." });
        }

        const { event_address, mint_address, registration_details } = registration;
        const participantName = registration_details?.name || 'Participante';

        console.log(` -> Registro encontrado. Evento: ${event_address}, Mint: ${mint_address}`);

        const eventPubkey = new PublicKey(event_address);
        const nftMintPubkey = new PublicKey(mint_address);
        const validatorPubkey = new PublicKey(validatorAddress);

        const eventAccount = await program.account.event.fetch(eventPubkey);
        const isValidator = eventAccount.validators.some(v => v.equals(validatorPubkey));
        if (!isValidator) {
            console.warn(` -> TENTATIVA DE VALIDAÇÃO NEGADA: ${validatorAddress} não é um validador para este evento.`);
            return res.status(403).json({ success: false, error: "Acesso negado. Esta carteira não é um validador autorizado." });
        }
        console.log(` -> Validador ${validatorAddress} autorizado.`);

        const TICKET_NFT_MINT_FIELD_OFFSET = 40;
        const tickets = await program.account.ticket.all([
            { memcmp: { offset: TICKET_NFT_MINT_FIELD_OFFSET, bytes: nftMintPubkey.toBase58() } }
        ]);

        if (tickets.length === 0) {
            return res.status(404).json({ success: false, error: "Ingresso (on-chain) não encontrado." });
        }
        const ticketAccount = tickets[0];
        
        if (ticketAccount.account.redeemed) {
             console.warn(` -> TENTATIVA DE VALIDAÇÃO DUPLA: O ingresso ${mint_address} já foi validado.`);
             return res.status(409).json({ success: false, error: "Este ingresso já foi utilizado." });
        }

        const ownerPubkey = ticketAccount.account.owner;
        console.log(` -> Ingresso on-chain encontrado. Dono: ${ownerPubkey.toString()}`);

        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), nftMintPubkey.toBuffer()], program.programId);
        const nftTokenAccount = await getAssociatedTokenAddress(nftMintPubkey, ownerPubkey);

        const signature = await program.methods.redeemTicket().accounts({ 
            ticket: ticketPda, 
            event: eventPubkey, 
            validator: validatorPubkey, 
            owner: ownerPubkey, 
            nftToken: nftTokenAccount, 
            nftMint: nftMintPubkey 
        }).rpc();
        
        console.log(`[✔] Ingresso validado com sucesso! Assinatura: ${signature}`);

        res.status(200).json({ 
            success: true, 
            signature,
            participantName: participantName
        });

    } catch (error) {
        console.error("[✘] Erro durante a validação por ID:", error);
        const anchorError = anchor.AnchorError.parse(error.logs);
        const errorMessage = anchorError ? anchorError.error.errorMessage : error.message;
        res.status(500).json({ success: false, error: "Erro do servidor durante a validação.", details: errorMessage || "Erro desconhecido" });
    }
};

export const getValidatedTickets = async (req, res) => {
    const { eventAddress } = req.params;
    if (!eventAddress) return res.status(400).json({ error: "Event address is required." });

    try {
        const eventPubkey = new PublicKey(eventAddress);
        const allTicketsForEvent = await program.account.ticket.all([{ memcmp: { offset: 8, bytes: eventPubkey.toBase58() } }]);
        const redeemedTickets = allTicketsForEvent.filter(ticket => ticket.account.redeemed);

        if (redeemedTickets.length === 0) return res.status(200).json([]);

        const ownerAddresses = redeemedTickets.map(ticket => ticket.account.owner.toString());
        
        const { data: profiles } = await supabase.from('profiles').select('wallet_address, name').in('wallet_address', ownerAddresses);
        
        const profilesMap = new Map(profiles.map(p => [p.wallet_address, p.name]));

        const validatedEntries = redeemedTickets.map(ticket => {
            const ownerAddress = ticket.account.owner.toString();
            return {
                owner: ownerAddress,
                name: profilesMap.get(ownerAddress) || null,
                redeemedAt: new Date(ticket.account.redeemedAt * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
                nftMint: ticket.account.nftMint.toString(),
            };
        });

        res.status(200).json(validatedEntries.reverse());
    } catch (error) {
        console.error("[✘] Error fetching validated tickets:", error);
        res.status(500).json({ error: "Server error fetching tickets.", details: error.message });
    }
};
