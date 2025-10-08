import { program, PublicKey, connection, payerKeypair } from '../services/solanaService.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import supabase from '../services/supabaseService.js';
import anchor from '@coral-xyz/anchor';

import { getKeypairFromPrivateKey, getKeypairFromSeedPhrase, getKeypairFromCredentials } from '../lib/authUtils.js';

// Cache de keypairs para validadores (em produção, usar Redis ou database)
const validatorKeypairs = new Map();

/**
 * Obtém o keypair do validador baseado no tipo de autenticação
 */
async function getValidatorKeypair(validatorAddress, authType, authData) {
  const cacheKey = `${validatorAddress}-${authType}`;

  if (validatorKeypairs.has(cacheKey)) {
    console.log(`[AUTH] Usando keypair em cache para: ${validatorAddress}`);
    return validatorKeypairs.get(cacheKey);
  }

  try {
    console.log(`[AUTH] Derivando keypair para: ${validatorAddress}, tipo: ${authType}`);
    let keypair;

    switch (authType) {
      case 'privateKey':
        if (!authData?.privateKey) throw new Error('Private key não fornecida');
        keypair = getKeypairFromPrivateKey(authData.privateKey);
        break;

      case 'seedPhrase':
        if (!authData?.seedWords || !Array.isArray(authData.seedWords)) throw new Error('Seed phrase não fornecida ou formato inválido');
        keypair = await getKeypairFromSeedPhrase(authData.seedWords);
        break;

      case 'credentials':
        if (!authData?.username || !authData?.password) throw new Error('Username e password são obrigatórios');
        keypair = await getKeypairFromCredentials(authData.username, authData.password);
        break;

      case 'walletExtension':
        throw new Error('Wallet extension requer assinatura no frontend');

      default:
        throw new Error(`Tipo de autenticação não suportado: ${authType}`);
    }

    const derivedAddress = keypair.publicKey.toString();
    if (derivedAddress !== validatorAddress) {
      console.error(`[AUTH] Endereço derivado não corresponde: ${derivedAddress} vs ${validatorAddress}`);
      throw new Error('Keypair não corresponde ao endereço do validador');
    }

    console.log(`[AUTH] ✅ Keypair derivado com sucesso para: ${validatorAddress}`);
    validatorKeypairs.set(cacheKey, keypair);
    return keypair;
  } catch (error) {
    console.error(`[AUTH] ❌ Erro ao obter keypair para ${validatorAddress}:`, error.message);
    validatorKeypairs.delete(cacheKey);
    throw new Error(`Falha na autenticação do validador: ${error.message}`);
  }
}

/**
 * Cria e assina uma transação de validação
 */
async function createAndSignValidationTransaction(program, accounts, validatorKeypair) {
  try {
    console.log(`[SolanaService] 🖊️ Criando transação para validador: ${validatorKeypair.publicKey.toString()}`);

    const transaction = await program.methods.redeemTicket().accounts(accounts).transaction();

    const { blockhash } = await connection.getRecentBlockhash();

    transaction.feePayer = validatorKeypair.publicKey;
    transaction.recentBlockhash = blockhash;

    transaction.sign(validatorKeypair);

    console.log(`[SolanaService] ✅ Transação assinada pelo validador`);
    return transaction;
  } catch (error) {
    console.error('[SolanaService] ❌ Erro ao criar transação:', error);
    throw error;
  }
}


/**
 * Valida um ingresso por ID de registro (UUID), usando a carteira central 'Payer'
 * para cobrir os custos da transação (gasless).
 */
export const validateById = async (req, res) => {
    const { registrationId } = req.params;
    const { validatorAddress, authType, authData } = req.body;

    console.log(`[VALIDATION] Iniciando validação para: ${registrationId}`);
    console.log(`[VALIDATION] Validador: ${validatorAddress}, Tipo: ${authType}`);

    try {
        console.log('[1/7] Buscando registro no Supabase...');
        const { data: registration, error: dbError } = await supabase
            .from('registrations')
            .select('*')
            .eq('id', registrationId)
            .single();

        if (dbError || !registration) {
            console.error('[DB_ERROR] Erro ao buscar registro no Supabase:', dbError?.message);
            return res.status(404).json({ success: false, error: "Registro do ingresso não encontrado." });
        }

        console.log('[2/7] Registro encontrado:', {
            event: registration.event_address,
            mint: registration.nft_mint_address,
            name: registration.participant_name,
        });
        
        // Verificação de dados para evitar crash
        if (!registration.event_address || !registration.nft_mint_address || !registration.owner_address) {
            return res.status(400).json({ success: false, error: "Dados do registro estão incompletos no banco de dados (endereços faltando)." });
        }

        // ✅ CORREÇÃO: Usando anchor.web3
        const eventAddress = new anchor.web3.PublicKey(registration.event_address);
        const nftMintAddress = new anchor.web3.PublicKey(registration.nft_mint_address);
        const ownerAddress = new anchor.web3.PublicKey(registration.owner_address);

        // --- [3/7] & [4/7] Validando endereços e permissões ---
        console.log('[3/7] Validando endereços...');
        const eventAccount = await program.account.event.fetch(eventAddress);

        console.log('[4/7] Verificando permissões do validador...');
        const isAuthorized = eventAccount.validators.some(v => v.toString() === validatorAddress);
        if (!isAuthorized) {
            return res.status(403).json({ success: false, error: "Validador não autorizado para este evento." });
        }
        console.log(`[VALIDATION] ✅ Validador ${validatorAddress} autorizado.`);

        // --- [5/7] Buscando ingresso on-chain ---
        console.log('[5/7] Buscando ingresso on-chain...');
        // ✅ CORREÇÃO: Usando anchor.web3
        const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("ticket"), eventAddress.toBuffer(), nftMintAddress.toBuffer()],
            program.programId
        );

        const ticketAccount = await program.account.ticket.fetch(ticketPda);
        if (ticketAccount.redeemed) {
            return res.status(409).json({ success: false, error: "Este ingresso já foi validado." });
        }
        console.log(`[VALIDATION] ✅ Ingresso on-chain encontrado. Dono: ${ticketAccount.owner}`);

        // --- [6/7] Obtendo keypair do validador ---
        console.log('[6/7] Obtendo keypair do validador...');
        const validatorKeypair = await getValidatorKeypair(validatorAddress, authType, authData);

        // --- [7/7] Executando validação GASLESS ---
        console.log('[7/7] Preparando transação gasless...');

        const nftTokenAddress = getAssociatedTokenAddressSync(nftMintAddress, ownerAddress);

        const accounts = {
            ticket: ticketPda,
            event: eventAddress,
            validator: validatorKeypair.publicKey,
            owner: ownerAddress,
            nftToken: nftTokenAddress,
            nftMint: nftMintAddress,
        };
        
        const redeemInstruction = await program.methods
            .redeemTicket()
            .accounts(accounts)
            .instruction();

        const latestBlockhash = await connection.getLatestBlockhash('confirmed');

        // ✅ CORREÇÃO: Usando anchor.web3
        const transaction = new anchor.web3.Transaction({
            recentBlockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        });

        transaction.feePayer = payerKeypair.publicKey;
        transaction.add(redeemInstruction);
        transaction.sign(validatorKeypair, payerKeypair);

        const rawTransaction = transaction.serialize();
        console.log('[SolanaService] 🖊️ Enviando transação assinada...');
        const signature = await connection.sendRawTransaction(rawTransaction);

        await connection.confirmTransaction({
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        }, 'confirmed');

        console.log(`[VALIDATION] ✅ Ingresso validado com sucesso! Assinatura: ${signature}`);

        return res.status(200).json({
            success: true,
            message: `Entrada liberada para ${registration.participant_name || 'Participante'}!`,
            signature: signature,
            participantName: registration.participant_name || 'Participante',
        });

    } catch (error) {
        // ... seu bloco catch continua igual
        console.error("❌ Erro detalhado durante a validação:", error);
        // ...
        let errorMessage = "Ocorreu um erro desconhecido durante a validação.";
        if (error.message) { errorMessage = error.message; }
        if (error.logs) { console.error('--- LOGS DA BLOCKCHAIN ---'); console.error(error.logs); console.error('-------------------------'); }
        return res.status(500).json({ success: false, error: "Falha na validação do ingresso.", details: errorMessage });
    }
};

/**
 * Valida ingresso com transação assinada no frontend (wallet extensions)
 */
export const validateByIdWithFrontendSignature = async (req, res) => {
  const { registrationId } = req.params;
  const { validatorAddress, signedTransaction } = req.body;

  console.log(`[VALIDATION-FRONTEND] Validação com assinatura do frontend para: ${registrationId}`);
  console.log(`[VALIDATION-FRONTEND] Validador: ${validatorAddress}`);

  if (!registrationId || !validatorAddress || !signedTransaction) {
    return res.status(400).json({
      success: false,
      error: "ID do registro, endereço do validador e transação assinada são obrigatórios.",
    });
  }

  try {
    // Buscar registro no Supabase
    console.log(`[1/5] Buscando registro no Supabase...`);
    const { data: registration, error: dbError } = await supabase.from('registrations').select('*').eq('id', registrationId).single();
    if (dbError || !registration) {
      console.error('[VALIDATION-FRONTEND] Registro não encontrado:', registrationId);
      return res.status(404).json({ success: false, error: "Ingresso não encontrado." });
    }

    const { event_address, mint_address, registration_details } = registration;
    const participantName = registration_details?.name || 'Participante';

    // Validar endereços
    console.log(`[2/5] Validando endereços...`);
    const eventPubkey = new PublicKey(event_address);
    const validatorPubkey = new PublicKey(validatorAddress);

    // Verificar permissão do validador
    console.log(`[3/5] Verificando permissões do validador...`);
    const eventAccount = await program.account.event.fetch(eventPubkey);
    const isValidator = eventAccount.validators.some(v => v.equals(validatorPubkey));
    if (!isValidator) {
      console.warn(`[VALIDATION-FRONTEND] Validador não autorizado: ${validatorAddress}`);
      return res.status(403).json({ success: false, error: "Acesso negado. Esta carteira não é um validador autorizado." });
    }

    console.log(`[VALIDATION-FRONTEND] ✅ Validador ${validatorAddress} autorizado.`);

    // Enviar transação assinada
    console.log(`[4/5] Enviando transação assinada pelo frontend...`);
    const signature = await connection.sendRawTransaction(Buffer.from(signedTransaction, 'base64'));

    // Confirmar transação
    console.log(`[5/5] Confirmando transação: ${signature}...`);
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(`Transação falhou: ${confirmation.value.err}`);
    }

    console.log(`[SUCCESS] ✅ Ingresso validado via frontend! Assinatura: ${signature}`);
    console.log(`[SUCCESS] ✅ Participante: ${participantName}`);

    res.status(200).json({ success: true, signature, participantName });
  } catch (error) {
    console.error("[ERROR] ❌ Erro durante validação com frontend:", error);

    let errorMessage = error.message;
    try {
      if (error.logs) {
        const anchorError = anchor.AnchorError.parse(error.logs);
        if (anchorError) errorMessage = anchorError.error.errorMessage;
      }
    } catch {}

    res.status(500).json({ success: false, error: "Erro ao processar transação assinada.", details: errorMessage });
  }
};

/**
 * Busca ingressos validados para um evento
 */
export const getValidatedTickets = async (req, res) => {
  const { eventAddress } = req.params;

  if (!eventAddress) return res.status(400).json({ error: "Event address is required." });

  console.log(`[TICKETS] Buscando ingressos validados para evento: ${eventAddress}`);

  try {
    const eventPubkey = new PublicKey(eventAddress);

    const allTicketsForEvent = await program.account.ticket.all([{ memcmp: { offset: 8, bytes: eventPubkey.toBase58() } }]);

    console.log(`[TICKETS] Total de tickets encontrados: ${allTicketsForEvent.length}`);

    const redeemedTickets = allTicketsForEvent.filter(ticket => ticket.account.redeemed);
    console.log(`[TICKETS] Tickets validados: ${redeemedTickets.length}`);

    if (redeemedTickets.length === 0) return res.status(200).json([]);

    const ownerAddresses = redeemedTickets.map(ticket => ticket.account.owner.toString());
    console.log(`[TICKETS] Buscando perfis para: ${ownerAddresses.length} endereços`);

    const { data: profiles, error: profilesError } = await supabase.from('profiles').select('wallet_address, name').in('wallet_address', ownerAddresses);
    if (profilesError) console.error('[TICKETS] Erro ao buscar perfis:', profilesError);

    const profilesMap = new Map(profiles?.map(p => [p.wallet_address, p.name]) || []);

    const validatedEntries = redeemedTickets.map(ticket => {
      const ownerAddress = ticket.account.owner.toString();
      const redeemedAt = new Date(ticket.account.redeemedAt * 1000);

      return {
        owner: ownerAddress,
        name: profilesMap.get(ownerAddress) || 'Participante',
        redeemedAt: redeemedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        redeemedAtFull: redeemedAt.toISOString(),
        nftMint: ticket.account.nftMint.toString(),
      };
    });

    validatedEntries.sort((a, b) => new Date(b.redeemedAtFull) - new Date(a.redeemedAtFull));

    console.log(`[TICKETS] ✅ Retornando ${validatedEntries.length} entradas validadas`);
    res.status(200).json(validatedEntries);
  } catch (error) {
    console.error("[ERROR] ❌ Erro ao buscar tickets validados:", error);
    res.status(500).json({ error: "Erro ao buscar tickets validados.", details: error.message });
  }
};

/**
 * Limpa cache de keypairs (desenvolvimento)
 */
export const clearKeypairCache = async (req, res) => {
  const count = validatorKeypairs.size;
  validatorKeypairs.clear();
  console.log(`[CACHE] ✅ Cache limpo. ${count} keypairs removidos.`);
  res.status(200).json({ success: true, message: `Cache limpo. ${count} keypairs removidos.` });
};
