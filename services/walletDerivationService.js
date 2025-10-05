// src/services/walletDerivationService.js
import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import bs58 from 'bs58';
import crypto from 'crypto';

// Função para derivar keypair de seedphrase (igual ao frontend)
export const getKeypairFromSeedphrase = async (seedWords) => {
    const mnemonic = seedWords.join(' ').trim().toLowerCase();
    
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error('Seedphrase inválida');
    }

    const seed = await bip39.mnemonicToSeed(mnemonic);
    const path = "m/44'/501'/0'/0'";
    const derivedSeed = derivePath(path, seed.toString('hex')).key;
    
    return Keypair.fromSeed(derivedSeed.slice(0, 32));
};

// Função para derivar keypair de private key (igual ao frontend)
export const getKeypairFromPrivateKey = async (privateKey) => {
    try {
        // Tenta decodificar como base58 (formato comum do Solana)
        const secretKey = bs58.decode(privateKey.trim());
        return Keypair.fromSecretKey(secretKey);
    } catch (e) {
        try {
            // Tenta como hex string
            const hexString = privateKey.trim();
            if (hexString.length === 64 || hexString.length === 128) {
                const secretKey = Uint8Array.from(Buffer.from(hexString, 'hex'));
                return Keypair.fromSecretKey(secretKey);
            }
            throw new Error('Formato de private key inválido');
        } catch (hexError) {
            throw new Error('Private key inválida. Use base58 ou hex format');
        }
    }
};

// Função para derivar keypair de username/password (igual ao frontend)
export const getKeypairFromCredentials = async (username, password) => {
    return new Promise((resolve, reject) => {
        const salt = username;
        crypto.pbkdf2(password, salt, 100000, 32, 'sha256', (err, derivedKey) => {
            if (err) reject(err);
            else {
                const keypair = Keypair.fromSeed(new Uint8Array(derivedKey));
                resolve(keypair);
            }
        });
    });
};

// Função principal para derivar keypair baseado no tipo de login
export const deriveUserKeypair = async (loginData) => {
    const { loginType, username, password, seedPhrase, privateKey } = loginData;
    
    console.log(` -> Derivando keypair do tipo: ${loginType}`);
    
    switch (loginType) {
        case 'credentials':
            if (!username || !password) {
                throw new Error('Credenciais incompletas para derivação');
            }
            return await getKeypairFromCredentials(username, password);
            
        case 'seedphrase':
            if (!seedPhrase || !Array.isArray(seedPhrase)) {
                throw new Error('Seed phrase inválida para derivação');
            }
            return await getKeypairFromSeedphrase(seedPhrase);
            
        case 'privateKey':
            if (!privateKey) {
                throw new Error('Private key inválida para derivação');
            }
            return await getKeypairFromPrivateKey(privateKey);
            
        default:
            throw new Error('Tipo de login não suportado para derivação no backend');
    }
};
