import { program, PublicKey, connection, payerKeypair } from '../services/solanaService.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import supabase from '../services/supabaseService.js';
import anchor from '@coral-xyz/anchor';
import { getKeypairFromPrivateKey, getKeypairFromSeedPhrase, getKeypairFromCredentials } from '../lib/authUtils.js';

// Cache de keypairs para validadores
const validatorKeypairs = new Map();
/**
 * Busca informações do ingresso sem validar (para preview)
 */
/**
 * Busca informações do ingresso sem validar (para preview)
 */
export const getTicketInfo = async (req, res) => {
  const { registrationId } = req.params;

  console.log(`[TICKET-INFO] Buscando informações para: ${registrationId}`);

  try {
    // ETAPAS 1 & 2: Buscar dados do registro e perfil no Supabase
    console.log('[1/4] Buscando registro na tabela `registrations`...');
    const { data: registration, error: regError } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    if (regError || !registration) {
      throw new Error(`Registro do ingresso não encontrado: ${regError?.message || 'não existe'}`);
    }

    console.log(`[2/4] Buscando perfil na tabela \`profiles\` (ID: ${registration.profile_id})...`);
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('wallet_address, name')
      .eq('id', registration.profile_id)
      .single();

    if (profileError || !profile) {
      throw new Error(`Perfil do dono do ingresso não encontrado: ${profileError?.message || 'não existe'}`);
    }

    // ETAPA 3: Buscar dados do evento com tratamento de erro
    console.log('[3/4] Buscando dados do evento...');
    const eventAddress = new anchor.web3.PublicKey(registration.event_address);
    
    let eventAccount = null;
    let eventMetadata = {};
    
    try {
      eventAccount = await program.account.event.fetch(eventAddress);
      console.log('[TICKET-INFO] ✅ Dados do evento carregados com sucesso');
    } catch (error) {
      console.warn('[TICKET-INFO] ❌ Não foi possível carregar dados on-chain do evento:', error.message);
      // Continuamos mesmo sem os dados on-chain
    }

    // Buscar metadados do evento se disponível
    try {
      const { data: eventData } = await supabase
        .from('events')
        .select('name, metadata')
        .eq('address', registration.event_address)
        .single();
      
      if (eventData) {
        eventMetadata = eventData.metadata || {};
        console.log('[TICKET-INFO] ✅ Metadados do evento encontrados');
      }
    } catch (error) {
      console.log('[TICKET-INFO] Metadados do evento não encontrados, usando dados básicos');
    }

    // ETAPA 4: Verificar status on-chain do ingresso
    console.log('[4/4] Verificando status do ingresso on-chain...');
    const mintAddress = new anchor.web3.PublicKey(registration.mint_address);
    
    let isRedeemed = false;
    try {
      const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), eventAddress.toBuffer(), mintAddress.toBuffer()],
        program.programId
      );
      
      const ticketAccount = await program.account.ticket.fetch(ticketPda);
      isRedeemed = ticketAccount.redeemed;
      console.log(`[TICKET-INFO] Status do ingresso: ${isRedeemed ? 'VALIDADO' : 'NÃO VALIDADO'}`);
    } catch (error) {
      console.warn('[TICKET-INFO] Não foi possível verificar status on-chain, assumindo não validado');
      isRedeemed = false;
    }

    // ✅ CORREÇÃO: Usar operador de encadeamento opcional para evitar erros
    const eventDetails = eventAccount ? {
      totalTickets: eventAccount.totalTickets?.toString() || '0',
      ticketsSold: eventAccount.ticketsSold?.toString() || '0',
      validators: eventAccount.validators ? eventAccount.validators.map(v => v.toString()) : []
    } : {
      totalTickets: '0',
      ticketsSold: '0',
      validators: []
    };

    // Consolidar dados para resposta
    const ticketInfo = {
      registrationId,
      participantName: registration.registration_details?.name || profile.name || 'Participante',
      ownerAddress: profile.wallet_address,
      ownerName: profile.name,
      eventName: eventMetadata.name || `Evento ${registration.event_address.slice(0, 8)}...`,
      eventAddress: registration.event_address,
      mintAddress: registration.mint_address,
      isRedeemed,
      registrationDetails: registration.registration_details,
      eventDetails
    };

    console.log(`[TICKET-INFO] ✅ Informações encontradas para: ${ticketInfo.participantName}`);
    console.log(`[TICKET-INFO] - Evento: ${ticketInfo.eventName}`);
    console.log(`[TICKET-INFO] - Status: ${ticketInfo.isRedeemed ? 'VALIDADO' : 'NÃO VALIDADO'}`);
    console.log(`[TICKET-INFO] - Participante: ${ticketInfo.participantName}`);
    
    return res.status(200).json({
      success: true,
      ...ticketInfo
    });

  } catch (error) {
    console.error("❌ Erro ao buscar informações do ingresso:", error);
    
    let statusCode = 500;
    let errorMessage = error.message || "Ocorreu um erro ao buscar informações do ingresso.";
    
    if (error.message.includes("não encontrado")) {
      statusCode = 404;
    }

    // Log mais detalhado para debugging
    console.error("❌ Stack trace:", error.stack);
    
    return res.status(statusCode).json({ 
      success: false, 
      error: "Falha ao buscar informações do ingresso.", 
      details: errorMessage 
    });
  }
};
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
        if (!authData?.seedWords || !Array.isArray(authData.seedWords)) {
          throw new Error('Seed phrase não fornecida ou formato inválido');
        }
        keypair = await getKeypairFromSeedPhrase(authData.seedWords);
        break;

      case 'credentials':
        if (!authData?.username || !authData?.password) {
          throw new Error('Username e password são obrigatórios');
        }
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
 * Busca dados do registro e perfil no Supabase
 */
async function fetchRegistrationData(registrationId) {
  console.log('[1/7] Buscando registro na tabela `registrations`...');
  const { data: registration, error: regError } = await supabase
    .from('registrations')
    .select('*')
    .eq('id', registrationId)
    .single();

  if (regError || !registration) {
    throw new Error(`Registro do ingresso não encontrado: ${regError?.message || 'não existe'}`);
  }

  console.log(`[2/7] Buscando perfil na tabela \`profiles\` (ID: ${registration.profile_id})...`);
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('wallet_address')
    .eq('id', registration.profile_id)
    .single();

  if (profileError || !profile) {
    throw new Error(`Perfil do dono do ingresso não encontrado: ${profileError?.message || 'não existe'}`);
  }

  return { registration, profile };
}

/**
 * Valida dados críticos do registro
 */
function validateRegistrationData(registration, profile) {
  const { event_address, mint_address, registration_details } = registration;
  const ownerAddressStr = profile.wallet_address;
  const participantName = registration_details?.name || 'Participante';

  console.log('[2.5/7] Dados combinados com sucesso:', { 
    event: event_address, 
    mint: mint_address, 
    owner: ownerAddressStr, 
    name: participantName 
  });

  if (!event_address || !mint_address || !ownerAddressStr) {
    throw new Error("Dados críticos (endereços de evento, mint ou dono) estão faltando no banco de dados.");
  }

  return {
    eventAddress: new anchor.web3.PublicKey(event_address),
    mintAddress: new anchor.web3.PublicKey(mint_address),
    ownerAddress: new anchor.web3.PublicKey(ownerAddressStr),
    participantName
  };
}

/**
 * Validações on-chain do evento e ingresso
 */
async function performOnChainValidations(eventAddress, validatorAddress, mintAddress) {
  console.log('[3/7] Buscando conta do evento on-chain...');
  const eventAccount = await program.account.event.fetch(eventAddress);

  console.log('[4/7] Verificando permissões do validador...');
  const isValidValidator = eventAccount.validators.some(v => v.toString() === validatorAddress);
  if (!isValidValidator) {
    throw new Error("Validador não autorizado para este evento.");
  }
  console.log(`[VALIDATION] ✅ Validador ${validatorAddress} autorizado.`);

  console.log('[5/7] Buscando conta do ingresso on-chain...');
  const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), eventAddress.toBuffer(), mintAddress.toBuffer()],
    program.programId
  );
  
  const ticketAccount = await program.account.ticket.fetch(ticketPda);

  if (ticketAccount.redeemed) {
    throw new Error("Este ingresso já foi validado.");
  }
  console.log(`[VALIDATION] ✅ Ingresso on-chain encontrado. Dono: ${ticketAccount.owner}`);

  return ticketPda;
}

/**
 * Cria e envia transação de validação - CORRIGIDO
 */
async function createAndSendValidationTransaction(
  program, 
  eventAddress, 
  mintAddress, 
  ownerAddress, 
  validatorKeypair,
  ticketPda
) {
  console.log('[7/7] Preparando transação gasless...');

  // ✅ CORREÇÃO: Usar approach similar ao frontend que funciona
  const nftTokenAddress = getAssociatedTokenAddressSync(mintAddress, ownerAddress);
  
  console.log('[SolanaService] 🖊️ Criando transação via program.methods...');
  
  // ✅ CORREÇÃO: Criar transação usando o método do programa (como no frontend)
  const transaction = await program.methods.redeemTicket()
    .accounts({
      ticket: ticketPda,
      event: eventAddress,
      validator: validatorKeypair.publicKey,
      owner: ownerAddress,
      nftToken: nftTokenAddress,
      nftMint: mintAddress,
    })
    .transaction();

  // ✅ CORREÇÃO: Obter blockhash recente
  const { blockhash } = await connection.getRecentBlockhash();
  
  // ✅ CORREÇÃO: Configurar feePayer e recentBlockhash na transação
  transaction.feePayer = payerKeypair.publicKey;
  transaction.recentBlockhash = blockhash;

  console.log('[SolanaService] ✅ Transação criada, assinando...');

  // ✅ CORREÇÃO: Assinar com ambos os keypairs
  // O validador assina para autorizar a operação
  // O payer assina para pagar a transação (gasless)
  transaction.sign(validatorKeypair, payerKeypair);

  console.log('[SolanaService] 🖊️ Enviando transação assinada...');
  
  // ✅ CORREÇÃO: Enviar transação serializada
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed'
  });

  console.log(`[VALIDATION] 📡 Transação enviada, aguardando confirmação: ${signature}`);

  // ✅ CORREÇÃO: Confirmar transação
  const confirmation = await connection.confirmTransaction(signature, 'confirmed');
  
  if (confirmation.value.err) {
    throw new Error(`Transação falhou na confirmação: ${confirmation.value.err}`);
  }

  console.log(`[VALIDATION] ✅ Ingresso validado com sucesso! Assinatura: ${signature}`);
  return signature;
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
    // ETAPAS 1 & 2: Buscar dados do ingresso e do dono
    const { registration, profile } = await fetchRegistrationData(registrationId);

    // ETAPA 2.5: Consolidar e validar dados
    const { eventAddress, mintAddress, ownerAddress, participantName } = 
      validateRegistrationData(registration, profile);

    // ETAPAS 3, 4 & 5: Validações On-Chain
    const ticketPda = await performOnChainValidations(
      eventAddress, 
      validatorAddress, 
      mintAddress
    );

    // ETAPA 6: Autenticação do Validador
    console.log('[6/7] Obtendo keypair do validador...');
    const validatorKeypair = await getValidatorKeypair(validatorAddress, authType, authData);

    // ETAPA 7: Construção e Envio da Transação Gasless
    const signature = await createAndSendValidationTransaction(
      program,
      eventAddress,
      mintAddress,
      ownerAddress,
      validatorKeypair,
      ticketPda
    );

    return res.status(200).json({
      success: true,
      message: `Entrada liberada para ${participantName}!`,
      signature,
      participantName,
    });

  } catch (error) {
    console.error("❌ Erro detalhado durante a validação:", error);
    
    // Mapeamento de erros para status codes apropriados
    let statusCode = 500;
    let errorMessage = error.message || "Ocorreu um erro desconhecido durante a validação.";
    
    if (error.message.includes("não encontrado")) {
      statusCode = 404;
    } else if (error.message.includes("não autorizado")) {
      statusCode = 403;
    } else if (error.message.includes("já foi validado")) {
      statusCode = 409;
    } else if (error.message.includes("Dados críticos")) {
      statusCode = 400;
    }

    if (error.logs) {
      console.error('--- LOGS DA BLOCKCHAIN ---', error.logs, '-------------------------');
    }

    return res.status(statusCode).json({ 
      success: false, 
      error: "Falha na validação do ingresso.", 
      details: errorMessage 
    });
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
