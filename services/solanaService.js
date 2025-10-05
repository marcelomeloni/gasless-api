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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { SOLANA_RPC_URL, PAYER_MNEMONIC, PROGRAM_ID } from '../config/index.js';
import { TOKEN_METADATA_PROGRAM_ID } from '../config/solana.js';

const getKeypairFromMnemonic = (mnemonic) => {
    const seed = bip39.mnemonicToSeedSync(mnemonic, "");
    const path = `m/44'/501'/0'/0'`;
    return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
};

// Initialize Solana connection
const payerKeypair = getKeypairFromMnemonic(PAYER_MNEMONIC);
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Create a simple wallet for the provider
const wallet = {
    publicKey: payerKeypair.publicKey,
    signTransaction: async (transaction) => {
        transaction.partialSign(payerKeypair);
        return transaction;
    },
    signAllTransactions: async (transactions) => {
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

// Load IDL
let program;
try {
    const idlPath = path.resolve(__dirname, '../config/ticketing_system.json');
    const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
    program = new anchor.Program(idl, PROGRAM_ID, provider);
    console.log(`[+] Solana service configured with program: ${PROGRAM_ID.toString()}`);
    console.log(`[+] Payer wallet: ${payerKeypair.publicKey.toString()}`);
} catch (error) {
    console.error('❌ Erro ao carregar programa:', error);
    throw new Error('IDL do programa não encontrado ou inválido');
}

export {
    connection,
    program,
    payerKeypair,
      getKeypairFromMnemonic, 
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
