import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet } = anchor;
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bip39 from 'bip39';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import { derivePath } from 'ed25519-hd-key';
import fs from 'fs';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes/index.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { sendTicketEmail } from './services/emailService.jsx';
// --- INITIAL SETUP ---
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, './ticketing_system.json'), 'utf8'));

// --- ENVIRONMENT VARIABLES & CONSTANTS ---
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const PAYER_MNEMONIC = process.env.PAYER_MNEMONIC;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PINATA_JWT = process.env.PINATA_JWT;
const upload = multer({ storage: multer.memoryStorage() });
if (!SOLANA_RPC_URL || !PAYER_MNEMONIC || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Required environment variables are missing (Solana or Supabase).");
}
if (!PINATA_JWT) {
    throw new Error("A variável de ambiente PINATA_JWT é obrigatória.");
}
const PROGRAM_ID = new PublicKey("5kQZsq3z1P9TQuR2tBXJjhKr46JnEcsDKYDnEfNCB792");
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// --- SUPABASE CLIENT SETUP ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);


// --- SOLANA CONNECTION SETUP ---
const getKeypairFromMnemonic = (mnemonic) => {
    const seed = bip39.mnemonicToSeedSync(mnemonic, "");
    const path = `m/44'/501'/0'/0'`;
    return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
};
const payerKeypair = getKeypairFromMnemonic(PAYER_MNEMONIC);
const payerWallet = new Wallet(payerKeypair);
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const provider = new AnchorProvider(connection, payerWallet, AnchorProvider.defaultOptions());
const program = new Program(idl, PROGRAM_ID, provider);

console.log(`[+] API configured with program: ${PROGRAM_ID.toString()}`);
console.log(`[+] Payer wallet: ${payerKeypair.publicKey.toString()}`);
console.log(`[+] Supabase client initialized.`);

// --- SUPABASE HELPER FUNCTION ---
const upsertUserInSupabase = async (userData) => {
    const { name, phone, email, company, sector, role, wallet_address } = userData;
    console.log(` -> Upserting user profile in Supabase for wallet: ${wallet_address}`);

    const { data, error } = await supabase
        .from('profiles')
        .upsert({
            wallet_address: wallet_address, name, phone, email,
            company, sector, role, updated_at: new Date(),
        }, {
            onConflict: 'wallet_address'
        })
        .select().single();

    if (error) {
        console.error(" -> Supabase upsert error:", error);
        throw new Error(`Failed to upsert user in Supabase: ${error.message}`);
    }
    console.log(" -> User profile upserted successfully in Supabase.");
    return data;
};

async function saveRegistrationData({ eventAddress, wallet_address, name, phone, email, company, sector, role, mint_address }) {
    
    // Passo 1: Use 'upsert' com 'onConflict' para criar ou atualizar o perfil do comprador.
    console.log(` -> Garantindo perfil para a carteira: ${wallet_address}`);
    const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .upsert({ 
            wallet_address: wallet_address, 
            name: name,
            email: email,
            updated_at: new Date()
        }, {
            onConflict: 'wallet_address'
        })
        .select('id')
        .single();

    if (profileError) {
        console.error("Erro ao fazer upsert no perfil:", profileError);
        // Lida com o erro de email duplicado de forma mais clara
        if (profileError.message.includes('profiles_email_key')) {
            throw new Error('Este email já está em uso por outra conta.');
        }
        throw new Error("Falha ao salvar dados do perfil.");
    }

    if (!profileData) {
        throw new Error("Não foi possível obter o ID do perfil após o upsert.");
    }

    const profile_id = profileData.id;
    console.log(` -> Perfil garantido. ID: ${profile_id}`);

    // Passo 2: Crie um NOVO registro na tabela 'registrations', agora incluindo o mint_address.
    const registrationDetails = { name, phone, email, company, sector, role };
    console.log(` -> Criando novo registro para o evento ${eventAddress} com o mint ${mint_address}`);

    const { data: newRegistration, error: registrationError } = await supabase
        .from('registrations')
        .insert({
            profile_id: profile_id,
            event_address: eventAddress,
            registration_details: registrationDetails,
            mint_address: mint_address 
        })
        .select('id')
        .single();

    if (registrationError || !newRegistration) {
        console.error("Erro ao inserir registro:", registrationError);
        throw new Error("Falha ao criar o registro do ingresso.");
    }

    console.log(`[💾] Dados de registro salvos com sucesso! ID do Registro: ${newRegistration.id}`);
    
    // Passo 3: Retorne o ID do registro para ser usado no QR Code.
    return newRegistration.id;
}
// ====================================================================
// --- Endpoint 1: WEB2 ONBOARDING (PIX/FREE) ---
// ====================================================================
// Assumindo que a função 'saveRegistrationData' já existe no seu código.
// const { saveRegistrationData } = require('./supabase-helpers');

// Assumindo que a função 'saveRegistrationData' que criamos antes já existe no seu código.
// const { saveRegistrationData } = require('./supabase-helpers');

app.post('/generate-wallet-and-mint', async (req, res) => {
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
        // ... (validações de tier, preço, etc., se necessário) ...

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
        const mintAddress = mintKeypair.publicKey.toString(); // <- Pegamos o mintAddress aqui
        
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
            mint_address: mintAddress, // Passa o endereço do NFT recém-criado
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
                    // ...outros dados do metadata...
                };
                sendTicketEmail({ name, email }, ticketDataForEmail);
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
            registrationId: registrationId // <-- NOVO DADO PARA O QR CODE!
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
});

app.get('/check-organizer-permission/:walletAddress', async (req, res) => {
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
});
// ====================================================================
// --- Endpoint 2: MINT FOR EXISTING WEB3 USERS (PÓS-PIX) ---
// ====================================================================
app.post('/mint-for-existing-user', async (req, res) => {
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
            mint_address: mintAddress, // Passa o endereço do NFT recém-criado
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
                    
                    sendTicketEmail({ name, email }, ticketDataForEmail);
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
            registrationId: registrationId // <-- NOVO DADO PARA O QR CODE!
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
});


// ====================================================================
// --- Endpoint 3: DATA RETRIEVAL ---
// ====================================================================
app.get('/ticket-data/:mintAddress', async (req, res) => {
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
        } catch (e) { console.warn(`-> Supabase profile not found for owner ${ownerPublicKey.toString()}`); }

        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), ownerPublicKey.toBuffer()], program.programId);
        let userProfile = null;
        try { userProfile = await program.account.userProfile.fetch(userProfilePda); }
        catch (e) { console.warn(`-> On-chain profile not found for owner ${ownerPublicKey.toString()}`); }

        const eventAccountData = await program.account.event.fetch(eventPublicKey);
        const metadataResponse = await fetch(eventAccountData.metadataUri);
        if (!metadataResponse.ok) throw new Error("Failed to fetch event metadata.");
        const eventMetadata = await metadataResponse.json();

        res.status(200).json({
            success: true, owner: ownerPublicKey.toString(), ownerName: ownerName,
            ticket: ticketAccount.account, profile: userProfile,
            event: { name: eventMetadata.name, metadata: eventMetadata }
        });
    } catch (error) {
        console.error("[✘] Error fetching ticket data:", error);
        res.status(500).json({ error: "Server error fetching data.", details: error.message });
    }
});

// ====================================================================
// --- Endpoint 4: FETCH VALIDATED TICKETS ---
// ====================================================================
app.get('/event/:eventAddress/validated-tickets', async (req, res) => {
    const { eventAddress } = req.params;
    if (!eventAddress) return res.status(400).json({ error: "Event address is required." });

    try {
        const eventPubkey = new PublicKey(eventAddress);
        // Pega todos os ingressos validados da blockchain
        const allTicketsForEvent = await program.account.ticket.all([{ memcmp: { offset: 8, bytes: eventPubkey.toBase58() } }]);
        const redeemedTickets = allTicketsForEvent.filter(ticket => ticket.account.redeemed);

        if (redeemedTickets.length === 0) return res.status(200).json([]);

        // 1. Pega os endereços de todos os donos dos ingressos
        const ownerAddresses = redeemedTickets.map(ticket => ticket.account.owner.toString());
        
        // 2. Busca no Supabase os nomes correspondentes a esses endereços
        const { data: profiles } = await supabase.from('profiles').select('wallet_address, name').in('wallet_address', ownerAddresses);
        
        // 3. Cria um "mapa" para facilitar a busca (carteira -> nome)
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
});

app.get('/events/active', async (req, res) => {
    console.log('[+] Fetching active events...');
    try {
        // ⭐ BUSCAR TODOS OS EVENTOS E FILTRAR NO JAVASCRIPT
        const allEvents = await program.account.event.all();
        console.log(` -> Found ${allEvents.length} total events on-chain`);
        
        const nowInSeconds = Math.floor(Date.now() / 1000);
        console.log(` -> Current timestamp: ${nowInSeconds}`);
        
        // ⭐ FILTRAR DIRETAMENTE NO JAVASCRIPT
        const fullyActiveEvents = allEvents.filter(event => {
            const acc = event.account;
            
            // Debug detalhado
            console.log(`\n--- Checking Event ${event.publicKey} ---`);
            console.log(`State: ${acc.state}, Canceled: ${acc.canceled}`);
            console.log(`Sales Start: ${acc.salesStartDate.toNumber()}`);
            console.log(`Sales End: ${acc.salesEndDate.toNumber()}`);
            console.log(`Now: ${nowInSeconds}`);
            
            const isStateActive = acc.state === 1;
            const isNotCanceled = !acc.canceled;
            const isInSalesPeriod = nowInSeconds >= acc.salesStartDate.toNumber() && 
                                  nowInSeconds <= acc.salesEndDate.toNumber();
            
            console.log(`Active State: ${isStateActive}, Not Canceled: ${isNotCanceled}, In Sales Period: ${isInSalesPeriod}`);
            
            return isStateActive && isNotCanceled && isInSalesPeriod;
        });
        
        console.log(` -> Found ${fullyActiveEvents.length} events that are fully active.`);

        // Busca de metadados para os eventos ativos
        const eventsWithMetadata = await Promise.all(
            fullyActiveEvents.map(async (event) => {
                try {
                    console.log(` -> Fetching metadata from: ${event.account.metadataUri}`);
                    const response = await fetch(event.account.metadataUri);
                    if (!response.ok) {
                        console.warn(` -> Failed to fetch metadata for event ${event.publicKey.toString()}`);
                        return null;
                    }
                    const metadata = await response.json();
                    console.log(` -> Successfully fetched metadata: ${metadata.name}`);
                    return {
                        publicKey: event.publicKey.toString(),
                        account: event.account,
                        metadata: metadata,
                    };
                } catch (e) {
                    console.error(` -> Error fetching metadata for ${event.account.metadataUri}`, e);
                    return null;
                }
            })
        );
        
        const validEvents = eventsWithMetadata
            .filter(e => e !== null)
            .sort((a, b) => a.account.salesStartDate.toNumber() - b.account.salesStartDate.toNumber());

        console.log(`[✔] Successfully fetched and processed ${validEvents.length} active events.`);
        res.status(200).json(validEvents);

    } catch (error) {
        console.error("[✘] Error fetching active events:", error);
        res.status(500).json({ error: "Server error fetching events.", details: error.message });
    }
});
app.get('/user-tickets/:ownerAddress', async (req, res) => {
    const { ownerAddress } = req.params;
    if (!ownerAddress) {
        return res.status(400).json({ success: false, error: 'Endereço do proprietário é obrigatório.' });
    }
    console.log(`[+] Buscando ingressos para o endereço: ${ownerAddress}`);

    try {
        const ownerPublicKey = new PublicKey(ownerAddress);
        const TICKET_ACCOUNT_OWNER_FIELD_OFFSET = 72; // Offset do campo 'owner' na conta Ticket

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
});
app.get('/event-details/:eventAddress', async (req, res) => {
    const { eventAddress } = req.params;
    if (!eventAddress) {
        return res.status(400).json({ success: false, error: 'O endereço do evento é obrigatório.' });
    }
    console.log(`[+] Buscando detalhes para o evento: ${eventAddress}`);

    try {
        const eventPubkey = new PublicKey(eventAddress);

        // 1. Busca os dados on-chain do evento
        const account = await program.account.event.fetch(eventPubkey);
        console.log(` -> Dados on-chain encontrados.`);

        // 2. Busca os metadados off-chain
        const metadataResponse = await fetch(account.metadataUri);
        if (!metadataResponse.ok) {
            throw new Error(`Falha ao buscar metadados da URI: ${account.metadataUri}`);
        }
        const metadata = await metadataResponse.json();
        console.log(` -> Metadados off-chain encontrados: ${metadata.name}`);

        // 3. Combina tudo em uma única resposta
        res.status(200).json({
            success: true,
            event: {
                account: account,
                metadata: metadata,
            },
        });

    } catch (error) {
        console.error("[✘] Erro ao buscar detalhes do evento:", error);
        
        // Trata erros comuns, como evento não encontrado
        if (error.message.includes('Account does not exist')) {
            return res.status(404).json({ success: false, error: 'Evento não encontrado.' });
        }
        if (error.message.includes('Invalid public key')) {
             return res.status(400).json({ success: false, error: 'O endereço do evento fornecido é inválido.' });
        }

        res.status(500).json({ success: false, error: 'Ocorreu um erro no servidor ao buscar os dados do evento.' });
    }
});
// --- NOVO ENDPOINT DE VALIDAÇÃO POR ID ---
app.post('/validate-by-id/:registrationId', async (req, res) => {
    const { registrationId } = req.params;
    const { validatorAddress } = req.body;

    if (!registrationId || !validatorAddress) {
        return res.status(400).json({ success: false, error: "ID do registro e endereço do validador são obrigatórios." });
    }
    console.log(`[+] Iniciando validação para o registro: ${registrationId}`);

    try {
        // 1. Busca o registro no banco de dados para obter os endereços on-chain
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

        // 2. Com os dados do banco, executa a validação na blockchain
        const eventPubkey = new PublicKey(event_address);
        const nftMintPubkey = new PublicKey(mint_address);
        const validatorPubkey = new PublicKey(validatorAddress);

        // 2a. Verifica a permissão do validador
        const eventAccount = await program.account.event.fetch(eventPubkey);
        const isValidator = eventAccount.validators.some(v => v.equals(validatorPubkey));
        if (!isValidator) {
            console.warn(` -> TENTATIVA DE VALIDAÇÃO NEGADA: ${validatorAddress} não é um validador para este evento.`);
            return res.status(403).json({ success: false, error: "Acesso negado. Esta carteira não é um validador autorizado." });
        }
        console.log(` -> Validador ${validatorAddress} autorizado.`);

        // 2b. Encontra a conta do ticket e verifica se já foi usado
        const TICKET_NFT_MINT_FIELD_OFFSET = 40; // 8 (discriminator) + 32 (event)
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

        // 2c. Executa a transação de resgate (redeem)
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

        // 3. Retorna a resposta de sucesso com o nome do participante
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
});
app.post(
    '/api/create-full-event',
    // O 'upload.fields' permite receber múltiplos arquivos com nomes diferentes
    upload.fields([
        { name: 'image', maxCount: 1 },
        { name: 'organizerLogo', maxCount: 1 }
    ]),
    async (req, res) => {
        console.log('[+] Recebida requisição para criar evento completo.');

        try {
            // 1. Extrair e converter os dados do FormData
            const { offChainData, onChainData, controller } = req.body;
            if (!offChainData || !onChainData || !controller) {
                return res.status(400).json({ success: false, error: "Dados do formulário ou do controlador ausentes." });
            }
            const parsedOffChainData = JSON.parse(offChainData);
            const parsedOnChainData = JSON.parse(onChainData);
            const controllerPubkey = new web3.PublicKey(controller);
            const files = req.files;

            // 2. Fazer o upload das imagens para o Pinata (se existirem)
            let imageUrl = parsedOffChainData.image; // Assume URL existente se não houver arquivo
            let organizerLogoUrl = parsedOffChainData.organizer.organizerLogo;

            const uploadToPinata = async (file) => {
                const formData = new FormData();
                formData.append('file', file.buffer, {
                    filename: file.originalname,
                    contentType: file.mimetype,
                });
                const response = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", formData, {
                    headers: { 'Authorization': `Bearer ${PINATA_JWT}` }
                });
                return `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`;
            };

            if (files.image?.[0]) {
                console.log(' -> Fazendo upload da imagem do evento...');
                imageUrl = await uploadToPinata(files.image[0]);
                console.log(` -> Imagem do evento enviada: ${imageUrl}`);
            }
            if (files.organizerLogo?.[0]) {
                console.log(' -> Fazendo upload do logo do organizador...');
                organizerLogoUrl = await uploadToPinata(files.organizerLogo[0]);
                console.log(` -> Logo enviado: ${organizerLogoUrl}`);
            }

            // 3. Montar o objeto de metadados final com as URLs do Pinata
            const finalMetadata = {
                ...parsedOffChainData,
                image: imageUrl,
                organizer: { ...parsedOffChainData.organizer, organizerLogo: organizerLogoUrl },
                properties: {
                    ...parsedOffChainData.properties,
                    dateTime: {
                        ...parsedOffChainData.properties.dateTime,
                        start: new Date(parsedOffChainData.properties.dateTime.start).toISOString(),
                        end: new Date(parsedOffChainData.properties.dateTime.end).toISOString(),
                    }
                }
            };
            
            // 4. Fazer o upload do JSON de metadados para o Pinata
            console.log(' -> Fazendo upload do JSON de metadados...');
            const jsonResponse = await axios.post("https://api.pinata.cloud/pinning/pinJSONToIPFS", finalMetadata, {
                headers: { 'Authorization': `Bearer ${PINATA_JWT}` }
            });
            const metadataUrl = `https://gateway.pinata.cloud/ipfs/${jsonResponse.data.IpfsHash}`;
            console.log(` -> Metadados enviados: ${metadataUrl}`);

            // 5. Preparar dados e chamar a transação na blockchain
            console.log(' -> Preparando transação on-chain...');
            const eventId = new anchor.BN(Date.now());
            
            const [whitelistPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("whitelist"), controllerPubkey.toBuffer()], program.programId);
            const [eventPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("event"), eventId.toBuffer('le', 8)], program.programId);
            
            const tiersInput = parsedOnChainData.tiers.map(tier => {
                const priceBRLCents = Math.round(parseFloat(tier.price) * 100);
                return {
                    name: tier.name,
                    priceBrlCents: new anchor.BN(priceBRLCents),
                    maxTicketsSupply: parseInt(tier.maxTicketsSupply, 10),
                };
            });

            console.log(' -> Enviando transação para a blockchain...');
            const signature = await program.methods
                .createEvent(
                    eventId, 
                    metadataUrl, 
                    new anchor.BN(Math.floor(new Date(parsedOnChainData.salesStartDate).getTime() / 1000)), 
                    new anchor.BN(Math.floor(new Date(parsedOnChainData.salesEndDate).getTime() / 1000)), 
                    parseInt(parsedOnChainData.royaltyBps, 10), 
                    parseInt(parsedOnChainData.maxTicketsPerWallet, 10), 
                    tiersInput
                )
                .accounts({
                    whitelistAccount: whitelistPda,
                    eventAccount: eventPda,
                    controller: controllerPubkey,      // ✅ O dono do evento é o usuário do frontend
                    payer: payerKeypair.publicKey,      // ✅ A taxa é paga pela carteira da API
                    systemProgram: web3.SystemProgram.programId,
                })
                .rpc();

            console.log(`[✔] Evento criado com sucesso! Assinatura: ${signature}`);
            res.status(200).json({ success: true, signature, eventAddress: eventPda.toString() });

        } catch (error) {
            console.error("❌ Erro no processo de criação completo do evento:", error.response?.data || error.message);
            res.status(500).json({ success: false, error: error.message || 'Ocorreu um erro interno no servidor.' });
        }
    }
);
// --- SERVER INITIALIZATION ---
app.listen(PORT, () => {
    console.log(`🚀 Gasless server running on port ${PORT}`);
});
































