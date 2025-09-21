import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet } = anchor;
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import fs from 'fs';
import bs58 from 'bs58';
import { fileURLToPath } from 'url';
import path from 'path';

// --- CONFIGURAÇÃO INICIAL ---
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, './ticketing_system.json'), 'utf8'));

// --- VARIÁVEIS DE AMBIENTE E CONSTANTES ---
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const PAYER_MNEMONIC = process.env.PAYER_MNEMONIC;

if (!SOLANA_RPC_URL || !PAYER_MNEMONIC) {
    throw new Error("As variáveis de ambiente SOLANA_RPC_URL e PAYER_MNEMONIC são obrigatórias.");
}

const PROGRAM_ID = new PublicKey("AHRuW77r9tM8RAX7qbhVyjktgSZueb6QVjDjWXjEoCeA"); 
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// --- CONFIGURAÇÃO DA CONEXÃO SOLANA ---
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

console.log(`[+] API configurada com o programa: ${PROGRAM_ID.toString()}`);
console.log(`[+] Carteira pagadora (Payer): ${payerKeypair.publicKey.toString()}`);


// ====================================================================
// --- Endpoint 1: ONBOARDING WEB2 (Com financiamento da nova carteira) ---
// ====================================================================
app.post('/generate-wallet-and-mint', async (req, res) => {
    const { eventAddress, tierIndex, name, phone, email, company, sector, role } = req.body;
    if (!eventAddress || tierIndex === undefined || !name || !phone) {
        return res.status(400).json({ error: "Parâmetros de evento e cadastro são obrigatórios." });
    }

    console.log(`[+] Iniciando onboarding completo para o usuário: ${name}`);
    
    try {
        const newUserKeypair = Keypair.generate();
        const newUserPublicKey = newUserKeypair.publicKey;
        console.log(` -> Nova carteira gerada: ${newUserPublicKey.toString()}`);

        console.log(" -> Financiando nova carteira para cobrir o 'rent'...");
        const rentLamports = 5000000;
        const transferTransaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: payerKeypair.publicKey,
                toPubkey: newUserPublicKey,
                lamports: rentLamports,
            })
        );
        await sendAndConfirmTransaction(connection, transferTransaction, [payerKeypair]);
        console.log(` -> Nova carteira financiada com ${rentLamports} lamports.`);

        const [userProfilePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_profile"), newUserPublicKey.toBuffer()],
            program.programId
        );

        console.log(" -> Registrando perfil do usuário...");
        
        const registerUserInstruction = await program.methods
            .registerUser(name, phone, email || "", company || "", sector || "", role || "")
            .accounts({
                authority: newUserPublicKey,
                userProfile: userProfilePda,
                systemProgram: SystemProgram.programId,
            })
            .instruction();

        const registerTransaction = new Transaction().add(registerUserInstruction);
        
        await sendAndConfirmTransaction(connection, registerTransaction, [
            payerKeypair,
            newUserKeypair,
        ]);
        
        const eventPubkey = new PublicKey(eventAddress);
        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), newUserPublicKey.toBuffer()],
            program.programId
        );

        console.log(" -> Criando contador de ingressos...");
        await program.methods.createBuyerCounter()
            .accounts({
                payer: payerKeypair.publicKey,
                event: eventPubkey,
                buyer: newUserPublicKey,
                buyerTicketCount: buyerTicketCountPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        const mintKeypair = Keypair.generate();
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, newUserPublicKey);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);
        
        console.log(" -> Mintando o ingresso...");
        const signature = await program.methods
            .mintFreeTicket(tierIndex)
            .accounts({
                globalConfig: globalConfigPda, event: eventPubkey, payer: payerKeypair.publicKey,
                buyer: newUserPublicKey, mintAccount: mintKeypair.publicKey, ticket: ticketPda,
                buyerTicketCount: buyerTicketCountPda, associatedTokenAccount: associatedTokenAccount,
                metadataAccount: metadataPda, metadataProgram: TOKEN_METADATA_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([mintKeypair])
            .rpc();

        const mnemonic = bip39.entropyToMnemonic(newUserKeypair.secretKey.slice(0, 16));
        console.log(`[✔] Onboarding completo! Assinatura do mint: ${signature}`);
        res.status(200).json({
            success: true,
            publicKey: newUserPublicKey.toString(),
            seedPhrase: mnemonic,
            mintAddress: mintKeypair.publicKey.toString(),
        });

    } catch (error) {
        console.error("[✘] Erro durante o onboarding completo:", error);
        const errorDetails = error.logs ? error.logs.join(' ') : error.message;
        res.status(500).json({ error: "Erro no servidor durante o onboarding.", details: errorDetails });
    }
});

// ====================================================================
// --- Endpoint 2: CADASTRO PARA USUÁRIOS WEB3 EXISTENTES (Gasless) ---
// ====================================================================
app.post('/register-user', async (req, res) => {
    const { authority, name, phone, email, company, sector, role } = req.body;
    if (!authority || !name || !phone) {
        return res.status(400).json({ error: "Parâmetros authority, name e phone são obrigatórios." });
    }
    console.log(`[+] Registrando perfil para a carteira: ${authority}`);
    try {
        const authorityPubkey = new PublicKey(authority);
        const [userProfilePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_profile"), authorityPubkey.toBuffer()],
            program.programId
        );
        const signature = await program.methods
            .registerUser(name, phone, email || "", company || "", sector || "", role || "")
            .accounts({
                authority: authorityPubkey,
                userProfile: userProfilePda,
                payer: payerKeypair.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
        console.log(`[✔] Perfil registrado/atualizado com sucesso! Assinatura: ${signature}`);
        res.status(200).json({ success: true, signature });
    } catch (error) {
        console.error("[✘] Erro ao registrar perfil:", error);
        const errorDetails = error.logs ? error.logs.join(' ') : error.message;
        res.status(500).json({ error: "Erro no servidor ao registrar perfil.", details: errorDetails });
    }
});

// ====================================================================
// --- Endpoint 3: RECUPERAÇÃO DE DADOS (Para Check-in e Certificado) ---
// ====================================================================
app.get('/ticket-data/:mintAddress', async (req, res) => {
    const { mintAddress } = req.params;
    if (!mintAddress) {
        return res.status(400).json({ error: "O mintAddress do NFT é obrigatório." });
    }

    console.log(`[+] Buscando dados completos do ingresso: ${mintAddress}`);
    try {
        const nftMint = new PublicKey(mintAddress);
        
        // 1. Encontrar a conta 'Ticket'
        const tickets = await program.account.ticket.all([
            { memcmp: { offset: 8 + 32, bytes: nftMint.toBase58() } }
        ]);
        
        if (tickets.length === 0) {
            return res.status(404).json({ error: "Ingresso (NFT) não encontrado." });
        }
        
        const ticketAccount = tickets[0];
        const ownerPublicKey = ticketAccount.account.owner;
        const eventPublicKey = ticketAccount.account.event;
        console.log(` -> Dono encontrado: ${ownerPublicKey.toString()}`);
        console.log(` -> Evento encontrado: ${eventPublicKey.toString()}`);

        // 2. Buscar a conta 'UserProfile' do dono
        const [userProfilePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_profile"), ownerPublicKey.toBuffer()],
            program.programId
        );
        const userProfile = await program.account.userProfile.fetch(userProfilePda);
        console.log(` -> Perfil encontrado para ${userProfile.name}`);

        // ✅ PASSO ADICIONAL: Buscar os metadados do evento
        console.log(" -> Buscando metadados do evento...");
        const eventAccount = await program.account.event.fetch(eventPublicKey);
        const metadataResponse = await fetch(eventAccount.metadataUri);
        if (!metadataResponse.ok) {
            throw new Error("Falha ao buscar metadados do evento.");
        }
        const eventMetadata = await metadataResponse.json();
        console.log(` -> Nome do evento: ${eventMetadata.name}`);

        // 3. Retornar tudo
        res.status(200).json({
            success: true,
            owner: ownerPublicKey.toString(),
            profile: userProfile,
            ticket: ticketAccount.account,
            event: { // ✅ Inclui um novo objeto 'event' na resposta
                name: eventMetadata.name,
                metadata: eventMetadata, // Envia todos os metadados, se precisar de mais algo
            }
        });

    } catch (error) {
        console.error("[✘] Erro ao buscar dados do ingresso:", error);
        if (error.message.includes("Account does not exist")) {
             return res.status(404).json({ error: "Perfil de usuário não encontrado para este ingresso." });
        }
        const errorDetails = error.logs ? error.logs.join(' ') : error.message;
        res.status(500).json({ error: "Erro no servidor ao buscar dados.", details: errorDetails });
    }
});

// ====================================================================
// --- Endpoint 4: MINT PARA USUÁRIOS WEB3 EXISTENTES (Gasless) ---
// ====================================================================
app.post('/mint-for-existing-user', async (req, res) => {
    const { eventAddress, buyerAddress, tierIndex } = req.body;
    if (!eventAddress || !buyerAddress || tierIndex === undefined) {
        return res.status(400).json({ error: "Parâmetros obrigatórios ausentes." });
    }
    console.log(`[+] Iniciando mint para usuário existente: ${buyerAddress}`);
    try {
        const eventPubkey = new PublicKey(eventAddress);
        const buyer = new PublicKey(buyerAddress);
        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), buyer.toBuffer()],
            program.programId
        );
        const accountInfo = await connection.getAccountInfo(buyerTicketCountPda);
        if (!accountInfo) {
            console.log(" -> Contador não encontrado, criando...");
            await program.methods.createBuyerCounter()
                .accounts({
                    payer: payerKeypair.publicKey, event: eventPubkey, buyer: buyer,
                    buyerTicketCount: buyerTicketCountPda, systemProgram: SystemProgram.programId,
                })
                .rpc();
            console.log(" -> Contador criado com sucesso.");
        } else {
            console.log(" -> Contador já existe.");
        }
        const mintKeypair = Keypair.generate();
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, buyer);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);
        console.log(" -> Mintando o ingresso...");
        const signature = await program.methods
            .mintFreeTicket(tierIndex)
            .accounts({
                globalConfig: globalConfigPda, event: eventPubkey, payer: payerKeypair.publicKey,
                buyer: buyer, mintAccount: mintKeypair.publicKey, ticket: ticketPda,
                buyerTicketCount: buyerTicketCountPda, associatedTokenAccount: associatedTokenAccount,
                metadataAccount: metadataPda, metadataProgram: TOKEN_METADATA_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([mintKeypair])
            .rpc();
        console.log(`[✔] Ingresso mintado para usuário existente! Assinatura: ${signature}`);
        res.status(200).json({
            success: true,
            signature,
            mintAddress: mintKeypair.publicKey.toString(),
        });
    } catch (error) {
        console.error("[✘] Erro ao mintar para usuário existente:", error);
        const errorDetails = error.logs ? error.logs.join(' ') : error.message;
        res.status(500).json({ error: "Erro no servidor ao mintar para usuário existente.", details: errorDetails });
    }
});
// ====================================================================
// --- Endpoint 5: BUSCAR INGRESSOS VALIDADOS DE UM EVENTO ---
// ====================================================================
app.get('/event/:eventAddress/validated-tickets', async (req, res) => {
    const { eventAddress } = req.params;
    if (!eventAddress) {
        return res.status(400).json({ error: "O endereço do evento é obrigatório." });
    }

    console.log(`[+] Buscando ingressos validados para o evento: ${eventAddress}`);
    try {
        const eventPubkey = new PublicKey(eventAddress);
        
        const redeemedTickets = await program.account.ticket.all([
            { memcmp: { offset: 8, bytes: eventPubkey.toBase58() } }, // Filtra pelo evento
            // ✅ CORREÇÃO AQUI: O offset para o campo 'redeemed' é 104 (8 + 32 + 32 + 32)
            { memcmp: { offset: 104, bytes: bs58.encode([1]) } } // Filtra por redeemed = true
        ]);

        if (redeemedTickets.length === 0) {
            return res.status(200).json([]);
        }

        const validatedEntries = await Promise.all(redeemedTickets.map(async (ticket) => {
            try {
                const [userProfilePda] = PublicKey.findProgramAddressSync(
                    [Buffer.from("user_profile"), ticket.account.owner.toBuffer()],
                    program.programId
                );
                const userProfile = await program.account.userProfile.fetch(userProfilePda);
                return {
                    name: userProfile.name,
                    redeemedAt: new Date(ticket.account.redeemedAt * 1000).toLocaleTimeString('pt-BR'),
                    nftMint: ticket.account.nftMint.toString(),
                };
            } catch (e) {
                return {
                    name: "Perfil não encontrado",
                    redeemedAt: new Date(ticket.account.redeemedAt * 1000).toLocaleTimeString('pt-BR'),
                    nftMint: ticket.account.nftMint.toString(),
                };
            }
        }));
        
        const sortedEntries = validatedEntries.sort((a, b) => new Date(b.redeemedAt) - new Date(a.redeemedAt));

        console.log(`[✔] ${sortedEntries.length} ingressos validados encontrados.`);
        res.status(200).json(sortedEntries);

    } catch (error) {
        console.error("[✘] Erro ao buscar ingressos validados:", error);
        res.status(500).json({ error: "Erro no servidor ao buscar ingressos.", details: error.message });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    console.log(`🚀 Servidor Gasless rodando na porta ${PORT}`);

});



