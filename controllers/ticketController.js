import { createHash } from 'crypto';
import bip39 from 'bip39';
import anchor from '@coral-xyz/anchor';
import { supabase } from '../services/supabaseService.js';
import { sendTicketEmail } from '../services/emailService.js';
import { saveRegistrationData } from '../services/supabaseService.js';
import { 
    program, 
    payerKeypair, 
    SystemProgram, 
    getAssociatedTokenAddress, 
    TOKEN_PROGRAM_ID, 
    ASSOCIATED_TOKEN_PROGRAM_ID, 
    SYSVAR_RENT_PUBKEY, 
    TOKEN_METADATA_PROGRAM_ID,
    Keypair,
    PublicKey,
    getKeypairFromMnemonic,
    bs58,
    connection
} from '../services/solanaService.js';

export const processPaidTicketForNewUser = async ({ 
    eventAddress, 
    tierIndex, 
    formData, 
    priceBRLCents, 
    userEmail, 
    userName
}) => {
    try {
        const { name, phone, email, company, sector, role } = formData;

        // 1. Geração da nova carteira para o usuário
        const mnemonic = bip39.generateMnemonic();
        const newUserKeypair = getKeypairFromMnemonic(mnemonic);
        const newUserPublicKey = newUserKeypair.publicKey;
        const privateKey = bs58.encode(newUserKeypair.secretKey);
        
        // 2. Lógica on-chain para mintar o ingresso
        const eventPubkey = new PublicKey(eventAddress);
        const eventAccount = await program.account.event.fetch(eventPubkey);

        const userDataString = [name, phone, email, company, sector, role].map(s => (s || "").trim()).join('|');
        const dataHash = createHash('sha256').update(userDataString).digest();
        
        // Registrar usuário on-chain
        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), newUserPublicKey.toBuffer()], program.programId);
        await program.methods.registerUser(Array.from(dataHash)).accounts({
            authority: newUserPublicKey, userProfile: userProfilePda,
            payer: payerKeypair.publicKey, systemProgram: SystemProgram.programId,
        }).rpc();

        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync([Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), newUserPublicKey.toBuffer()], program.programId);
        await program.methods.createBuyerCounter().accounts({
            payer: payerKeypair.publicKey, event: eventPubkey, buyer: newUserPublicKey,
            buyerTicketCount: buyerTicketCountPda, systemProgram: SystemProgram.programId
        }).rpc();
        
        const mintKeypair = Keypair.generate();
        const mintAddress = mintKeypair.publicKey.toString();
        
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, newUserPublicKey);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);

        const signature = await program.methods.mintTicket(tierIndex).accounts({
            globalConfig: globalConfigPda, event: eventPubkey, payer: payerKeypair.publicKey, buyer: newUserPublicKey,
            mintAccount: mintKeypair.publicKey, ticket: ticketPda, buyerTicketCount: buyerTicketCountPda,
            associatedTokenAccount, metadataAccount: metadataPda, metadataProgram: TOKEN_METADATA_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        }).signers([payerKeypair, mintKeypair]).rpc();
        
        console.log(`[✔] Paid ticket minted successfully! Sig: ${signature}`);
        
        // 3. Salva tudo no banco de dados
        const registrationId = await saveRegistrationData({
            eventAddress,
            wallet_address: newUserPublicKey.toString(),
            mint_address: mintAddress,
            name, phone, email, company, sector, role
        });

        // 4. Envio de e-mail
        if (email) {
            try {
                const metadataResponse = await fetch(eventAccount.metadataUri);
                const metadata = await metadataResponse.json();
                const ticketDataForEmail = {
                    eventName: metadata.name, 
                    eventDate: metadata.properties.dateTime.start,
                    eventLocation: metadata.properties.location, 
                    mintAddress: mintAddress,
                    seedPhrase: mnemonic, 
                    privateKey: privateKey, 
                    eventImage: metadata.image,
                    registrationId: registrationId,
                    isPaid: true,
                    paymentAmount: (priceBRLCents / 100).toFixed(2)
                };
                const emailResult = await sendTicketEmail({ name, email }, ticketDataForEmail);
if (!emailResult.success) {
    console.error("Falha no envio de e-mail, mas o mint foi bem-sucedido:", emailResult.error);
}
            } catch(e) {
                console.error("Falha ao enviar e-mail (mas o mint funcionou):", e);
            }
        }

        return {
            success: true, 
            publicKey: newUserPublicKey.toString(), 
            seedPhrase: mnemonic, 
            privateKey: privateKey, 
            mintAddress: mintAddress, 
            signature,
            registrationId: registrationId,
            isPaid: true
        };

    } catch (error) {
        console.error("[✘] Error during paid ticket processing:", error);
        throw error;
    }
};

export const generateWalletAndMint = async (req, res) => {
    const { eventAddress, tierIndex, name, phone, email, company, sector, role, priceBRLCents } = req.body;
    if (!eventAddress || tierIndex === undefined || !name || !phone) {
        return res.status(400).json({ error: "Parâmetros de evento e cadastro são necessários." });
    }
    console.log(`[+] Starting full onboarding for user: ${name}`);

    try {
        // 1. Geração da nova carteira para o usuário
        const mnemonic = bip39.generateMnemonic();
        const newUserKeypair = getKeypairFromMnemonic(mnemonic);
        const newUserPublicKey = newUserKeypair.publicKey;
        const privateKey = bs58.encode(newUserKeypair.secretKey);
        
        // 2. Lógica on-chain para mintar o ingresso
        const eventPubkey = new PublicKey(eventAddress);
        const eventAccount = await program.account.event.fetch(eventPubkey);

        const userDataString = [name, phone, email, company, sector, role].map(s => (s || "").trim()).join('|');
        const dataHash = createHash('sha256').update(userDataString).digest();
        
        // As chamadas para registrar usuário e criar contador on-chain permanecem as mesmas
        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), newUserPublicKey.toBuffer()], program.programId);
        await program.methods.registerUser(Array.from(dataHash)).accounts({
            authority: newUserPublicKey, userProfile: userProfilePda,
            payer: payerKeypair.publicKey, systemProgram: SystemProgram.programId,
        }).rpc();

        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync([Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), newUserPublicKey.toBuffer()], program.programId);
        await program.methods.createBuyerCounter().accounts({
            payer: payerKeypair.publicKey, event: eventPubkey, buyer: newUserPublicKey,
            buyerTicketCount: buyerTicketCountPda, systemProgram: SystemProgram.programId
        }).rpc();
        
        const mintKeypair = Keypair.generate();
        const mintAddress = mintKeypair.publicKey.toString();
        
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, newUserPublicKey);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);

        const signature = await program.methods.mintTicket(tierIndex).accounts({
            globalConfig: globalConfigPda, event: eventPubkey, payer: payerKeypair.publicKey, buyer: newUserPublicKey,
            mintAccount: mintKeypair.publicKey, ticket: ticketPda, buyerTicketCount: buyerTicketCountPda,
            associatedTokenAccount, metadataAccount: metadataPda, metadataProgram: TOKEN_METADATA_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        }).signers([payerKeypair, mintKeypair]).rpc();
        
        console.log(`[✔] Onboarding on-chain successful! Sig: ${signature}`);
        
        // 3. Salva tudo no banco de dados APÓS o mint e captura o ID do registro
        const registrationId = await saveRegistrationData({
            eventAddress,
            wallet_address: newUserPublicKey.toString(),
            mint_address: mintAddress,
            name, phone, email, company, sector, role
        });

        // 4. Envio de e-mail (lógica inalterada)
        if (email) {
            try {
                const metadataResponse = await fetch(eventAccount.metadataUri);
                const metadata = await metadataResponse.json();
                const ticketDataForEmail = {
                    eventName: metadata.name, 
                    eventDate: metadata.properties.dateTime.start,
                    eventLocation: metadata.properties.location, 
                    mintAddress: mintAddress,
                    seedPhrase: mnemonic, 
                    privateKey: privateKey, 
                    eventImage: metadata.image,
                    registrationId: registrationId,
                };
                const emailResult = await sendTicketEmail({ name, email }, ticketDataForEmail);
if (!emailResult.success) {
    console.error("Falha no envio de e-mail, mas o mint foi bem-sucedido:", emailResult.error);
}
            } catch(e) {
                console.error("Falha ao enviar e-mail (mas o mint funcionou):", e);
            }
        }

        // 5. Resposta final ao cliente, agora incluindo o registrationId
        res.status(200).json({ 
            success: true, 
            publicKey: newUserPublicKey.toString(), 
            seedPhrase: mnemonic, 
            privateKey: privateKey, 
            mintAddress: mintAddress, 
            signature,
            registrationId: registrationId
        });

    } catch (error) {
        console.error("[✘] Error during onboarding:", error);
        const anchorError = anchor.AnchorError.parse(error.logs);
        const errorMessage = anchorError ? anchorError.error.errorMessage : error.message;
        res.status(500).json({ 
            error: "Server error during onboarding.", 
            details: errorMessage || "Unknown error" 
        });
    }
};

export const generateWalletAndMintPaid = async (req, res) => {
    const { eventAddress, tierIndex, name, phone, email, company, sector, role, priceBRLCents, paymentMethod } = req.body;
    
    if (!eventAddress || tierIndex === undefined || !name || !phone) {
        return res.status(400).json({ error: "Parâmetros de evento e cadastro são necessários." });
    }
    
    if (paymentMethod !== 'pix') {
        return res.status(400).json({ error: "Método de pagamento deve ser PIX." });
    }

    console.log(`[+] Starting paid onboarding for user: ${name}`);

    try {
        const result = await processPaidTicketForNewUser({
            eventAddress,
            tierIndex,
            formData: { name, phone, email, company, sector, role },
            priceBRLCents,
            userEmail: email,
            userName: name
        });

        res.status(200).json(result);

    } catch (error) {
        console.error("[✘] Error during paid onboarding:", error);
        const anchorError = anchor.AnchorError.parse(error.logs);
        const errorMessage = anchorError ? anchorError.error.errorMessage : error.message;
        res.status(500).json({ 
            error: "Server error during paid onboarding.", 
            details: errorMessage || "Unknown error" 
        });
    }
};

export const mintForExistingUser = async (req, res) => {
    const { eventAddress, buyerAddress, tierIndex, name, phone, email, company, sector, role } = req.body;
    if (!eventAddress || !buyerAddress || tierIndex === undefined) {
        return res.status(400).json({ error: "'eventAddress', 'buyerAddress', e 'tierIndex' são obrigatórios." });
    }
    console.log(`[+] Minting for existing user: ${buyerAddress}`);

    try {
        const eventPubkey = new PublicKey(eventAddress);
        const buyer = new PublicKey(buyerAddress);
        
        // 1. Lógica on-chain para mintar o ingresso PRIMEIRO
        const eventAccount = await program.account.event.fetch(eventPubkey);
        const selectedTier = eventAccount.tiers[tierIndex];
        if (!selectedTier) return res.status(400).json({ error: "Tier inválido." });

        // Garante que o perfil e o contador on-chain existem antes de mintar
        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), buyer.toBuffer()], program.programId);
        const userProfileAccount = await connection.getAccountInfo(userProfilePda);
        if (!userProfileAccount) {
            console.log(" -> Perfil on-chain não encontrado, criando...");
            const userDataString = [name, phone, email, company, sector, role].map(s => (s || "").trim()).join('|');
            const dataHash = createHash('sha256').update(userDataString).digest();
            await program.methods.registerUser(Array.from(dataHash)).accounts({
                authority: buyer, 
                userProfile: userProfilePda,
                payer: payerKeypair.publicKey, 
                systemProgram: SystemProgram.programId,
            }).rpc();
        }

        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync([Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), buyer.toBuffer()], program.programId);
        const accountInfo = await connection.getAccountInfo(buyerTicketCountPda);
        if (!accountInfo) {
            await program.methods.createBuyerCounter().accounts({
                payer: payerKeypair.publicKey, event: eventPubkey, buyer: buyer,
                buyerTicketCount: buyerTicketCountPda, systemProgram: SystemProgram.programId
            }).rpc();
        }
        
        const mintKeypair = Keypair.generate();
        const mintAddress = mintKeypair.publicKey.toString();
        
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, buyer);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);

        const signature = await program.methods.mintTicket(tierIndex).accounts({
            globalConfig: globalConfigPda, event: eventPubkey, payer: payerKeypair.publicKey, buyer: buyer,
            mintAccount: mintKeypair.publicKey, ticket: ticketPda, buyerTicketCount: buyerTicketCountPda,
            associatedTokenAccount, metadataAccount: metadataPda, metadataProgram: TOKEN_METADATA_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        }).signers([payerKeypair, mintKeypair]).rpc();

        console.log(`[✔] Mint on-chain bem-sucedido! Sig: ${signature}`);

        // 2. Salva tudo no banco de dados APÓS o mint e captura o ID do registro
        const registrationId = await saveRegistrationData({
            eventAddress,
            wallet_address: buyer.toString(),
            mint_address: mintAddress,
            name, phone, email, company, sector, role
        });

        // 3. Envio de e-mail (lógica inalterada)
        const triggerEmail = async () => {
            if (email) {
                try {
                    const metadataResponse = await fetch(eventAccount.metadataUri);
                    const metadata = await metadataResponse.json();
                    
                    const ticketDataForEmail = {
                        eventName: metadata.name, 
                        eventDate: metadata.properties.dateTime.start,
                        eventLocation: metadata.properties.location, 
                        mintAddress: mintAddress,
                        eventImage: metadata.image, 
                        eventDescription: metadata.description, 
                        eventCategory: metadata.category, 
                        eventTags: metadata.tags, 
                        organizerName: metadata.organizer.name, 
                        organizerLogo: metadata.organizer.organizerLogo, 
                        organizerWebsite: metadata.organizer.website,
                        registrationId: registrationId,
                    };
                    
                    const emailResult = await sendTicketEmail({ name, email }, ticketDataForEmail);
if (!emailResult.success) {
    console.error("Falha no envio de e-mail, mas o mint foi bem-sucedido:", emailResult.error);
}
                } catch (e) {
                    console.error("Falha ao preparar/enviar e-mail:", e);
                }
            }
        };

        triggerEmail();

        // 4. Resposta final ao cliente, agora incluindo o registrationId
        res.status(200).json({ 
            success: true, 
            isPaid: true, 
            signature, 
            mintAddress: mintAddress,
            registrationId: registrationId
        });

    } catch (error) {
        console.error("[✘] Erro ao mintar para usuário existente:", error);
        const anchorError = anchor.AnchorError.parse(error.logs);
        const errorMessage = anchorError ? anchorError.error.errorMessage : error.message;
        res.status(500).json({ 
            success: false, 
            error: "Erro do servidor ao mintar para usuário existente.", 
            details: errorMessage || "Erro desconhecido" 
        });
    }
};

export const getTicketData = async (req, res) => {
    const { mintAddress } = req.params;
    if (!mintAddress) return res.status(400).json({ error: "NFT mintAddress is required." });
    console.log(`[+] Fetching ticket data: ${mintAddress}`);

    try {
        const nftMint = new PublicKey(mintAddress);
        const tickets = await program.account.ticket.all([{ memcmp: { offset: 8 + 32, bytes: nftMint.toBase58() } }]);
        if (tickets.length === 0) return res.status(404).json({ error: "Ticket (NFT) not found." });

        const ticketAccount = tickets[0];
        const ownerPublicKey = ticketAccount.account.owner;
        const eventPublicKey = ticketAccount.account.event;

        let ownerName = null;
        try {
            const { data: profile } = await supabase.from('profiles').select('name').eq('wallet_address', ownerPublicKey.toString()).single();
            if (profile) ownerName = profile.name;
        } catch (e) { 
            console.warn(`-> Supabase profile not found for owner ${ownerPublicKey.toString()}`);
        }

        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), ownerPublicKey.toBuffer()], program.programId);
        let userProfile = null;
        try { 
            userProfile = await program.account.userProfile.fetch(userProfilePda); 
        } catch (e) { 
            console.warn(`-> On-chain profile not found for owner ${ownerPublicKey.toString()}`);
        }

        // Buscar dados do evento
        const eventAccountData = await program.account.event.fetch(eventPublicKey);
        
        let eventMetadata = { name: "Evento" };
        let eventName = "Evento";
        
        // **CORREÇÃO: Buscar da coluna `metadata` em vez de `registration_details`**
        try {
            const { data: dbEvent, error: dbError } = await supabase
                .from('events')
                .select('metadata, name, image_url') // Buscar metadata, name e image_url
                .eq('event_address', eventPublicKey.toString())
                .single();

            if (!dbError && dbEvent) {
                console.log(`[+] Found event in database:`, dbEvent);
                
                // Se metadata existe e tem dados, usar como metadata
                if (dbEvent.metadata && typeof dbEvent.metadata === 'object') {
                    eventMetadata = dbEvent.metadata;
                    
                    // Tentar extrair o nome do evento de várias fontes possíveis
                    eventName = dbEvent.metadata.name || 
                               dbEvent.name || 
                               eventAccountData.name || 
                               "Evento Especial";

                    console.log(`[+] Using event name: ${eventName}`);
                } else {
                    // Se não tem metadata, usar o nome direto da tabela
                    eventName = dbEvent.name || eventAccountData.name || "Evento Especial";
                    eventMetadata.name = eventName;
                }
            } else {
                console.warn(`[!] Event not found in database for address ${eventPublicKey.toString()}`);
                if (dbError) console.warn(`[!] Database error:`, dbError);
                
                // Fallback: tentar buscar do metadataUri da chain
                if (eventAccountData.metadataUri) {
                    try {
                        const metadataResponse = await fetch(eventAccountData.metadataUri);
                        if (metadataResponse.ok) {
                            eventMetadata = await metadataResponse.json();
                            eventName = eventMetadata.name || eventAccountData.name || "Evento Especial";
                        }
                    } catch (fetchError) {
                        console.warn(`[!] Failed to fetch from metadataUri:`, fetchError.message);
                    }
                }
                
                // Último fallback: usar nome da conta da chain
                if (eventAccountData.name) {
                    eventName = eventAccountData.name;
                    eventMetadata.name = eventName;
                }
            }
        } catch (dbError) {
            console.warn(`[!] Error querying database for event:`, dbError.message);
            // Fallbacks similares ao acima...
        }

        res.status(200).json({
            success: true, 
            owner: ownerPublicKey.toString(), 
            ownerName: ownerName,
            ticket: ticketAccount.account, 
            profile: userProfile,
            event: { 
                name: eventName, 
                metadata: eventMetadata,
                accountData: {
                    name: eventAccountData.name,
                    metadataUri: eventAccountData.metadataUri
                }
            }
        });
    } catch (error) {
        console.error("[✘] Error fetching ticket data:", error);
        res.status(500).json({ error: "Server error fetching data.", details: error.message });
    }
};

export const getUserTickets = async (req, res) => {
    const { ownerAddress } = req.params;
    if (!ownerAddress) {
        return res.status(400).json({ success: false, error: 'Endereço do proprietário é obrigatório.' });
    }
    console.log(`[+] Buscando ingressos para o endereço: ${ownerAddress}`);

    try {
        const ownerPublicKey = new PublicKey(ownerAddress);
        const TICKET_ACCOUNT_OWNER_FIELD_OFFSET = 72;

        // 1. Buscar todas as contas de ingresso para o usuário
        const userTicketAccounts = await program.account.ticket.all([
            { memcmp: { offset: TICKET_ACCOUNT_OWNER_FIELD_OFFSET, bytes: ownerPublicKey.toBase58() } }
        ]);

        if (userTicketAccounts.length === 0) {
            console.log(` -> Nenhum ingresso encontrado para ${ownerAddress}`);
            return res.status(200).json({ success: true, tickets: [] });
        }
        console.log(` -> Encontrados ${userTicketAccounts.length} ingressos on-chain.`);

        // 2. Otimização: Agrupar ingressos por evento para buscar metadados em lote
        const eventPublicKeys = [...new Set(userTicketAccounts.map(t => t.account.event.toString()))]
            .map(pkStr => new PublicKey(pkStr));

        // 3. Buscar as contas dos eventos correspondentes
        const eventAccounts = await program.account.event.fetchMultiple(eventPublicKeys);
        
        // 4. Buscar os metadados de cada evento e criar um mapa para consulta rápida
        const eventDataMap = new Map();
        await Promise.all(eventAccounts.map(async (account, index) => {
            if (account) {
                try {
                    const response = await fetch(account.metadataUri);
                    if (response.ok) {
                        const metadata = await response.json();
                        eventDataMap.set(eventPublicKeys[index].toString(), { account, metadata });
                    }
                } catch (e) {
                    console.error(` -> Falha ao buscar metadados para o evento ${eventPublicKeys[index].toString()}:`, e.message);
                }
            }
        }));
        
        // 5. Buscar todas as listagens ativas do marketplace
        const allListings = await program.account.marketplaceListing.all();
        const listedNftMints = new Set(
            allListings
                .filter(l => l.account.price.toNumber() > 0)
                .map(l => l.account.nftMint.toString())
        );

        // 6. Combinar os dados: ingresso + metadados do evento + status de listagem
        const enrichedTickets = userTicketAccounts.map(ticket => {
            const eventDetails = eventDataMap.get(ticket.account.event.toString());
            return {
                publicKey: ticket.publicKey.toString(),
                account: ticket.account,
                event: eventDetails || null,
                isListed: listedNftMints.has(ticket.account.nftMint.toString()),
            };
        });

        console.log(`[✔] Retornando ${enrichedTickets.length} ingressos com dados enriquecidos.`);
        res.status(200).json({
            success: true,
            tickets: enrichedTickets,
        });

    } catch (error) {
        console.error("[✘] Erro ao buscar ingressos do usuário:", error);
        if (error.message.includes('Invalid public key')) {
             return res.status(400).json({ success: false, error: 'O endereço fornecido é inválido.' });
        }
        res.status(500).json({ success: false, error: 'Ocorreu um erro no servidor ao buscar os ingressos.' });
    }
};

export const checkOrganizerPermission = async (req, res) => {
    const { walletAddress } = req.params;
    if (!walletAddress) {
        return res.status(400).json({ success: false, error: 'O endereço da carteira é obrigatório.' });
    }

    try {
        const walletPubkey = new PublicKey(walletAddress);
        let isAllowed = false;

        // 1. Verificar permissão de Admin (GlobalConfig)
        try {
            const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
            const globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
            if (globalConfig.authority.equals(walletPubkey)) {
                isAllowed = true;
            }
        } catch (e) {
            // Ignora erro se o GlobalConfig não existir (ainda não inicializado)
            if (!e.message.includes("Account does not exist")) {
                console.error("Erro ao buscar GlobalConfig:", e);
            }
        }

        // 2. Verificar permissão de Whitelist, apenas se não for Admin
        if (!isAllowed) {
            try {
                const [whitelistPda] = PublicKey.findProgramAddressSync([Buffer.from("whitelist"), walletPubkey.toBuffer()], program.programId);
                const whitelistAccount = await program.account.whitelist.fetch(whitelistPda);
                if (whitelistAccount.isWhitelisted) {
                    isAllowed = true;
                }
            } catch (e) {
                // Ignora erro se a conta da Whitelist não existir
            }
        }
        
        console.log(`[✔] Permissão verificada para ${walletAddress}: ${isAllowed}`);
        res.status(200).json({ success: true, isAllowed });

    } catch (error) {
        console.error("[✘] Erro na verificação de permissão:", error);
        res.status(500).json({ success: false, error: 'Erro no servidor ao verificar permissões.' });
    }
};
