// src/services/solanaService.js
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { derivePath } from 'ed25519-hd-key';
import bip39 from 'bip39';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { SOLANA_RPC_URL, PAYER_MNEMONIC } from '../config/index.js';
import { TOKEN_METADATA_PROGRAM_ID, PROGRAM_ID } from '../config/solana.js';

// 👉 PASSO 1: Declare as variáveis no nível superior (top-level)
let connection;
let program;
let payerKeypair;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log(`[SolanaService] Iniciando configuração do serviço Solana...`);
console.log(`[SolanaService] RPC URL: ${SOLANA_RPC_URL}`);
console.log(`[SolanaService] PROGRAM_ID: ${PROGRAM_ID}`);

// Validar PROGRAM_ID antes de usar
let programIdPublicKey;
try {
    if (!PROGRAM_ID) {
        throw new Error('PROGRAM_ID não está definido nas variáveis de ambiente');
    }
    programIdPublicKey = new PublicKey(PROGRAM_ID);
    console.log(`[SolanaService] ✅ PROGRAM_ID válido: ${programIdPublicKey.toString()}`);
} catch (error) {
    console.error(`[SolanaService] ❌ Erro ao criar PublicKey do PROGRAM_ID:`, error.message);
    console.log(`[SolanaService] PROGRAM_ID fornecido: "${PROGRAM_ID}"`);
    throw new Error(`PROGRAM_ID inválido: ${error.message}`);
}

export const getKeypairFromMnemonic = (mnemonic) => {
    console.log(`[SolanaService] Gerando keypair do pagador...`);
    try {
        if (!mnemonic) {
            throw new Error('Mnemonic do pagador não está definido');
        }
        const seed = bip39.mnemonicToSeedSync(mnemonic, "");
        const derivationPath = `m/44'/501'/0'/0'`;
        const keypair = Keypair.fromSeed(derivePath(derivationPath, seed.toString('hex')).key);
        console.log(`[SolanaService] ✅ Keypair gerado: ${keypair.publicKey.toString()}`);
        return keypair;
    } catch (error) {
        console.error(`[SolanaService] ❌ Erro ao gerar keypair:`, error.message);
        throw new Error(`Falha ao gerar keypair do pagador: ${error.message}`);
    }
};

// Bloco principal de inicialização
try {
    console.log(`[SolanaService] Inicializando conexão Solana...`);

    // 👉 PASSO 2: Atribua valores às variáveis já declaradas
    payerKeypair = getKeypairFromMnemonic(PAYER_MNEMONIC);
    connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    console.log(`[SolanaService] ✅ Conexão Solana inicializada`);
    console.log(`[SolanaService] Network: ${SOLANA_RPC_URL}`);
    console.log(`[SolanaService] Payer: ${payerKeypair.publicKey.toString()}`);

    const wallet = {
        publicKey: payerKeypair.publicKey,
        signTransaction: async (transaction) => {
            console.log(`[SolanaService] 🖊️  Assinando transação...`);
            transaction.partialSign(payerKeypair);
            return transaction;
        },
        signAllTransactions: async (transactions) => {
            console.log(`[SolanaService] 🖊️  Assinando ${transactions.length} transações...`);
            return transactions.map(transaction => {
                transaction.partialSign(payerKeypair);
                return transaction;
            });
        }
    };

    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed'
    });

    anchor.setProvider(provider);
    console.log(`[SolanaService] ✅ Anchor provider configurado`);

    const idlPath = path.resolve(__dirname, '../config/ticketing_system.json');
    console.log(`[SolanaService] Carregando IDL do programa...`);
    console.log(`[SolanaService] Caminho do IDL: ${idlPath}`);

    if (!fs.existsSync(idlPath)) {
        throw new Error(`Arquivo IDL não encontrado em: ${idlPath}`);
    }

    const idlFileContent = fs.readFileSync(idlPath, 'utf8');
    if (!idlFileContent || idlFileContent.trim() === '') {
        throw new Error('Arquivo IDL está vazio');
    }

    const idl = JSON.parse(idlFileContent);
    if (!idl.address || !idl.metadata || !idl.instructions) {
        console.warn(`[SolanaService] ⚠️  Estrutura do IDL pode estar incompleta:`, {
            hasAddress: !!idl.address,
            hasMetadata: !!idl.metadata,
            hasInstructions: !!idl.instructions,
            instructionCount: idl.instructions ? idl.instructions.length : 0
        });
    }

    console.log(`[SolanaService] Criando programa Anchor...`);
    // Atribui o valor à variável 'program'
    program = new anchor.Program(idl, programIdPublicKey, provider);

    console.log(`[SolanaService] ✅ Programa Anchor carregado com sucesso!`);
    console.log(`[SolanaService] Program ID: ${program.programId.toString()}`);
    console.log(`[SolanaService] Payer: ${payerKeypair.publicKey.toString()}`);

} catch (error) {
    console.error('❌[SolanaService] Erro crítico na inicialização do serviço Solana:', {
        error: error.message,
        stack: error.stack
    });
    // Se a inicialização falhar, o processo deve parar
    process.exit(1);
}

// 👉 PASSO 3: Exporte tudo no final do arquivo, em um único bloco
export {
    connection,
    program,
    payerKeypair,
    // Note que getKeypairFromMnemonic já é exportada, mas é bom manter aqui para centralizar
    SystemProgram,
    SYSVAR_RENT_PUBKEY,
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    Keypair,
    PublicKey,
    bs58,
    TOKEN_METADATA_PROGRAM_ID
};
