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
        // ✅ BUSCA SEGURA DE METADADOS DO EVENTO
        let eventMetadata = {};
        let eventImage = '';
        let eventName = "Evento";
        let eventDate = "Data a ser definida";
        let eventLocation = "Local a ser definido";
        let organizerName = "Organizador";

        try {
            // 1. PRIMEIRO: Buscar do Supabase (mais rápido e confiável)
            const { data: dbEvent, error: dbError } = await supabase
                .from('events')
                .select('metadata, image_url, event_name')
                .eq('event_address', eventAddress)
                .single();

            if (!dbError && dbEvent && dbEvent.metadata) {
                console.log('✅ Metadados carregados do Supabase');
                eventMetadata = dbEvent.metadata;
                eventImage = dbEvent.image_url || eventMetadata.image || '';
                eventName = eventMetadata.name || dbEvent.event_name || "Evento";
                
                // ✅ ACESSO SEGURO À DATA
                eventDate = eventMetadata.properties?.dateTime?.start || 
                           eventMetadata.dateTime?.start || 
                           eventMetadata.startDate || 
                           "Data a ser definida";
                
                // ✅ ACESSO SEGURO AO LOCAL
                eventLocation = eventMetadata.properties?.location?.venueName ||
                               eventMetadata.properties?.location?.address?.city ||
                               eventMetadata.location?.venueName ||
                               eventMetadata.location?.address?.city ||
                               eventMetadata.location ||
                               "Local a ser definido";
                
                organizerName = eventMetadata.organizer?.name || "Organizador";
                
            } else {
                // 2. FALLBACK: Buscar da blockchain + IPFS
                console.log('🔄 Buscando metadados da blockchain...');
                const eventPubkey = new PublicKey(eventAddress);
                const eventAccount = await program.account.event.fetch(eventPubkey);
                
                if (eventAccount.metadataUri) {
                    try {
                        const metadataResponse = await fetch(eventAccount.metadataUri);
                        if (metadataResponse.ok) {
                            eventMetadata = await metadataResponse.json();
                            eventImage = eventMetadata.image || '';
                            eventName = eventMetadata.name || eventAccount.name || "Evento";
                            
                            // ✅ ACESSO SEGURO À DATA (fallback)
                            eventDate = eventMetadata.properties?.dateTime?.start || 
                                       eventMetadata.dateTime?.start || 
                                       eventMetadata.startDate || 
                                       "Data a ser definida";
                            
                            // ✅ ACESSO SEGURO AO LOCAL (fallback)
                            eventLocation = eventMetadata.properties?.location?.venueName ||
                                           eventMetadata.properties?.location?.address?.city ||
                                           eventMetadata.location?.venueName ||
                                           eventMetadata.location?.address?.city ||
                                           eventMetadata.location ||
                                           "Local a ser definido";
                            
                            organizerName = eventMetadata.organizer?.name || "Organizador";
                        }
                    } catch (ipfsError) {
                        console.warn('❌ Erro ao buscar metadados do IPFS:', ipfsError);
                    }
                }
            }
        } catch (metadataError) {
            console.warn('⚠️ Erro ao buscar metadados, usando valores padrão:', metadataError);
            // 3. FALLBACK FINAL: Valores padrão
            eventName = "Evento Especial";
            eventDate = "Data a ser definida";
            eventLocation = "Local a ser definido";
            organizerName = "Organizador";
        }

        // ✅ DADOS SEGUROS PARA O EMAIL
        const ticketDataForEmail = {
            eventName: eventName,
            eventDate: eventDate,
            eventLocation: eventLocation,
            mintAddress: mintAddress,
            seedPhrase: mnemonic, 
            privateKey: privateKey, 
            eventImage: eventImage,
            registrationId: registrationId,
            organizerName: organizerName,
            // ✅ Incluir campos adicionais para paid tickets
            ...(isPaid && { 
                isPaid: true,
                paymentAmount: (priceBRLCents / 100).toFixed(2)
            })
        };

        console.log('📧 Dados preparados para email:', {
            eventName: ticketDataForEmail.eventName,
            eventDate: ticketDataForEmail.eventDate,
            eventLocation: ticketDataForEmail.eventLocation,
            hasImage: !!ticketDataForEmail.eventImage
        });

        const emailResult = await sendTicketEmail({ name, email }, ticketDataForEmail);
        
        if (!emailResult.success) {
            console.error("Falha no envio de e-mail, mas o mint foi bem-sucedido:", emailResult.error);
        } else {
            console.log("✅ E-mail enviado com sucesso para:", email);
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
        // ✅ BUSCA SEGURA DE METADADOS DO EVENTO
        let eventMetadata = {};
        let eventImage = '';
        let eventName = "Evento";
        let eventDate = "Data a ser definida";
        let eventLocation = "Local a ser definido";
        let organizerName = "Organizador";

        try {
            // 1. PRIMEIRO: Buscar do Supabase (mais rápido e confiável)
            const { data: dbEvent, error: dbError } = await supabase
                .from('events')
                .select('metadata, image_url, event_name')
                .eq('event_address', eventAddress)
                .single();

            if (!dbError && dbEvent && dbEvent.metadata) {
                console.log('✅ Metadados carregados do Supabase');
                eventMetadata = dbEvent.metadata;
                eventImage = dbEvent.image_url || eventMetadata.image || '';
                eventName = eventMetadata.name || dbEvent.event_name || "Evento";
                
                // ✅ ACESSO SEGURO À DATA
                eventDate = eventMetadata.properties?.dateTime?.start || 
                           eventMetadata.dateTime?.start || 
                           eventMetadata.startDate || 
                           "Data a ser definida";
                
                // ✅ ACESSO SEGURO AO LOCAL
                eventLocation = eventMetadata.properties?.location?.venueName ||
                               eventMetadata.properties?.location?.address?.city ||
                               eventMetadata.location?.venueName ||
                               eventMetadata.location?.address?.city ||
                               eventMetadata.location ||
                               "Local a ser definido";
                
                organizerName = eventMetadata.organizer?.name || "Organizador";
                
            } else {
                // 2. FALLBACK: Buscar da blockchain + IPFS
                console.log('🔄 Buscando metadados da blockchain...');
                const eventPubkey = new PublicKey(eventAddress);
                const eventAccount = await program.account.event.fetch(eventPubkey);
                
                if (eventAccount.metadataUri) {
                    try {
                        const metadataResponse = await fetch(eventAccount.metadataUri);
                        if (metadataResponse.ok) {
                            eventMetadata = await metadataResponse.json();
                            eventImage = eventMetadata.image || '';
                            eventName = eventMetadata.name || eventAccount.name || "Evento";
                            
                            // ✅ ACESSO SEGURO À DATA (fallback)
                            eventDate = eventMetadata.properties?.dateTime?.start || 
                                       eventMetadata.dateTime?.start || 
                                       eventMetadata.startDate || 
                                       "Data a ser definida";
                            
                            // ✅ ACESSO SEGURO AO LOCAL (fallback)
                            eventLocation = eventMetadata.properties?.location?.venueName ||
                                           eventMetadata.properties?.location?.address?.city ||
                                           eventMetadata.location?.venueName ||
                                           eventMetadata.location?.address?.city ||
                                           eventMetadata.location ||
                                           "Local a ser definido";
                            
                            organizerName = eventMetadata.organizer?.name || "Organizador";
                        }
                    } catch (ipfsError) {
                        console.warn('❌ Erro ao buscar metadados do IPFS:', ipfsError);
                    }
                }
            }
        } catch (metadataError) {
            console.warn('⚠️ Erro ao buscar metadados, usando valores padrão:', metadataError);
            // 3. FALLBACK FINAL: Valores padrão
            eventName = "Evento Especial";
            eventDate = "Data a ser definida";
            eventLocation = "Local a ser definido";
            organizerName = "Organizador";
        }

        // ✅ DADOS SEGUROS PARA O EMAIL
        const ticketDataForEmail = {
            eventName: eventName,
            eventDate: eventDate,
            eventLocation: eventLocation,
            mintAddress: mintAddress,
            seedPhrase: mnemonic, 
            privateKey: privateKey, 
            eventImage: eventImage,
            registrationId: registrationId,
            organizerName: organizerName,
            // ✅ Incluir campos adicionais para paid tickets
            ...(isPaid && { 
                isPaid: true,
                paymentAmount: (priceBRLCents / 100).toFixed(2)
            })
        };

        console.log('📧 Dados preparados para email:', {
            eventName: ticketDataForEmail.eventName,
            eventDate: ticketDataForEmail.eventDate,
            eventLocation: ticketDataForEmail.eventLocation,
            hasImage: !!ticketDataForEmail.eventImage
        });

        const emailResult = await sendTicketEmail({ name, email }, ticketDataForEmail);
        
        if (!emailResult.success) {
            console.error("Falha no envio de e-mail, mas o mint foi bem-sucedido:", emailResult.error);
        } else {
            console.log("✅ E-mail enviado com sucesso para:", email);
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
        // ✅ BUSCA SEGURA DE METADADOS DO EVENTO
        let eventMetadata = {};
        let eventImage = '';
        let eventName = "Evento";
        let eventDate = "Data a ser definida";
        let eventLocation = "Local a ser definido";
        let organizerName = "Organizador";

        try {
            // 1. PRIMEIRO: Buscar do Supabase (mais rápido e confiável)
            const { data: dbEvent, error: dbError } = await supabase
                .from('events')
                .select('metadata, image_url, event_name')
                .eq('event_address', eventAddress)
                .single();

            if (!dbError && dbEvent && dbEvent.metadata) {
                console.log('✅ Metadados carregados do Supabase');
                eventMetadata = dbEvent.metadata;
                eventImage = dbEvent.image_url || eventMetadata.image || '';
                eventName = eventMetadata.name || dbEvent.event_name || "Evento";
                
                // ✅ ACESSO SEGURO À DATA
                eventDate = eventMetadata.properties?.dateTime?.start || 
                           eventMetadata.dateTime?.start || 
                           eventMetadata.startDate || 
                           "Data a ser definida";
                
                // ✅ ACESSO SEGURO AO LOCAL
                eventLocation = eventMetadata.properties?.location?.venueName ||
                               eventMetadata.properties?.location?.address?.city ||
                               eventMetadata.location?.venueName ||
                               eventMetadata.location?.address?.city ||
                               eventMetadata.location ||
                               "Local a ser definido";
                
                organizerName = eventMetadata.organizer?.name || "Organizador";
                
            } else {
                // 2. FALLBACK: Buscar da blockchain + IPFS
                console.log('🔄 Buscando metadados da blockchain...');
                const eventPubkey = new PublicKey(eventAddress);
                const eventAccount = await program.account.event.fetch(eventPubkey);
                
                if (eventAccount.metadataUri) {
                    try {
                        const metadataResponse = await fetch(eventAccount.metadataUri);
                        if (metadataResponse.ok) {
                            eventMetadata = await metadataResponse.json();
                            eventImage = eventMetadata.image || '';
                            eventName = eventMetadata.name || eventAccount.name || "Evento";
                            
                            // ✅ ACESSO SEGURO À DATA (fallback)
                            eventDate = eventMetadata.properties?.dateTime?.start || 
                                       eventMetadata.dateTime?.start || 
                                       eventMetadata.startDate || 
                                       "Data a ser definida";
                            
                            // ✅ ACESSO SEGURO AO LOCAL (fallback)
                            eventLocation = eventMetadata.properties?.location?.venueName ||
                                           eventMetadata.properties?.location?.address?.city ||
                                           eventMetadata.location?.venueName ||
                                           eventMetadata.location?.address?.city ||
                                           eventMetadata.location ||
                                           "Local a ser definido";
                            
                            organizerName = eventMetadata.organizer?.name || "Organizador";
                        }
                    } catch (ipfsError) {
                        console.warn('❌ Erro ao buscar metadados do IPFS:', ipfsError);
                    }
                }
            }
        } catch (metadataError) {
            console.warn('⚠️ Erro ao buscar metadados, usando valores padrão:', metadataError);
            // 3. FALLBACK FINAL: Valores padrão
            eventName = "Evento Especial";
            eventDate = "Data a ser definida";
            eventLocation = "Local a ser definido";
            organizerName = "Organizador";
        }

        // ✅ DADOS SEGUROS PARA O EMAIL
        const ticketDataForEmail = {
            eventName: eventName,
            eventDate: eventDate,
            eventLocation: eventLocation,
            mintAddress: mintAddress,
            seedPhrase: mnemonic, 
            privateKey: privateKey, 
            eventImage: eventImage,
            registrationId: registrationId,
            organizerName: organizerName,
            // ✅ Incluir campos adicionais para paid tickets
            ...(isPaid && { 
                isPaid: true,
                paymentAmount: (priceBRLCents / 100).toFixed(2)
            })
        };

        console.log('📧 Dados preparados para email:', {
            eventName: ticketDataForEmail.eventName,
            eventDate: ticketDataForEmail.eventDate,
            eventLocation: ticketDataForEmail.eventLocation,
            hasImage: !!ticketDataForEmail.eventImage
        });

        const emailResult = await sendTicketEmail({ name, email }, ticketDataForEmail);
        
        if (!emailResult.success) {
            console.error("Falha no envio de e-mail, mas o mint foi bem-sucedido:", emailResult.error);
        } else {
            console.log("✅ E-mail enviado com sucesso para:", email);
        }
        
    } catch(e) {
        console.error("Falha ao enviar e-mail (mas o mint funcionou):", e);
    }
}

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
    console.log(`[🎫] Buscando dados do ticket: ${mintAddress}`);

    try {
        const nftMint = new PublicKey(mintAddress);
        const tickets = await program.account.ticket.all([{ memcmp: { offset: 8 + 32, bytes: nftMint.toBase58() } }]);
        if (tickets.length === 0) return res.status(404).json({ error: "Ticket (NFT) not found." });

        const ticketAccount = tickets[0];
        const ownerPublicKey = ticketAccount.account.owner;
        const eventPublicKey = ticketAccount.account.event;

        console.log(`[🔍] Owner: ${ownerPublicKey.toString()}, Event: ${eventPublicKey.toString()}`);

        let ownerName = null;
        try {
            const { data: profile } = await supabase.from('profiles').select('name').eq('wallet_address', ownerPublicKey.toString()).single();
            if (profile) ownerName = profile.name;
        } catch (e) { 
            console.warn(`[⚠️] Perfil não encontrado no Supabase para ${ownerPublicKey.toString()}`);
        }

        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), ownerPublicKey.toBuffer()], program.programId);
        let userProfile = null;
        try { 
            userProfile = await program.account.userProfile.fetch(userProfilePda); 
        } catch (e) { 
            console.warn(`[⚠️] Perfil on-chain não encontrado para ${ownerPublicKey.toString()}`);
        }

        // ✅✅✅ CORREÇÃO COMPLETA: BUSCAR DADOS COMPLETOS DO EVENTO
        let eventAccountData = null;
        let eventMetadata = {};
        let eventImageUrl = '';
        let eventName = "Evento Especial";
        let organizerLogo = '';
        let complementaryHours = 0;

        try {
            // 1. PRIMEIRO: Buscar dados COMPLETOS do Supabase
            console.log(`[📊] Buscando evento no Supabase: ${eventPublicKey.toString()}`);
            const { data: dbEvent, error: dbError } = await supabase
                .from('events')
                .select('*') // ✅ AGORA BUSCA TODOS OS CAMPOS
                .eq('event_address', eventPublicKey.toString())
                .single();

            if (!dbError && dbEvent) {
                console.log(`[✅] Evento encontrado no Supabase:`, {
                    name: dbEvent.metadata?.name || dbEvent.event_name,
                    hasMetadata: !!dbEvent.metadata,
                    hasImage: !!dbEvent.image_url,
                    hasOrganizer: !!dbEvent.metadata?.organizer
                });

                // ✅ EXTRAIR METADADOS COMPLETOS DO SUPABASE
                eventMetadata = dbEvent.metadata || {};
                eventImageUrl = dbEvent.image_url || '';
                
                // ✅ NOME DO EVENTO COM FALLBACKS
                eventName = eventMetadata.name || dbEvent.event_name || "Evento Especial";
                
                // ✅ LOGO DO ORGANIZADOR
                organizerLogo = eventMetadata.organizer?.organizerLogo || '';
                
                // ✅ HORAS COMPLEMENTARES
                complementaryHours = eventMetadata.complementaryHours || 
                                   eventMetadata.additionalInfo?.complementaryHours || 0;

                console.log(`[📝] Metadados extraídos:`, {
                    eventName,
                    hasOrganizer: !!eventMetadata.organizer,
                    complementaryHours,
                    hasOrganizerLogo: !!organizerLogo
                });

            } else {
                console.warn(`[⚠️] Evento não encontrado no Supabase:`, dbError?.message);
                
                // 2. FALLBACK: Buscar da blockchain
                try {
                    console.log(`[⛓️] Buscando evento na blockchain...`);
                    eventAccountData = await program.account.event.fetch(eventPublicKey);
                    
                    // 3. FALLBACK: Buscar metadados do IPFS
                    if (eventAccountData?.metadataUri) {
                        try {
                            console.log(`[🌐] Buscando metadados do IPFS: ${eventAccountData.metadataUri}`);
                            const metadataResponse = await fetch(eventAccountData.metadataUri);
                            if (metadataResponse.ok) {
                                const ipfsMetadata = await metadataResponse.json();
                                eventMetadata = ipfsMetadata;
                                eventName = ipfsMetadata.name || eventAccountData?.name || "Evento Especial";
                                organizerLogo = ipfsMetadata.organizer?.organizerLogo || '';
                                complementaryHours = ipfsMetadata.complementaryHours || 
                                                  ipfsMetadata.additionalInfo?.complementaryHours || 0;
                                console.log(`[✅] Metadados carregados do IPFS: ${eventName}`);
                            }
                        } catch (ipfsError) {
                            console.warn(`[❌] Erro ao buscar metadados do IPFS:`, ipfsError.message);
                        }
                    }
                    
                    // 4. ÚLTIMO FALLBACK: Usar dados básicos da chain
                    if (eventAccountData?.name) {
                        eventName = eventAccountData.name;
                        eventMetadata.name = eventName;
                    }
                } catch (chainError) {
                    console.warn(`[❌] Erro ao buscar evento na blockchain:`, chainError.message);
                }
            }
        } catch (error) {
            console.error(`[💥] Erro crítico ao buscar dados do evento:`, error);
        }

        // ✅✅✅ ESTRUTURA FINAL COMPLETA DO EVENTO
        const eventData = {
            name: eventName,
            metadata: {
                ...eventMetadata,
                // ✅ GARANTIR QUE OS CAMPOS CRÍTICOS EXISTAM
                organizer: eventMetadata.organizer || {
                    name: "Organizador",
                    contactEmail: "",
                    website: "",
                    organizerLogo: organizerLogo
                },
                additionalInfo: {
                    ...eventMetadata.additionalInfo,
                    complementaryHours: complementaryHours
                }
            },
            imageUrl: eventImageUrl,
            organizerLogo: organizerLogo,
            complementaryHours: complementaryHours,
            accountData: eventAccountData ? {
                name: eventAccountData.name,
                metadataUri: eventAccountData.metadataUri
            } : null
        };

        console.log(`[🎉] Dados finais do evento para certificado:`, {
            name: eventData.name,
            hasOrganizerLogo: !!eventData.organizerLogo,
            complementaryHours: eventData.complementaryHours,
            hasFullMetadata: !!eventData.metadata.organizer
        });

        res.status(200).json({
            success: true, 
            owner: ownerPublicKey.toString(), 
            ownerName: ownerName,
            ticket: ticketAccount.account, 
            profile: userProfile,
            event: eventData // ✅ AGORA COM DADOS COMPLETOS
        });
    } catch (error) {
        console.error("[❌] Erro ao buscar dados do ticket:", error);
        res.status(500).json({ 
            error: "Erro no servidor ao buscar dados.", 
            details: error.message 
        });
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

        // ✅ 1. PRIMEIRO: Buscar tickets da blockchain
        const userTicketAccounts = await program.account.ticket.all([
            { memcmp: { offset: TICKET_ACCOUNT_OWNER_FIELD_OFFSET, bytes: ownerPublicKey.toBase58() } }
        ]);

        if (userTicketAccounts.length === 0) {
            console.log(` -> Nenhum ingresso encontrado para ${ownerAddress}`);
            return res.status(200).json({ success: true, tickets: [] });
        }
        console.log(` -> Encontrados ${userTicketAccounts.length} ingressos on-chain.`);

        // ✅ 2. AGORA: Buscar dados dos eventos do SUPABASE (muito mais rápido)
        const eventAddresses = [...new Set(userTicketAccounts.map(t => t.account.event.toString()))];
        
        console.log(` -> Buscando dados de ${eventAddresses.length} eventos no Supabase...`);
        
        const eventDataMap = new Map();
        
        // Buscar eventos do Supabase em paralelo
        await Promise.all(
            eventAddresses.map(async (eventAddress) => {
                try {
                    const { data: dbEvent, error } = await supabase
                        .from('events')
                        .select('*')
                        .eq('event_address', eventAddress)
                        .single();

                    if (!error && dbEvent) {
                        eventDataMap.set(eventAddress, {
                            account: {
                                eventId: dbEvent.event_id,
                                controller: dbEvent.controller,
                                salesStartDate: { toNumber: () => dbEvent.sales_start_date },
                                salesEndDate: { toNumber: () => dbEvent.sales_end_date },
                                maxTicketsPerWallet: dbEvent.max_tickets_per_wallet,
                                royaltyBps: dbEvent.royalty_bps,
                                metadataUri: dbEvent.metadata_url,
                                tiers: dbEvent.tiers || []
                            },
                            metadata: dbEvent.metadata || {},
                            imageUrl: dbEvent.image_url
                        });
                        console.log(` ✅ Evento ${eventAddress} carregado do Supabase`);
                    } else {
                        console.warn(` ⚠️ Evento ${eventAddress} não encontrado no Supabase`);
                        
                        // Fallback: buscar da blockchain
                        try {
                            const eventPubkey = new PublicKey(eventAddress);
                            const blockchainAccount = await program.account.event.fetch(eventPubkey);
                            
                            let metadata = {};
                            if (blockchainAccount.metadataUri) {
                                try {
                                    const response = await fetch(blockchainAccount.metadataUri);
                                    if (response.ok) {
                                        metadata = await response.json();
                                    }
                                } catch (e) {
                                    console.warn(` ❌ Falha ao buscar metadados IPFS para ${eventAddress}`);
                                }
                            }
                            
                            eventDataMap.set(eventAddress, {
                                account: blockchainAccount,
                                metadata: metadata,
                                imageUrl: metadata.image || ''
                            });
                        } catch (blockchainError) {
                            console.error(` ❌ Erro ao buscar evento ${eventAddress} da blockchain:`, blockchainError.message);
                        }
                    }
                } catch (error) {
                    console.error(` ❌ Erro ao processar evento ${eventAddress}:`, error.message);
                }
            })
        );

        // ✅ 3. Buscar listagens do marketplace
        const allListings = await program.account.marketplaceListing.all();
        const listedNftMints = new Set(
            allListings
                .filter(l => l.account.price.toNumber() > 0)
                .map(l => l.account.nftMint.toString())
        );

        // ✅ 4. Combinar dados
        const enrichedTickets = userTicketAccounts.map(ticket => {
            const eventAddress = ticket.account.event.toString();
            const eventDetails = eventDataMap.get(eventAddress);
            
            return {
                publicKey: ticket.publicKey.toString(),
                account: ticket.account,
                event: eventDetails || {
                    account: {},
                    metadata: { name: "Evento não encontrado" },
                    imageUrl: ''
                },
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
