// src/lib/authUtils.js
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Deriva uma semente de 32 bytes de um username e senha usando PBKDF2 da Web Crypto API.
 * Esta abordagem é nativa do navegador e evita problemas de importação com o Vite.
 * @param {string} username - O nome de usuário, usado como "salt" para a derivação.
 * @param {string} password - A senha do usuário.
 * @returns {Promise<Uint8Array>} Uma promessa que resolve para a semente de 32 bytes (Uint8Array).
 */
export const deriveKeyFromCredentials = async (username, password) => {
  const passwordBytes = new TextEncoder().encode(password);
  const salt = new TextEncoder().encode(username);

  // 2. Importamos a senha como uma chave "crua" que pode ser usada para derivação.
  const masterKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  // 3. Derivamos os bits usando PBKDF2 com parâmetros seguros.
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000, // Número de iterações. Padrão seguro.
      hash: 'SHA-256',
    },
    masterKey,
    256 // O tamanho da saída em bits (256 bits = 32 bytes).
  );

  // O resultado é um ArrayBuffer, que convertemos para o Uint8Array esperado.
  return new Uint8Array(derivedBits);
};

/**
 * Gera um Keypair da Solana a partir de credenciais.
 * Combina a derivação da chave e a criação do Keypair em uma única função.
 * @param {string} username - O nome de usuário.
 * @param {string} password - A senha.
 * @returns {Promise<Keypair>} Uma promessa que resolve para o objeto Keypair da Solana.
 */
export const getKeypairFromCredentials = async (username, password) => {
    const seed = await deriveKeyFromCredentials(username, password);
    const keypair = Keypair.fromSeed(seed);
    return keypair;
};

/**
 * Deriva um Keypair a partir de uma seed phrase (12 palavras)
 * @param {string[]} seedWords - Array com as 12 palavras da seed phrase
 * @returns {Promise<Keypair>} Uma promessa que resolve para o objeto Keypair da Solana.
 */
export const getKeypairFromSeedPhrase = async (seedWords) => {
  try {
    // Junta as palavras em uma string
    const seedPhrase = seedWords.join(' ').trim().toLowerCase();
    
    // Cria um hash SHA-256 da seed phrase para usar como seed
    const encoder = new TextEncoder();
    const data = encoder.encode(seedPhrase);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    
    // Pega os primeiros 32 bytes do hash como seed
    const hashArray = new Uint8Array(hashBuffer);
    const seed = hashArray.slice(0, 32);
    
    return Keypair.fromSeed(seed);
  } catch (error) {
    throw new Error('Falha ao derivar keypair da seed phrase: ' + error.message);
  }
};

/**
 * Deriva um Keypair a partir de uma private key (base58 ou hex)
 * @param {string} privateKey - A private key em formato base58 ou hex
 * @returns {Keypair} O keypair derivado da private key
 */
export const getKeypairFromPrivateKey = (privateKey) => {
  try {
    // Remove espaços e quebras de linha
    const cleanedKey = privateKey.trim();
    
    // Tenta decodificar como base58 primeiro (formato mais comum do Solana)
    try {
      const privateKeyBytes = bs58.decode(cleanedKey);
      
      // Verifica se tem o tamanho correto (64 bytes para Solana keypair)
      if (privateKeyBytes.length === 64) {
        return Keypair.fromSecretKey(privateKeyBytes);
      }
    } catch (base58Error) {
      // Se falhar com base58, tenta como hex
      console.log('Tentando decodificar como hex...');
    }
    
    // Tenta como hex string
    if (cleanedKey.length === 128 || cleanedKey.length === 64) {
      // Remove prefixo '0x' se existir
      const hexString = cleanedKey.startsWith('0x') ? cleanedKey.slice(2) : cleanedKey;
      
      // Converte hex string para Uint8Array
      const privateKeyBytes = new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      
      if (privateKeyBytes.length === 64) {
        return Keypair.fromSecretKey(privateKeyBytes);
      } else if (privateKeyBytes.length === 32) {
        // Se for apenas a chave privada (32 bytes), cria o keypair a partir dela
        return Keypair.fromSecretKey(privateKeyBytes);
      }
    }
    
    throw new Error('Formato de private key não reconhecido. Use base58 ou hex.');
    
  } catch (error) {
    throw new Error('Falha ao derivar keypair da private key: ' + error.message);
  }
};

/**
 * Função auxiliar para codificar bytes em base58
 * @param {Uint8Array} buffer - Array de bytes para codificar
 * @returns {string} String codificada em base58
 */
export const encodeBase58 = (buffer) => {
  return bs58.encode(buffer);
};

/**
 * Função auxiliar para decodificar base58
 * @param {string} str - String em base58 para decodificar
 * @returns {Uint8Array} Array de bytes decodificado
 */
export const decodeBase58 = (str) => {
  return bs58.decode(str);
};
