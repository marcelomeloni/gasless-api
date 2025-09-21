import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
const { Program, AnchorProvider, Wallet } = anchor;
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// --- CONFIGURAÇÃO INICIAL ---
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CARREGAMENTO DO IDL (Interface Definition Language) ---
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

// ====================================================================
// ✅ ATENÇÃO: COLOQUE AQUI O PROGRAM ID DO SEU ÚLTIMO DEPLOY BEM-SUCEDIDO!
const PROGRAM_ID = new PublicKey("GRDPcYTxrXv1mX3ExUS2UUjjAWNezUdiwvRtn3EQP8Ci"); // Exemplo
// ====================================================================

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

// ====================================================================
// --- NOVO ENDPOINT PARA CRIAR O CONTADOR DO COMPRADOR ---
// ====================================================================
app.post('/create-buyer-counter', async (req, res) => {
    const { eventAddress, buyerAddress } = req.body;
    if (!eventAddress || !buyerAddress) {
        return res.status(400).json({ error: "Parâmetros obrigatórios ausentes: eventAddress, buyerAddress." });
    }

    console.log(`[+] Pedido para criar/verificar contador para o evento ${eventAddress} para ${buyerAddress}`);
    try {
        const eventPubkey = new PublicKey(eventAddress);
        const buyer = new PublicKey(buyerAddress);

        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), buyer.toBuffer()],
            program.programId
        );

        // Otimização: Verifique se a conta já existe para não enviar uma transação desnecessária
        const accountInfo = await connection.getAccountInfo(buyerTicketCountPda);
        if (accountInfo) {
            console.log("[✔] Contador já existe.");
            return res.status(200).json({ success: true, message: "Contador já existe." });
        }

        console.log(" -> Contador não encontrado. Criando transação...");
        const signature = await program.methods
            .createBuyerCounter()
            .accounts({
                payer: payerKeypair.publicKey,
                event: eventPubkey,
                buyer: buyer,
                buyerTicketCount: buyerTicketCountPda,
                systemProgram: SystemProgram.programId,
            })
            // Apenas a carteira do servidor (payer) precisa assinar
            .signers([payerKeypair])
            .rpc();

        console.log(`[✔] Contador criado com sucesso! Assinatura: ${signature}`);
        res.status(200).json({ success: true, signature });

    } catch (error) {
        // Se o erro for que a conta já existe (caso de uma corrida de requests), trate como sucesso.
        if (error.message && error.message.includes("already in use")) {
             console.log("[✔] Contador já existe (detectado durante a transação).");
             return res.status(200).json({ success: true, message: "Contador já existe." });
        }
        console.error("[✘] Erro ao criar o contador:", error);
        res.status(500).json({ error: "Erro no servidor ao criar o contador." });
    }
});


// ====================================================================
// --- ENDPOINT ATUALIZADO PARA MINTAR O INGRESSO ---
// ====================================================================
app.post('/mint-free-ticket', async (req, res) => {
    const { eventAddress, buyerAddress, tierIndex } = req.body;
    if (!eventAddress || !buyerAddress || tierIndex === undefined) {
        return res.status(400).json({ error: "Parâmetros obrigatórios ausentes: eventAddress, buyerAddress, tierIndex." });
    }

    console.log(`[+] Pedido para mintar ingresso do evento ${eventAddress} para ${buyerAddress}`);
    try {
        const eventPubkey = new PublicKey(eventAddress);
        const buyer = new PublicKey(buyerAddress);
        const mintKeypair = Keypair.generate();

        // Derivando todas as contas necessárias explicitamente para clareza
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync([Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), buyer.toBuffer()], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, buyer);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);

        console.log(" -> Construindo a transação de mint...");
        const signature = await program.methods
            .mintFreeTicket(tierIndex)
            .accounts({
                globalConfig: globalConfigPda,
                event: eventPubkey,
                payer: payerKeypair.publicKey,
                buyer: buyer,
                mintAccount: mintKeypair.publicKey,
                ticket: ticketPda,
                buyerTicketCount: buyerTicketCountPda, // Esta conta agora deve existir
                associatedTokenAccount: associatedTokenAccount,
                metadataAccount: metadataPda,
                metadataProgram: TOKEN_METADATA_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([payerKeypair, mintKeypair])
            .rpc();

        console.log(`[✔] Ingresso mintado com sucesso! Assinatura: ${signature}`);
        res.status(200).json({ success: true, signature });
    } catch (error) {
        console.error("[✘] Erro ao processar o mint:", error);
        const errorDetails = error.logs ? error.logs.join(' ') : error.message;
        res.status(500).json({ error: "Erro no servidor ao processar a transação.", details: errorDetails });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    console.log(`🚀 Servidor gasless rodando na porta ${PORT}`);
    console.log(`🔑 Carteira pagadora (Payer): ${payerKeypair.publicKey.toString()}`);
});