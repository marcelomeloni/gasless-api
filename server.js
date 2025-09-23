import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet } = anchor;
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js'; // ✅ NOVO: Importar o cliente Supabase

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
const SUPABASE_URL = process.env.SUPABASE_URL; // ✅ NOVO
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // ✅ NOVO

if (!SOLANA_RPC_URL || !PAYER_MNEMONIC || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) { // ✅ MODIFICADO
    throw new Error("Required environment variables are missing (Solana or Supabase).");
}

const PROGRAM_ID = new PublicKey("6BpG2uYeLSgHEynoT7VrNb6BpHSiwXPyayvECgCaizL5");
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// --- SUPABASE CLIENT SETUP ---
// ✅ NOVO: Cria o cliente Supabase para o backend, usando a chave de serviço segura
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
console.log(`[+] Supabase client initialized.`); // ✅ NOVO: Log de confirmação

// ✅ NOVO: Função auxiliar para cadastrar/atualizar usuário no Supabase
// Usamos 'upsert' para criar um novo usuário ou atualizar um existente se a carteira já estiver cadastrada.
const upsertUserInSupabase = async (userData) => {
    const { name, phone, email, company, sector, role, wallet_address } = userData;

    console.log(` -> Upserting user profile in Supabase for wallet: ${wallet_address}`);

    const { data, error } = await supabase
        .from('profiles') // ❗ ATENÇÃO: Troque 'profiles' pelo nome da sua tabela de usuários
        .upsert({
            wallet_address: wallet_address, // Coluna que identifica unicamente o usuário
            name,
            phone,
            email,
            company,
            sector,
            role,
            updated_at: new Date(), // Opcional: para rastrear atualizações
        }, {
            onConflict: 'wallet_address' // Coluna usada para detectar conflitos (geralmente a chave primária)
        })
        .select()
        .single(); // Retorna o objeto inserido/atualizado

    if (error) {
        console.error(" -> Supabase upsert error:", error);
        throw new Error(`Failed to upsert user in Supabase: ${error.message}`);
    }

    console.log(" -> User profile upserted successfully in Supabase.");
    return data;
};


// ====================================================================
// --- Endpoint 1: WEB2 ONBOARDING ---
// ====================================================================
app.post('/generate-wallet-and-mint', async (req, res) => {
    const { eventAddress, tierIndex, name, phone, email, company, sector, role } = req.body;
    if (!eventAddress || tierIndex === undefined || !name || !phone) {
        return res.status(400).json({ error: "Event and registration parameters are required." });
    }
    console.log(`[+] Starting full onboarding for user: ${name}`);

    try {
        // --- 1. Geração de Carteira Compatível ---
        const mnemonic = bip39.generateMnemonic();
        const newUserKeypair = getKeypairFromMnemonic(mnemonic);
        const newUserPublicKey = newUserKeypair.publicKey;
        console.log(` -> New wallet generated with standard derivation path: ${newUserPublicKey.toString()}`);

        // ✅ NOVO: Cadastra o usuário no Supabase ANTES de prosseguir com a transação na blockchain.
        // Se isso falhar, a operação inteira é interrompida.
        await upsertUserInSupabase({
            wallet_address: newUserPublicKey.toString(),
            name, phone, email, company, sector, role
        });

        // --- 2. Verificar o Preço do Ingresso ---
        const eventPubkey = new PublicKey(eventAddress);
        const eventAccount = await program.account.event.fetch(eventPubkey);
        const selectedTier = eventAccount.tiers[tierIndex];

        if (!selectedTier) {
            return res.status(400).json({ error: "Invalid tier index." });
        }
        const isFree = selectedTier.priceLamports.toNumber() === 0;

        // --- 3. Criação de Perfil e Contador On-chain ---
        console.log(" -> Generating hash and creating on-chain profile...");
        const userDataString = [name.trim(), phone.trim(), (email || "").trim(), (company || "").trim(), (sector || "").trim(), (role || "").trim()].join('|');
        const dataHash = createHash('sha256').update(userDataString).digest();
        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), newUserPublicKey.toBuffer()], program.programId);

        await program.methods.registerUser(Array.from(dataHash)).accounts({
            authority: newUserPublicKey,
            userProfile: userProfilePda,
            payer: payerKeypair.publicKey,
            systemProgram: SystemProgram.programId,
        }).rpc();
        console.log(" -> Profile created.");

        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync([Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), newUserPublicKey.toBuffer()], program.programId);
        await program.methods.createBuyerCounter().accounts({
            payer: payerKeypair.publicKey,
            event: eventPubkey,
            buyer: newUserPublicKey,
            buyerTicketCount: buyerTicketCountPda,
            systemProgram: SystemProgram.programId
        }).rpc();
        console.log(" -> Buyer counter created.");

        // --- 4. Lógica de Mint (Grátis vs. Pago) ---
        const mintKeypair = Keypair.generate();
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, newUserPublicKey);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);

        let signature;

        if (isFree) {
            console.log(" -> Tier is free. Minting ticket...");
            signature = await program.methods.mintFreeTicket(tierIndex).accounts({
                globalConfig: globalConfigPda, event: eventPubkey, payer: payerKeypair.publicKey, buyer: newUserPublicKey,
                mintAccount: mintKeypair.publicKey, ticket: ticketPda, buyerTicketCount: buyerTicketCountPda,
                associatedTokenAccount: associatedTokenAccount, metadataAccount: metadataPda, metadataProgram: TOKEN_METADATA_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
            }).signers([payerKeypair, mintKeypair]).rpc();

        } else {
            console.log(" -> Tier is paid. Funding new wallet and minting ticket...");
            const [refundReservePda] = PublicKey.findProgramAddressSync([Buffer.from("refund_reserve"), eventPubkey.toBuffer()], program.programId);
            const lamportsToFund = selectedTier.priceLamports.toNumber() + 2000000;
            const fundInstruction = SystemProgram.transfer({
                fromPubkey: payerKeypair.publicKey,
                toPubkey: newUserPublicKey,
                lamports: lamportsToFund,
            });
            const mintInstruction = await program.methods.mintTicket(tierIndex)
                .accounts({
                    globalConfig: globalConfigPda, event: eventPubkey, refundReserve: refundReservePda,
                    buyer: newUserPublicKey, buyerTicketCount: buyerTicketCountPda, mintAccount: mintKeypair.publicKey,
                    metadataAccount: metadataPda, associatedTokenAccount: associatedTokenAccount, tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
                    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY, ticket: ticketPda,
                }).instruction();
            const transaction = new Transaction().add(fundInstruction, mintInstruction);
            signature = await program.provider.sendAndConfirm(transaction, [payerKeypair, newUserKeypair, mintKeypair]);
        }

        console.log(`[✔] Onboarding and mint successful! Signature: ${signature}`);
        res.status(200).json({
            success: true,
            publicKey: newUserPublicKey.toString(),
            seedPhrase: mnemonic,
            mintAddress: mintKeypair.publicKey.toString(),
            signature: signature
        });

    } catch (error) {
        console.error("[✘] Error during full onboarding:", error);
        const anchorError = anchor.AnchorError.parse(error.logs);
        const errorMessage = anchorError ? anchorError.error.errorMessage : error.message;
        res.status(500).json({ error: "Server error during onboarding.", details: errorMessage || "Unknown error" });
    }
});



// ====================================================================
// --- Endpoint 2: MINT FOR EXISTING WEB3 USERS ---
// ====================================================================
app.post('/mint-for-existing-user', async (req, res) => {
    const { eventAddress, buyerAddress, tierIndex, name, phone, email, company, sector, role } = req.body;
    if (!eventAddress || !buyerAddress || tierIndex === undefined) {
        return res.status(400).json({ error: "'eventAddress', 'buyerAddress', and 'tierIndex' parameters are required." });
    }
    console.log(`[+] Initiating mint for existing user: ${buyerAddress}`);

    try {
        const eventPubkey = new PublicKey(eventAddress);
        const buyer = new PublicKey(buyerAddress);

        // ✅ NOVO: Cadastra ou atualiza o usuário no Supabase com os dados do formulário.
        await upsertUserInSupabase({
            wallet_address: buyer.toString(),
            name, phone, email, company, sector, role
        });

        // --- 1. Verificação e Criação de Perfil/Contador On-chain (se necessário) ---
        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), buyer.toBuffer()], program.programId);
        const userProfileAccount = await connection.getAccountInfo(userProfilePda);

        if (!userProfileAccount) {
            console.log(" -> On-chain profile not found, creating...");
            if (!name || !phone) {
                return res.status(400).json({ error: "User data (name, phone) is required to create the on-chain profile." });
            }
            const userDataString = [name.trim(), phone.trim(), (email || "").trim(), (company || "").trim(), (sector || "").trim(), (role || "").trim()].join('|');
            const dataHash = createHash('sha256').update(userDataString).digest();

            await program.methods.registerUser(Array.from(dataHash)).accounts({
                authority: buyer,
                userProfile: userProfilePda,
                payer: payerKeypair.publicKey,
                systemProgram: SystemProgram.programId,
            }).rpc();
            console.log(" -> On-chain profile created successfully.");
        } else {
            console.log(" -> On-chain profile already exists.");
        }

        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync([Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), buyer.toBuffer()], program.programId);
        const accountInfo = await connection.getAccountInfo(buyerTicketCountPda);
        if (!accountInfo) {
            console.log(" -> Ticket counter not found, creating...");
            await program.methods.createBuyerCounter().accounts({
                payer: payerKeypair.publicKey,
                event: eventPubkey,
                buyer: buyer,
                buyerTicketCount: buyerTicketCountPda,
                systemProgram: SystemProgram.programId
            }).rpc();
        }

        // --- 2. Verificar o Preço do Ingresso ---
        const eventAccount = await program.account.event.fetch(eventPubkey);
        const selectedTier = eventAccount.tiers[tierIndex];

        if (!selectedTier) {
            return res.status(400).json({ error: "Invalid tier index." });
        }

        const isFree = selectedTier.priceLamports.toNumber() === 0;

        // --- 3. Lógica de Mint (Grátis vs. Pago) ---
        const mintKeypair = Keypair.generate();
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, buyer);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);

        if (isFree) {
            // --- CASO 1: INGRESSO GRÁTIS ---
            console.log(" -> Tier is free. Minting with server-side logic...");

            const signature = await program.methods.mintFreeTicket(tierIndex).accounts({
                globalConfig: globalConfigPda,
                event: eventPubkey,
                payer: payerKeypair.publicKey,
                buyer: buyer,
                mintAccount: mintKeypair.publicKey,
                ticket: ticketPda,
                buyerTicketCount: buyerTicketCountPda,
                associatedTokenAccount: associatedTokenAccount,
                metadataAccount: metadataPda,
                metadataProgram: TOKEN_METADATA_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
            }).signers([payerKeypair, mintKeypair]).rpc();

            console.log(`[✔] Free ticket minted successfully! Signature: ${signature}`);
            res.status(200).json({ success: true, isPaid: false, signature, mintAddress: mintKeypair.publicKey.toString() });

        } else {
            // --- CASO 2: INGRESSO PAGO ---
            console.log(" -> Tier is paid. Creating transaction for client-side signing...");
            const [refundReservePda] = PublicKey.findProgramAddressSync([Buffer.from("refund_reserve"), eventPubkey.toBuffer()], program.programId);
            const mintInstruction = await program.methods
                .mintTicket(tierIndex)
                .accounts({
                    globalConfig: globalConfigPda, event: eventPubkey, refundReserve: refundReservePda,
                    buyer: buyer, buyerTicketCount: buyerTicketCountPda, mintAccount: mintKeypair.publicKey,
                    metadataAccount: metadataPda, associatedTokenAccount: associatedTokenAccount, tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
                    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY, ticket: ticketPda,
                })
                .instruction();

            const transaction = new Transaction().add(mintInstruction);
            transaction.feePayer = buyer;
            transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
            transaction.partialSign(mintKeypair);

            const serializedTransaction = transaction.serialize({
                requireAllSignatures: false,
            });

            console.log("[✔] Paid transaction created and serialized. Sending to client.");
            res.status(200).json({
                success: true,
                isPaid: true,
                transaction: serializedTransaction.toString('base64'),
                mintAddress: mintKeypair.publicKey.toString(),
            });
        }
    } catch (error) {
        console.error("[✘] Error minting for existing user:", error);
        const anchorError = anchor.AnchorError.parse(error.logs);
        const errorMessage = anchorError ? anchorError.error.errorMessage : error.message;
        res.status(500).json({ error: "Server error while minting for existing user.", details: errorMessage || "Unknown error" });
    }
});


// ====================================================================
// --- Endpoint 3: DATA RETRIEVAL ---
// ====================================================================
app.get('/ticket-data/:mintAddress', async (req, res) => {
    // ... este endpoint permanece inalterado ...
    const { mintAddress } = req.params;
    if (!mintAddress) {
        return res.status(400).json({ error: "The NFT mintAddress is required." });
    }
    console.log(`[+] Fetching ticket data: ${mintAddress}`);
    try {
        const nftMint = new PublicKey(mintAddress);
        const tickets = await program.account.ticket.all([{ memcmp: { offset: 8 + 32, bytes: nftMint.toBase58() } }]);
        if (tickets.length === 0) {
            return res.status(404).json({ error: "Ticket (NFT) not found." });
        }
        const ticketAccount = tickets[0];
        const ownerPublicKey = ticketAccount.account.owner;
        const eventPublicKey = ticketAccount.account.event;

        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), ownerPublicKey.toBuffer()], program.programId);
        let userProfile = null;
        try {
            userProfile = await program.account.userProfile.fetch(userProfilePda);
        } catch (e) {
            console.warn(` -> On-chain profile not found for owner ${ownerPublicKey.toString()}`);
        }

        const eventAccountData = await program.account.event.fetch(eventPublicKey);
        const metadataResponse = await fetch(eventAccountData.metadataUri);
        if (!metadataResponse.ok) {
            throw new Error("Failed to fetch event metadata.");
        }
        const eventMetadata = await metadataResponse.json();

        res.status(200).json({
            success: true,
            owner: ownerPublicKey.toString(),
            ticket: ticketAccount.account,
            profile: userProfile,
            event: {
                name: eventMetadata.name,
                metadata: eventMetadata,
            }
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
    // ... este endpoint permanece inalterado ...
    const { eventAddress } = req.params;
    if (!eventAddress) {
        return res.status(400).json({ error: "The event address is required." });
    }
    try {
        const eventPubkey = new PublicKey(eventAddress);
        const allTicketsForEvent = await program.account.ticket.all([
            { memcmp: { offset: 8, bytes: eventPubkey.toBase58() } }
        ]);

        const redeemedTickets = allTicketsForEvent.filter(ticket => ticket.account.redeemed);

        const validatedEntries = redeemedTickets.map(ticket => ({
            owner: ticket.account.owner.toString(),
            redeemedAt: new Date(ticket.account.redeemedAt * 1000).toLocaleTimeString('pt-BR'),
            nftMint: ticket.account.nftMint.toString(),
        }));

        res.status(200).json(validatedEntries);
    } catch (error) {
        console.error("[✘] Error fetching validated tickets:", error);
        res.status(500).json({ error: "Server error fetching tickets.", details: error.message });
    }
});


// --- SERVER INITIALIZATION ---
app.listen(PORT, () => {
    console.log(`🚀 Gasless server running on port ${PORT}`);
});
