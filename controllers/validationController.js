import { program, getAssociatedTokenAddress, PublicKey } from '../services/solanaService.js';
import supabase from '../services/supabaseService.js';
import anchor from '@coral-xyz/anchor';

// Função auxiliar para validar UUID
function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

// Função para parsear erro do Anchor de forma segura
function parseAnchorError(error) {
    try {
        if (error.logs) {
            const anchorError = anchor.AnchorError.parse(error.logs);
            return anchorError ? anchorError.error.errorMessage : error.message;
        }
        return error.message;
    } catch (parseError) {
        console.error('Erro ao parsear Anchor error:', parseError);
        return error.message;
    }
}

export const validateById = async (req, res) => {
    const { registrationId } = req.params;
    const { validatorAddress } = req.body;

    console.log(`[VALIDATION] Iniciando validação para: ${registrationId}`);
    console.log(`[VALIDATION] Validador: ${validatorAddress}`);

    // Validações iniciais robustas
    if (!registrationId || !validatorAddress) {
        console.error('[VALIDATION] Parâmetros faltando:', { registrationId, validatorAddress });
        return res.status(400).json({ 
            success: false, 
            error: "ID do registro e endereço do validador são obrigatórios." 
        });
    }

    // Validação de UUID
    if (!isValidUUID(registrationId)) {
        console.error('[VALIDATION] UUID inválido:', registrationId);
        return res.status(400).json({ 
            success: false, 
            error: "ID do registro em formato inválido." 
        });
    }

    // Validação do endereço do validador
    try {
        new PublicKey(validatorAddress);
    } catch (error) {
        console.error('[VALIDATION] Endereço do validador inválido:', validatorAddress);
        return res.status(400).json({ 
            success: false, 
            error: "Endereço do validador inválido." 
        });
    }

    try {
        // 1. BUSCAR REGISTRO NO SUPABASE
        console.log(`[1/6] Buscando registro no Supabase...`);
        const { data: registration, error: dbError } = await supabase
            .from('registrations')
            .select('*')
            .eq('id', registrationId)
            .single();

        if (dbError) {
            console.error('[VALIDATION] Erro no Supabase:', dbError);
            return res.status(500).json({ 
                success: false, 
                error: "Erro ao acessar banco de dados." 
            });
        }

        if (!registration) {
            console.error('[VALIDATION] Registro não encontrado:', registrationId);
            return res.status(404).json({ 
                success: false, 
                error: "Ingresso não encontrado." 
            });
        }

        console.log(`[2/6] Registro encontrado:`, {
            event: registration.event_address,
            mint: registration.mint_address,
            name: registration.registration_details?.name
        });

        const { event_address, mint_address, registration_details } = registration;
        const participantName = registration_details?.name || 'Participante';

        // 2. VALIDAR ENDEREÇOS
        console.log(`[3/6] Validando endereços...`);
        let eventPubkey, nftMintPubkey, validatorPubkey;
        
        try {
            eventPubkey = new PublicKey(event_address);
            nftMintPubkey = new PublicKey(mint_address);
            validatorPubkey = new PublicKey(validatorAddress);
        } catch (error) {
            console.error('[VALIDATION] Erro ao criar PublicKeys:', error);
            return res.status(400).json({ 
                success: false, 
                error: "Endereços do evento ou NFT inválidos." 
            });
        }

        // 3. VERIFICAR SE VALIDADOR É AUTORIZADO
        console.log(`[4/6] Verificando permissões do validador...`);
        let eventAccount;
        try {
            eventAccount = await program.account.event.fetch(eventPubkey);
            const isValidator = eventAccount.validators.some(v => v.equals(validatorPubkey));
            
            if (!isValidator) {
                console.warn(`[VALIDATION] Validador não autorizado: ${validatorAddress}`);
                return res.status(403).json({ 
                    success: false, 
                    error: "Acesso negado. Esta carteira não é um validador autorizado." 
                });
            }
        } catch (error) {
            console.error('[VALIDATION] Erro ao buscar conta do evento:', error);
            return res.status(404).json({ 
                success: false, 
                error: "Evento não encontrado na blockchain." 
            });
        }

        console.log(`[VALIDATION] Validador ${validatorAddress} autorizado.`);

        // 4. BUSCAR INGRESSO ON-CHAIN
        console.log(`[5/6] Buscando ingresso on-chain...`);
        const TICKET_NFT_MINT_FIELD_OFFSET = 40;
        let tickets;
        try {
            tickets = await program.account.ticket.all([
                { memcmp: { offset: TICKET_NFT_MINT_FIELD_OFFSET, bytes: nftMintPubkey.toBase58() } }
            ]);
        } catch (error) {
            console.error('[VALIDATION] Erro ao buscar tickets:', error);
            return res.status(500).json({ 
                success: false, 
                error: "Erro ao buscar ingresso na blockchain." 
            });
        }

        if (tickets.length === 0) {
            console.error('[VALIDATION] Ingresso on-chain não encontrado para mint:', mint_address);
            return res.status(404).json({ 
                success: false, 
                error: "Ingresso não encontrado na blockchain." 
            });
        }

        const ticketAccount = tickets[0];
        
        // 5. VERIFICAR SE JÁ FOI VALIDADO
        if (ticketAccount.account.redeemed) {
            console.warn(`[VALIDATION] Tentativa de validação dupla: ${mint_address}`);
            return res.status(409).json({ 
                success: false, 
                error: "Este ingresso já foi utilizado." 
            });
        }

        const ownerPubkey = ticketAccount.account.owner;
        console.log(`[VALIDATION] Ingresso on-chain encontrado. Dono: ${ownerPubkey.toString()}`);

        // 6. EXECUTAR VALIDAÇÃO ON-CHAIN
        console.log(`[6/6] Executando transação de validação...`);
        const [ticketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("ticket"), eventPubkey.toBuffer(), nftMintPubkey.toBuffer()], 
            program.programId
        );
        
        const nftTokenAccount = await getAssociatedTokenAddress(nftMintPubkey, ownerPubkey);

        const signature = await program.methods.redeemTicket().accounts({ 
            ticket: ticketPda, 
            event: eventPubkey, 
            validator: validatorPubkey, 
            owner: ownerPubkey, 
            nftToken: nftTokenAccount, 
            nftMint: nftMintPubkey 
        }).rpc();
        
        console.log(`[SUCCESS] Ingresso validado! Assinatura: ${signature}`);
        console.log(`[SUCCESS] Participante: ${participantName}`);

        res.status(200).json({ 
            success: true, 
            signature,
            participantName: participantName
        });

    } catch (error) {
        console.error("[ERROR] Erro durante a validação:", error);
        
        const errorMessage = parseAnchorError(error);
        console.error("[ERROR] Mensagem de erro detalhada:", errorMessage);

        res.status(500).json({ 
            success: false, 
            error: "Erro do servidor durante a validação.",
            details: errorMessage
        });
    }
};

export const getValidatedTickets = async (req, res) => {
    const { eventAddress } = req.params;
    
    if (!eventAddress) {
        return res.status(400).json({ error: "Event address is required." });
    }

    console.log(`[TICKETS] Buscando ingressos validados para evento: ${eventAddress}`);

    try {
        const eventPubkey = new PublicKey(eventAddress);
        
        // Buscar todos os tickets do evento
        const allTicketsForEvent = await program.account.ticket.all([
            { memcmp: { offset: 8, bytes: eventPubkey.toBase58() } }
        ]);
        
        console.log(`[TICKETS] Total de tickets encontrados: ${allTicketsForEvent.length}`);
        
        // Filtrar apenas os validados
        const redeemedTickets = allTicketsForEvent.filter(ticket => ticket.account.redeemed);
        console.log(`[TICKETS] Tickets validados: ${redeemedTickets.length}`);

        if (redeemedTickets.length === 0) {
            return res.status(200).json([]);
        }

        // Buscar nomes dos participantes
        const ownerAddresses = redeemedTickets.map(ticket => ticket.account.owner.toString());
        console.log(`[TICKETS] Buscando perfis para: ${ownerAddresses.length} endereços`);
        
        const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('wallet_address, name')
            .in('wallet_address', ownerAddresses);

        if (profilesError) {
            console.error('[TICKETS] Erro ao buscar perfis:', profilesError);
        }

        const profilesMap = new Map();
        if (profiles) {
            profiles.forEach(p => profilesMap.set(p.wallet_address, p.name));
        }

        // Formatar resposta
        const validatedEntries = redeemedTickets.map(ticket => {
            const ownerAddress = ticket.account.owner.toString();
            return {
                owner: ownerAddress,
                name: profilesMap.get(ownerAddress) || 'Participante',
                redeemedAt: new Date(ticket.account.redeemedAt * 1000).toLocaleTimeString('pt-BR', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                }),
                nftMint: ticket.account.nftMint.toString(),
            };
        });

        console.log(`[TICKETS] Retornando ${validatedEntries.length} entradas validadas`);
        res.status(200).json(validatedEntries.reverse());

    } catch (error) {
        console.error("[ERROR] Erro ao buscar tickets validados:", error);
        res.status(500).json({ 
            error: "Erro ao buscar tickets validados.", 
            details: error.message 
        });
    }
};
