import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = process.env.PORT || 3001;
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
export const PAYER_MNEMONIC = process.env.PAYER_MNEMONIC;
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
export const PINATA_JWT = process.env.PINATA_JWT;
export const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
export const API_URL = process.env.API_URL || 'https://gasless-api-997m.onrender.com';
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
export const PROGRAM_ID = process.env.PROGRAM_ID;
// Validations
if (!SOLANA_RPC_URL || !PAYER_MNEMONIC || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Required environment variables are missing (Solana or Supabase).");
}
if (!PINATA_JWT) {
    throw new Error("PINATA_JWT environment variable is required.");
}
if (!MERCADOPAGO_ACCESS_TOKEN) {
    throw new Error("MERCADOPAGO_ACCESS_TOKEN environment variable is required.");
}

export { __dirname };
