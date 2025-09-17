const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram } = require('@solana/web3.js');
const { Program, AnchorProvider } = require('@coral-xyz/anchor');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Configurações
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const SEED_PHRASE = process.env.SEED_PHRASE;

if (!SEED_PHRASE) {
    throw new Error("Variável de ambiente SEED_PHRASE é obrigatória");
}

// Gera o keypair do fee payer a partir da seed phrase
const seedBuffer = Buffer.from(SEED_PHRASE);
const feePayer = Keypair.fromSeed(seedBuffer.slice(0, 32));

// Configuração da conexão Solana
const connection = new Connection(RPC_URL, 'confirmed');
const provider = new AnchorProvider(connection, { publicKey: feePayer.publicKey, signer: feePayer }, { commitment: 'confirmed' });

// Carrega o IDL do programa Anchor
const idl = require('./idl/ticketing_system.json');
const programId = new PublicKey("AEcgrC2sEtWX12zs1m7RemTdcr9QwBkMbJUXfC4oEd2M");
const program = new Program(idl, programId, provider);

// IDs de programas
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");

// Middleware de erro global
app.use((error, req, res, next) => {
    console.error('Erro não tratado:', error);
    res.status(500).json({
        error: 'Erro interno do servidor',
        message: error.message
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        fee_payer_address: feePayer.publicKey.toString(),
        network: RPC_URL
    });
});

// Endpoint para criar transação de mint
app.post('/create-mint-transaction', async (req, res) => {
    try {
        const { buyer_pubkey, event_pubkey, tier_index } = req.body;

        if (!buyer_pubkey || !event_pubkey || tier_index === undefined) {
            return res.status(400).json({
                error: 'Parâmetros obrigatórios: buyer_pubkey, event_pubkey, tier_index'
            });
        }

        const buyerPubkey = new PublicKey(buyer_pubkey);
        const eventPubkey = new PublicKey(event_pubkey);
        const tierIndex = parseInt(tier_index);

        // Gera um novo keypair para o mint
        const newMintKeypair = Keypair.generate();

        // Calcula todas as PDAs necessárias
        const [globalConfigPDA] = await PublicKey.findProgramAddress(
            [Buffer.from("config")],
            programId
        );

        const [refundReservePDA] = await PublicKey.findProgramAddress(
            [Buffer.from("refund_reserve"), eventPubkey.toBuffer()],
            programId
        );

        const [buyerTicketCountPDA] = await PublicKey.findProgramAddress(
            [Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), buyerPubkey.toBuffer()],
            programId
        );

        const [metadataPDA] = await PublicKey.findProgramAddress(
            [
                Buffer.from("metadata"),
                TOKEN_METADATA_PROGRAM_ID.toBuffer(),
                newMintKeypair.publicKey.toBuffer()
            ],
            TOKEN_METADATA_PROGRAM_ID
        );

        // Calcula a Associated Token Account
        const ataPDA = await getAssociatedTokenAddress(
            newMintKeypair.publicKey,
            buyerPubkey
        );

        const [ticketPDA] = await PublicKey.findProgramAddress(
            [Buffer.from("ticket"), eventPubkey.toBuffer(), newMintKeypair.publicKey.toBuffer()],
            programId
        );

        // Cria a transação usando Anchor
        const tx = await program.methods
            .mintTicket(tierIndex)
            .accounts({
                globalConfig: globalConfigPDA,
                event: eventPubkey,
                refundReserve: refundReservePDA,
                buyer: buyerPubkey,
                buyerTicketCount: buyerTicketCountPDA,
                mintAccount: newMintKeypair.publicKey,
                metadataAccount: metadataPDA,
                associatedTokenAccount: ataPDA,
                tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                ticket: ticketPDA
            })
            .transaction();

        // Configura o blockhash e fee payer
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = feePayer.publicKey;

        // Assina parcialmente a transação (apenas com o fee payer e o novo mint)
        tx.sign(feePayer, newMintKeypair);

        // Serializa a transação (sem todas as assinaturas)
        const serializedTx = tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false
        });

        const base64Tx = serializedTx.toString('base64');

        res.json({
            transaction: base64Tx,
            mint_public_key: newMintKeypair.publicKey.toString(),
            fee_payer: feePayer.publicKey.toString()
        });

    } catch (error) {
        console.error('Erro em /create-mint-transaction:', error);
        res.status(500).json({
            error: 'Falha ao criar transação',
            message: error.message
        });
    }
});

// Endpoint para finalizar transação assinada
app.post('/finalize-mint-transaction', async (req, res) => {
    try {
        const { signed_transaction } = req.body;

        if (!signed_transaction) {
            return res.status(400).json({
                error: 'Parâmetro signed_transaction é obrigatório'
            });
        }

        // Desserializa a transação assinada
        const transactionBuffer = Buffer.from(signed_transaction, 'base64');
        const transaction = Transaction.from(transactionBuffer);

        // Envia a transação para a blockchain
        const signature = await connection.sendRawTransaction(
            transaction.serialize(),
            { skipPreflight: false, preflightCommitment: 'confirmed' }
        );

        // Confirma a transação
        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash: transaction.recentBlockhash,
            lastValidBlockHeight: await connection.getBlockHeight()
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${confirmation.value.err}`);
        }

        res.json({
            status: 'success',
            transaction_signature: signature
        });

    } catch (error) {
        console.error('Erro em /finalize-mint-transaction:', error);
        res.status(500).json({
            error: 'Falha ao finalizar transação',
            message: error.message
        });
    }
});

// Handler para rotas não encontradas
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
});

// Configuração de porta e inicialização
const PORT = process.env.PORT || 5001;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Gasless rodando na porta ${PORT}`);
    console.log(`📍 Fee Payer: ${feePayer.publicKey.toString()}`);
    console.log(`🌐 RPC: ${RPC_URL}`);
});

// Handlers para encerramento graceful
process.on('SIGINT', () => {
    console.log('🛑 Recebido SIGINT. Encerrando graceful...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Recebido SIGTERM. Encerrando graceful...');
    process.exit(0);
});

// Handler para rejeições de promessas não tratadas
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Rejeição de promessa não tratada:', reason);
});

// Handler para exceções não capturadas
process.on('uncaughtException', (error) => {
    console.error('❌ Exceção não capturada:', error);
    process.exit(1);
});
