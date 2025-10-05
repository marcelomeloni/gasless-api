import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes/index.js';
import { createHash } from 'crypto';
import { saveRegistrationData } from './supabaseService.js';
import { sendTicketEmail } from './emailService.js';

const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export const getKeypairFromMnemonic = (mnemonic) => {
    const seed = bip39.mnemonicToSeedSync(mnemonic, "");
    const path = `m/44'/501'/0'/0'`;
    return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
};

export const processPaidTicketForNewUser = async ({ 
    eventAddress, 
    tierIndex, 
    formData, 
    priceBRLCents, 
    userEmail, 
    userName,
    program,
    payerKeypair 
}) => {
    try {
        const { name, phone, email, company, sector, role } = formData;

        // 1. Geração da nova carteira para o usuário
        const mnemonic = bip39.generateMnemonic();
        const newUserKeypair = getKeypairFromMnemonic(mnemonic);
        const newUserPublicKey = newUserKeypair.publicKey;
        const privateKey = bs58.encode(newUserKeypair.secretKey);
        
        // 2. Lógica on-chain para mintar o ingresso
        const eventPubkey = new PublicKey(eventAddress);
        const eventAccount = await program.account.event.fetch(eventPubkey);

        const userDataString = [name, phone, email, company, sector, role].map(s => (s || "").trim()).join('|');
        const dataHash = createHash('sha256').update(userDataString).digest();
        
        // Registrar usuário on-chain
        const [userProfilePda] = PublicKey.findProgramAddressSync([Buffer.from("user_profile"), newUserPublicKey.toBuffer()], program.programId);
        await program.methods.registerUser(Array.from(dataHash)).accounts({
            authority: newUserPublicKey, userProfile: userProfilePda,
            payer: payerKeypair.publicKey, systemProgram: SystemProgram.programId,
        }).rpc();

        const [buyerTicketCountPda] = PublicKey.findProgramAddressSync([Buffer.from("buyer_ticket_count"), eventPubkey.toBuffer(), newUserPublicKey.toBuffer()], program.programId);
        await program.methods.createBuyerCounter().accounts({
            payer: payerKeypair.publicKey, event: eventPubkey, buyer: newUserPublicKey,
            buyerTicketCount: buyerTicketCountPda, systemProgram: SystemProgram.programId
        }).rpc();
        
        const mintKeypair = Keypair.generate();
        const mintAddress = mintKeypair.publicKey.toString();
        
        const [globalConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
        const [ticketPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), eventPubkey.toBuffer(), mintKeypair.publicKey.toBuffer()], program.programId);
        const associatedTokenAccount = await getAssociatedTokenAddress(mintKeypair.publicKey, newUserPublicKey);
        const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], TOKEN_METADATA_PROGRAM_ID);

        const signature = await program.methods.mintTicket(tierIndex).accounts({
            globalConfig: globalConfigPda, event: eventPubkey, payer: payerKeypair.publicKey, buyer: newUserPublicKey,
            mintAccount: mintKeypair.publicKey, ticket: ticketPda, buyerTicketCount: buyerTicketCountPda,
            associatedTokenAccount, metadataAccount: metadataPda, metadataProgram: TOKEN_METADATA_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        }).signers([payerKeypair, mintKeypair]).rpc();
        
        console.log(`[✔] Paid ticket minted successfully! Sig: ${signature}`);
        
        // 3. Salva tudo no banco de dados
        const registrationId = await saveRegistrationData({
            eventAddress,
            wallet_address: newUserPublicKey.toString(),
            mint_address: mintAddress,
            name, phone, email, company, sector, role
        });

        // 4. Envio de e-mail
        if (email) {
            try {
                const metadataResponse = await fetch(eventAccount.metadataUri);
                const metadata = await metadataResponse.json();
                const ticketDataForEmail = {
                    eventName: metadata.name, 
                    eventDate: metadata.properties.dateTime.start,
                    eventLocation: metadata.properties.location, 
                    mintAddress: mintAddress,
                    seedPhrase: mnemonic, 
                    privateKey: privateKey, 
                    eventImage: metadata.image,
                    registrationId: registrationId,
                    isPaid: true,
                    paymentAmount: (priceBRLCents / 100).toFixed(2)
                };
                sendTicketEmail({ name, email }, ticketDataForEmail);
            } catch(e) {
                console.error("Falha ao enviar e-mail (mas o mint funcionou):", e);
            }
        }

        return {
            success: true, 
            publicKey: newUserPublicKey.toString(), 
            seedPhrase: mnemonic, 
            privateKey: privateKey, 
            mintAddress: mintAddress, 
            signature,
            registrationId: registrationId,
            isPaid: true
        };

    } catch (error) {
        console.error("[✘] Error during paid ticket processing:", error);
        throw error;
    }
};
