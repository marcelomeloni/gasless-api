import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { derivePath } from 'ed25519-hd-key';
import bip39 from 'bip39';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes/index.js';
import fs from 'fs';
import path from 'path';

import { PROGRAM_ID, SOLANA_RPC_URL, PAYER_MNEMONIC, __dirname } from '../config/index.js';
import { TOKEN_METADATA_PROGRAM_ID } from '../config/solana.js';

const { Program, AnchorProvider, Wallet } = anchor;

// Load IDL
const idlPath = path.resolve(__dirname, './ticketing_system.json');
const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));

export const getKeypairFromMnemonic = (mnemonic) => {
    const seed = bip39.mnemonicToSeedSync(mnemonic, "");
    const path = `m/44'/501'/0'/0'`;
    return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
};

// Initialize Solana connection
const payerKeypair = getKeypairFromMnemonic(PAYER_MNEMONIC);
const payerWallet = new Wallet(payerKeypair);
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const provider = new AnchorProvider(connection, payerWallet, AnchorProvider.defaultOptions());
const program = new Program(idl, PROGRAM_ID, provider);

console.log(`[+] Solana service configured with program: ${PROGRAM_ID.toString()}`);
console.log(`[+] Payer wallet: ${payerKeypair.publicKey.toString()}`);

export {
    connection,
    program,
    payerKeypair,
    payerWallet,
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
