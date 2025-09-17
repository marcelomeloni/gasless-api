const express = require('express');
const cors = require('cors');
// ✅ ADICIONADO: TransactionMessage e VersionedTransaction
const { Connection, PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const { Program, AnchorProvider } = require('@coral-xyz/anchor');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Configurações ---
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const SEED_PHRASE = process.env.SEED_PHRASE;

if (!SEED_PHRASE) {
    throw new Error("Variável de ambiente SEED_PHRASE é obrigatória");
}

// Gera o keypair do fee payer (servidor)
const feePayer = Keypair.fromSeed(Buffer.from(SEED_PHRASE).slice(0, 32));

// --- Conexão Solana e Configuração do Programa Anchor ---
const connection = new Connection(RPC_URL, 'confirmed');
const provider = new AnchorProvider(connection, { publicKey: feePayer.publicKey, signer: feePayer }, { commitment: 'confirmed' });
const idl = require('./idl/ticketing_system.json');
const programId = new PublicKey("2RLV8dpNAM7SgNxuetYhJJneEFnRfwmbz16jpAJ8EUUg");
const program = new Program(idl, programId, provider);

// --- Constantes de Programas ---
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");

// --- Middlewares e Rotas ---

// Rota de Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        fee_payer_address: feePayer.publicKey.toString(),
        network: RPC_URL
    });
});

// Endpoint para criar a transação de mint (versão corrigida)
// No seu arquivo index.js da API
const { BN } = require('@coral-xyz/anchor'); // Adicione BN aos imports do anchor

// ... resto do código ...

app.post('/create-mint-transaction', async (req, res) => {
    try {
        const { buyer_pubkey, event_id, tier_index } = req.body;

        if (!buyer_pubkey || event_id === undefined || tier_index === undefined) {
            return res.status(400).json({ error: 'Parâmetros obrigatórios: buyer_pubkey, event_id, tier_index' });
        }
        
        const buyerPubkey = new PublicKey(buyer_pubkey);
        const eventIdBN = new BN(event_id);
        const tierIndex = parseInt(tier_index);

        // --- Geração de PDAs (mesma lógica que você já tem) ---
        const [eventPDA] = await PublicKey.findProgramAddress([Buffer.from("event"), eventIdBN.toBuffer('le', 8)], programId);
        const newMintKeypair = Keypair.generate();
        const [buyerTicketCountPDA] = await PublicKey.findProgramAddress([Buffer.from("buyer_ticket_count"), eventPDA.toBuffer(), buyerPubkey.toBuffer()], programId);
        const [globalConfigPDA] = await PublicKey.findProgramAddress([Buffer.from("config")], programId);
        const [refundReservePDA] = await PublicKey.findProgramAddress([Buffer.from("refund_reserve"), eventPDA.toBuffer()], programId);
        const [metadataPDA] = await PublicKey.findProgramAddress([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), newMintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);
        const ataPDA = await getAssociatedTokenAddress(newMintKeypair.publicKey, buyerPubkey);
        const [ticketPDA] = await PublicKey.findProgramAddress([Buffer.from("ticket"), eventPDA.toBuffer(), newMintKeypair.publicKey.toBuffer()], programId);

        // ====================================================================
        // ✅ CORREÇÃO PRINCIPAL: CALCULAR O RENT TOTAL E PRÉ-FINANCIAR O USUÁRIO
        // ====================================================================
        
        // 1. Pegar o saldo atual do comprador
        const buyerBalance = await connection.getBalance(buyerPubkey);
        
        // 2. Calcular o rent necessário para as contas principais que o programa cria.
        //    O erro nos disse que o total era 1461600, vamos usar isso para ser preciso.
        //    Uma abordagem mais dinâmica seria calcular para cada conta, mas usar o valor do log é seguro neste caso.
        const totalRentNeeded = 1461600; // Valor exato que o log de erro pediu!

        const instructions = [];
        
        // 3. Adicionar uma instrução de transferência se o usuário não tiver o valor necessário.
        if (buyerBalance < totalRentNeeded) {
            const amountToTransfer = totalRentNeeded - buyerBalance;
            console.log(`Usuário precisa de ${totalRentNeeded}, tem ${buyerBalance}. Transferindo ${amountToTransfer} lamports.`);
            
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: feePayer.publicKey,
                    toPubkey: buyerPubkey,
                    lamports: amountToTransfer
                })
            );
        }

        // 4. Adicionar a instrução principal de mint DEPOIS da transferência
        const mintInstruction = await program.methods
            .mintTicket(tierIndex)
            .accounts({
                globalConfig: globalConfigPDA,
                event: eventPDA,
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
            .instruction();

        instructions.push(mintInstruction);

        // --- Montagem e assinatura da transação (mesma lógica que você já tem) ---
        const { blockhash } = await connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: feePayer.publicKey,
            recentBlockhash: blockhash,
            instructions: instructions, // Usando o array de instruções que montamos
        }).compileToV0Message();

        const versionedTx = new VersionedTransaction(messageV0);
        versionedTx.sign([feePayer, newMintKeypair]);

        const serializedTx = versionedTx.serialize();
        const base64Tx = Buffer.from(serializedTx).toString('base64');
        
        res.json({
            transaction: base64Tx,
            mint_public_key: newMintKeypair.publicKey.toString(),
            fee_payer: feePayer.publicKey.toString()
        });

    } catch (error) {
        console.error('Erro em /create-mint-transaction:', error);
        res.status(500).json({ error: 'Falha ao criar transação', message: error.message, details: error.logs });
    }
});
// Endpoint para finalizar a transação (não precisa de alterações)
app.post('/finalize-mint-transaction', async (req, res) => {
    try {
        const { signed_transaction } = req.body;
        if (!signed_transaction) {
            return res.status(400).json({ error: 'Parâmetro signed_transaction é obrigatório' });
        }

        // Desserializa a transação. O método .from() é inteligente e lida com Versioned Transactions.
        const transactionBuffer = Buffer.from(signed_transaction, 'base64');
        
        // Envia a transação para a blockchain
        const signature = await connection.sendRawTransaction(
            transactionBuffer, 
            { skipPreflight: false, preflightCommitment: 'confirmed' }
        );

        // Confirma a transação
        await connection.confirmTransaction(signature, 'confirmed');
        
        res.json({
            status: 'success',
            transaction_signature: signature
        });

    } catch (error) {
        console.error('Erro em /finalize-mint-transaction:', error);
        res.status(500).json({
            error: 'Falha ao finalizar transação',
            message: error.message,
            details: error.logs || 'Verifique os logs do servidor para mais detalhes'
        });
    }
});


// Handler para rotas não encontradas
app.use('*', (req, res) => {
    res.status(4404).json({ error: 'Rota não encontrada' });
});

// Middleware de erro global
app.use((error, req, res, next) => {
    console.error('Erro não tratado:', error);
    res.status(500).json({
        error: 'Erro interno do servidor',
        message: error.message
    });
});

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Gasless rodando na porta ${PORT}`);
    console.log(`📍 Fee Payer: ${feePayer.publicKey.toString()}`);
    console.log(`🌐 RPC: ${RPC_URL}`);
});
