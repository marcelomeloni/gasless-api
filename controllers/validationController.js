import { program, getAssociatedTokenAddress, PublicKey, connection } from '../services/solanaService.js';
import supabase from '../services/supabaseService.js';
import anchor from '@coral-xyz/anchor';
import { getKeypairFromPrivateKey, getKeypairFromSeedPhrase, getKeypairFromCredentials } from '../lib/authUtils.js';

// Cache de keypairs para validadores (em produção, use Redis ou database)
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
        if (!authData.privateKey) {
          throw new Error('Private key não fornecida');
        }
        keypair = getKeypairFromPrivateKey(authData.privateKey);
        break;
      
      case 'seedPhrase':
        if (!authData.seedWords || !Array.isArray(authData.seedWords)) {
          throw new Error('Seed phrase não fornecida ou formato inválido');
        }
        keypair = await getKeypairFromSeedPhrase(authData.seedWords);
        break;
      
      case 'credentials':
        if (!authData.username || !authData.password) {
          throw new Error('Username e password são obrigatórios');
        }
        keypair = await getKeypairFromCredentials(authData.username, authData.password);
        break;
      
      case 'walletExtension':
        // Para wallet extension, o frontend deve assinar
        throw new Error('Wallet extension requer assinatura no frontend');
      
      default:
        throw new Error(`Tipo de autenticação não suportado: ${authType}`);
    }

    // Verifica se o keypair gerado corresponde ao validatorAddress
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
    // Limpa o cache em caso de erro
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
    
    // Cria a transação usando o programa Anchor
    const transaction = await program.methods
      .redeemTicket()
      .accounts(accounts)
      .transaction();

    // Obtém o blockhash mais recente
    const { blockhash } = await connection.getRecentBlockhash();
    
    // Configura a transação
    transaction.feePayer = validatorKeypair.publicKey;
    transaction.recentBlockhash = blockhash;
    
    // Assina com o validador
    transaction.sign(validatorKeypair);
    
    console.log(`[SolanaService] ✅ Transação assinada pelo validador`);
    return transaction;

  } catch (error) {
    console.error('[SolanaService] ❌ Erro ao criar transação:', error);
    throw error;
  }
}

/**
 * Valida um ingresso por ID (com assinatura no backend)
 */
export const validateById = async (req, res) => {
    const { registrationId } = req.params;
    const { validatorAddress, authType, authData } = req.body;

    console.log(`[VALIDATION] Iniciando validação para: ${registrationId}`);
    console.log(`[VALIDATION] Validador: ${validatorAddress}, Tipo: ${authType}`);

    // Validações iniciais
    if (!registrationId || !validatorAddress) {
        console.error('[VALIDATION] Parâmetros obrigatórios faltando');
        return res.status(400).json({ 
            success: false, 
            error: "ID do registro e endereço do validador são obrigatórios." 
        });
    }

    // Validação básica de UUID
    if (!registrationId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        console.error('[VALIDATION] ID do registro em formato inválido:', registrationId);
        return res.status(400).json({ 
            success: false, 
            error: "ID do registro em formato inválido." 
        });
    }

    try {
        // 1. BUSCAR REGISTRO NO SUPABASE
        console.log(`[1/7] Buscando registro no Supabase...`);
        const { data: registration, error: dbError } = await supabase
            .from('registrations')
            .select('*')
            .eq('id', registrationId)
            .single();

        if (dbError) {
            console.error('[VALIDATION] Erro no Supabase:', dbError);
            return res.status(500).json({ 
                success: false, 
                error: "Erro ao acessar banco de dados." 
            });
        }

        if (!registration) {
            console.error('[VALIDATION] Registro não encontrado:', registrationId);
            return res.status(404).json({ 
                success: false, 
                error: "Ingresso não encontrado." 
            });
        }

        const { event_address, mint_address, registration_details } = registration;
        const participantName = registration_details?.name || 'Participante';

        console.log(`[2/7] Registro encontrado:`, {
            event: event_address,
            mint: mint_address,
            name: participantName
        });

        // 2. VALIDAR ENDEREÇOS
        console.log(`[3/7] Validando endereços...`);
        let eventPubkey, nftMintPubkey, validatorPubkey;
        
        try {
            eventPubkey = new PublicKey(event_address);
            nftMintPubkey = new PublicKey(mint_address);
            validatorPubkey = new PublicKey(validatorAddress);
        } catch (error) {
            console.error('[VALIDATION] Erro ao criar PublicKeys:', error);
            return res.status(400).json({ 
                success: false, 
                error: "Endereços do evento ou NFT inválidos." 
            });
        }

        // 3. VERIFICAR SE VALIDADOR É AUTORIZADO
        console.log(`[4/7] Verificando permissões do validador...`);
        let eventAccount;
        try {
            eventAccount = await program.account.event.fetch(eventPubkey);
            const isValidator = eventAccount.validators.some(v => v.equals(validatorPubkey));
            
            if (!isValidator) {
                console.warn(`[VALIDATION] Validador não autorizado: ${validatorAddress}`);
                return res.status(403).json({ 
                    success: false, 
                    error: "Acesso negado. Esta carteira não é um validador autorizado." 
                });
            }
        } catch (error) {
            console.error('[VALIDATION] Erro ao buscar conta do evento:', error);
            return res.status(404).json({ 
                success: false, 
                error: "Evento não encontrado na blockchain." 
            });
        }

        console.log(`[VALIDATION] ✅ Validador ${validatorAddress} autorizado.`);

        // 4. BUSCAR INGRESSO ON-CHAIN
        console.log(`[5/7] Buscando ingresso on-chain...`);
        const TICKET_NFT_MINT_FIELD_OFFSET = 40;
        let tickets;
        try {
            tickets = await program.account.ticket.all([
                { memcmp: { offset: TICKET_NFT_MINT_FIELD_OFFSET, bytes: nftMintPubkey.toBase58() } }
            ]);
        } catch (error) {
            console.error('[VALIDATION] Erro ao buscar tickets:', error);
            return res.status(500).json({ 
                success: false, 
                error: "Erro ao buscar ingresso na blockchain." 
            });
        }

        if (tickets.length === 0) {
            console.error('[VALIDATION] Ingresso on-chain não encontrado para mint:', mint_address);
            return res.status(404).json({ 
                success: false, 
                error: "Ingresso não encontrado na blockchain." 
            });
        }

        const ticketAccount = tickets[0];
        
        // 5. VERIFICAR SE JÁ FOI VALIDADO
        if (ticketAccount.account.redeemed) {
            console.warn(`[VALIDATION] Tentativa de validação dupla: ${mint_address}`);
            return res.status(409).json({ 
                success: false, 
                error: "Este ingresso já foi utilizado." 
            });
        }

        const ownerPubkey = ticketAccount.account.owner;
        console.log(`[VALIDATION] ✅ Ingresso on-chain encontrado. Dono: ${ownerPubkey.toString()}`);

        // 6. OBTER KEYPAIR DO VALIDADOR
        console.log(`[6/7] Obtendo keypair do validador...`);
        let validatorKeypair;
        
        if (authType && authData) {
            // Usar autenticação fornecida (privateKey, seedPhrase, credentials)
            validatorKeypair = await getValidatorKeypair(validatorAddress, authType, authData);
        } else {
            // Tentar fallback para wallet do provider (apenas para desenvolvimento)
            console.log('[VALIDATION] ⚠️ Nenhuma autenticação fornecida, tentando fallback...');
            const provider = program.provider;
            if (provider.wallet && provider.wallet.publicKey) {
                if (provider.wallet.publicKey.toString() !== validatorAddress) {
                    throw new Error('Validador não corresponde à wallet do provider. Forneça authType e authData.');
                }
                // Para desenvolvimento: se o provider tiver um signer, podemos tentar usá-lo
                if (provider.wallet.signTransaction) {
                    console.log('[VALIDATION] Usando wallet do provider para assinatura');
                    // Continuaremos sem keypair, o Anchor usará o provider
                } else {
                    throw new Error('Provider não tem capacidade de assinatura');
                }
            } else {
                throw new Error('Autenticação necessária para validação. Forneça authType e authData.');
            }
        }

        // 7. PREPARAR CONTAS PARA A TRANSAÇÃO
        const [ticketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("ticket"), eventPubkey.toBuffer(), nftMintPubkey.toBuffer()], 
            program.programId
        );
        
        const nftTokenAccount = await getAssociatedTokenAddress(nftMintPubkey, ownerPubkey);

        const accounts = { 
            ticket: ticketPda, 
            event: eventPubkey, 
            validator: validatorPubkey, 
            owner: ownerPubkey, 
            nftToken: nftTokenAccount, 
            nftMint: nftMintPubkey 
        };

        console.log(`[VALIDATION] Contas da transação:`, {
            ticket: ticketPda.toString(),
            event: eventPubkey.toString(),
            validator: validatorPubkey.toString(),
            owner: ownerPubkey.toString(),
            nftToken: nftTokenAccount.toString(),
            nftMint: nftMintPubkey.toString()
        });

        // 8. EXECUTAR VALIDAÇÃO
        console.log(`[7/7] Executando validação...`);
        let signature;

        if (validatorKeypair) {
            // Caso 1: Backend assina a transação
            const signedTransaction = await createAndSignValidationTransaction(program, accounts, validatorKeypair);
            signature = await connection.sendRawTransaction(signedTransaction.serialize());
        } else {
            // Caso 2: Usar o programa Anchor com o provider atual
            signature = await program.methods.redeemTicket().accounts(accounts).rpc();
        }
        
        // 9. CONFIRMAR TRANSAÇÃO
        console.log(`[8/7] Confirmando transação: ${signature}...`);
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${confirmation.value.err}`);
        }

        console.log(`[SUCCESS] ✅ Ingresso validado! Assinatura: ${signature}`);
        console.log(`[SUCCESS] ✅ Participante: ${participantName}`);

        res.status(200).json({ 
            success: true, 
            signature,
            participantName: participantName
        });

    } catch (error) {
        console.error("[ERROR] ❌ Erro durante a validação:", error);
        
        // Limpa o cache em caso de erro de autenticação
        if (error.message.includes('autenticação') || error.message.includes('Keypair') || error.message.includes('Auth')) {
            validatorKeypairs.clear();
        }

        let errorMessage = error.message;
        
        // Tenta parsear erro do Anchor para mensagem mais amigável
        try {
            if (error.logs) {
                const anchorError = anchor.AnchorError.parse(error.logs);
                if (anchorError) {
                    errorMessage = anchorError.error.errorMessage;
                }
            }
        } catch (parseError) {
            // Ignora erros de parse, usa a mensagem original
        }

        console.error("[ERROR] Mensagem de erro detalhada:", errorMessage);

        res.status(500).json({ 
            success: false, 
            error: "Erro do servidor durante a validação.",
            details: errorMessage
        });
    }
};

/**
 * Valida um ingresso com transação assinada no frontend (para wallet extensions)
 */
export const validateByIdWithFrontendSignature = async (req, res) => {
    const { registrationId } = req.params;
    const { validatorAddress, signedTransaction } = req.body;

    console.log(`[VALIDATION-FRONTEND] Validação com assinatura do frontend para: ${registrationId}`);
    console.log(`[VALIDATION-FRONTEND] Validador: ${validatorAddress}`);

    if (!registrationId || !validatorAddress || !signedTransaction) {
        return res.status(400).json({ 
            success: false, 
            error: "ID do registro, endereço do validador e transação assinada são obrigatórios." 
        });
    }

    try {
        // 1. BUSCAR REGISTRO NO SUPABASE (mesma lógica da função principal)
        console.log(`[1/5] Buscando registro no Supabase...`);
        const { data: registration, error: dbError } = await supabase
            .from('registrations')
            .select('*')
            .eq('id', registrationId)
            .single();

        if (dbError || !registration) {
            console.error('[VALIDATION-FRONTEND] Registro não encontrado:', registrationId);
            return res.status(404).json({ 
                success: false, 
                error: "Ingresso não encontrado." 
            });
        }

        const { event_address, mint_address, registration_details } = registration;
        const participantName = registration_details?.name || 'Participante';

        // 2. VALIDAR ENDEREÇOS
        console.log(`[2/5] Validando endereços...`);
        const eventPubkey = new PublicKey(event_address);
        const validatorPubkey = new PublicKey(validatorAddress);

        // 3. VERIFICAR SE VALIDADOR É AUTORIZADO
        console.log(`[3/5] Verificando permissões do validador...`);
        const eventAccount = await program.account.event.fetch(eventPubkey);
        const isValidator = eventAccount.validators.some(v => v.equals(validatorPubkey));
        
        if (!isValidator) {
            console.warn(`[VALIDATION-FRONTEND] Validador não autorizado: ${validatorAddress}`);
            return res.status(403).json({ 
                success: false, 
                error: "Acesso negado. Esta carteira não é um validador autorizado." 
            });
        }

        console.log(`[VALIDATION-FRONTEND] ✅ Validador ${validatorAddress} autorizado.`);

        // 4. ENVIAR TRANSAÇÃO ASSINADA
        console.log(`[4/5] Enviando transação assinada pelo frontend...`);
        const signature = await connection.sendRawTransaction(Buffer.from(signedTransaction, 'base64'));
        
        // 5. CONFIRMAR TRANSAÇÃO
        console.log(`[5/5] Confirmando transação: ${signature}...`);
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${confirmation.value.err}`);
        }

        console.log(`[SUCCESS] ✅ Ingresso validado via frontend! Assinatura: ${signature}`);
        console.log(`[SUCCESS] ✅ Participante: ${participantName}`);

        res.status(200).json({ 
            success: true, 
            signature,
            participantName: participantName
        });

    } catch (error) {
        console.error("[ERROR] ❌ Erro durante validação com frontend:", error);
        
        let errorMessage = error.message;
        
        // Tenta parsear erro do Anchor
        try {
            if (error.logs) {
                const anchorError = anchor.AnchorError.parse(error.logs);
                if (anchorError) {
                    errorMessage = anchorError.error.errorMessage;
                }
            }
        } catch (parseError) {
            // Ignora erros de parse
        }

        res.status(500).json({ 
            success: false, 
            error: "Erro ao processar transação assinada.",
            details: errorMessage
        });
    }
};

/**
 * Busca ingressos validados para um evento
 */
export const getValidatedTickets = async (req, res) => {
    const { eventAddress } = req.params;
    
    if (!eventAddress) {
        return res.status(400).json({ error: "Event address is required." });
    }

    console.log(`[TICKETS] Buscando ingressos validados para evento: ${eventAddress}`);

    try {
        const eventPubkey = new PublicKey(eventAddress);
        
        // Buscar todos os tickets do evento
        const allTicketsForEvent = await program.account.ticket.all([
            { memcmp: { offset: 8, bytes: eventPubkey.toBase58() } }
        ]);
        
        console.log(`[TICKETS] Total de tickets encontrados: ${allTicketsForEvent.length}`);
        
        // Filtrar apenas os validados
        const redeemedTickets = allTicketsForEvent.filter(ticket => ticket.account.redeemed);
        console.log(`[TICKETS] Tickets validados: ${redeemedTickets.length}`);

        if (redeemedTickets.length === 0) {
            return res.status(200).json([]);
        }

        // Buscar nomes dos participantes
        const ownerAddresses = redeemedTickets.map(ticket => ticket.account.owner.toString());
        console.log(`[TICKETS] Buscando perfis para: ${ownerAddresses.length} endereços`);
        
        const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('wallet_address, name')
            .in('wallet_address', ownerAddresses);

        if (profilesError) {
            console.error('[TICKETS] Erro ao buscar perfis:', profilesError);
        }

        const profilesMap = new Map();
        if (profiles) {
            profiles.forEach(p => profilesMap.set(p.wallet_address, p.name));
        }

        // Formatar resposta
        const validatedEntries = redeemedTickets.map(ticket => {
            const ownerAddress = ticket.account.owner.toString();
            const redeemedAt = new Date(ticket.account.redeemedAt * 1000);
            
            return {
                owner: ownerAddress,
                name: profilesMap.get(ownerAddress) || 'Participante',
                redeemedAt: redeemedAt.toLocaleTimeString('pt-BR', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                }),
                redeemedAtFull: redeemedAt.toISOString(),
                nftMint: ticket.account.nftMint.toString(),
            };
        });

        // Ordenar por data de validação (mais recente primeiro)
        validatedEntries.sort((a, b) => new Date(b.redeemedAtFull) - new Date(a.redeemedAtFull));

        console.log(`[TICKETS] ✅ Retornando ${validatedEntries.length} entradas validadas`);
        res.status(200).json(validatedEntries);

    } catch (error) {
        console.error("[ERROR] ❌ Erro ao buscar tickets validados:", error);
        res.status(500).json({ 
            error: "Erro ao buscar tickets validados.", 
            details: error.message 
        });
    }
};

/**
 * Limpa o cache de keypairs (útil para desenvolvimento)
 */
export const clearKeypairCache = async (req, res) => {
    const count = validatorKeypairs.size;
    validatorKeypairs.clear();
    console.log(`[CACHE] ✅ Cache limpo. ${count} keypairs removidos.`);
    res.status(200).json({ 
        success: true, 
        message: `Cache limpo. ${count} keypairs removidos.` 
    });
};
