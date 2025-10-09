import { program, payerKeypair, SystemProgram, PublicKey, connection } from '../services/solanaService.js';
import { uploadToPinata, uploadJSONToPinata } from '../services/pinataService.js';
import anchor from '@coral-xyz/anchor';
import { createClient } from '@supabase/supabase-js';
import { saveCompleteEventToSupabase, getActiveEventsFromSupabase, getEventsByCreator, supabase  } from '../services/supabaseService.js';
import axios from 'axios';
import { Transaction } from '@solana/web3.js';
import FormData from 'form-data';
import { deriveUserKeypair } from '../services/walletDerivationService.js';
// Adicione esta rota no seu eventController.js
export const getEventFromSupabase = async (req, res) => {
    const { eventAddress } = req.params;
    
    if (!eventAddress) {
        return res.status(400).json({ success: false, error: 'Endereço do evento é obrigatório.' });
    }

    console.log(`[⚡] Buscando evento no Supabase: ${eventAddress}`);
    
    try {
        const { data: event, error } = await supabase
            .from('events')
            .select('*')
            .eq('event_address', eventAddress)
            .single();

        if (error || !event) {
            console.log(` ❌ Evento não encontrado no Supabase: ${eventAddress}`);
            return res.status(404).json({ 
                success: false, 
                error: 'Evento não encontrado no banco de dados.' 
            });
        }

        console.log(` ✅ Evento encontrado no Supabase: ${event.metadata?.name || 'Sem nome'}`);
        
        // Formatar resposta similar à API rápida
        const formattedEvent = {
            publicKey: eventAddress,
            account: {
                eventId: event.event_id,
                controller: event.controller,
                salesStartDate: { toNumber: () => event.sales_start_date },
                salesEndDate: { toNumber: () => event.sales_end_date },
                maxTicketsPerWallet: event.max_tickets_per_wallet,
                royaltyBps: event.royalty_bps,
                metadataUri: event.metadata_url,
                tiers: event.tiers || []
            },
            metadata: event.metadata || {},
            imageUrl: event.image_url
        };

        res.status(200).json({
            success: true,
            event: formattedEvent
        });

    } catch (error) {
        console.error("[❌] Erro ao buscar evento do Supabase:", error);
        res.status(500).json({
            success: false,
            error: 'Erro interno ao buscar evento.'
        });
    }
};
export const getNextFourEvents = async (req, res) => {
    console.log('[⚡] API ULTRA-RÁPIDA: Buscando 4 próximos eventos ATIVOS do Supabase...');
    const startTime = Date.now();
    
    try {
        const nowInSeconds = Math.floor(Date.now() / 1000);
        
        // Buscar apenas 4 eventos ativos mais próximos do Supabase
        const { data, error } = await supabase
            .from('events')
            .select('*')
            .eq('is_active', true)
            .gte('sales_end_date', nowInSeconds)
            .order('sales_start_date', { ascending: true })
            .limit(4);

        if (error) {
            console.error(' ❌ Erro ao buscar próximos eventos:', error);
            throw error;
        }

        console.log(`[📋] ${data?.length || 0} eventos ativos encontrados no Supabase`);

        // ✅ PROCESSAMENTO DE IMAGENS COM FALLBACK IPFS MELHORADO
        const eventsWithFallbackImages = await Promise.all(
            (data || []).map(async (event) => {
                try {
                    let processedImageUrl = event.image_url;
                    
                    // Aplica fallback IPFS apenas se a URL for do IPFS/Pinata
                    if (event.image_url && (event.image_url.includes('ipfs') || event.image_url.includes('pinata'))) {
                        try {
                            console.log(` 🖼️  Processando imagem IPFS: ${event.image_url}`);
                            const cid = extractCID(event.image_url);
                            
                            if (cid) {
                                // Tenta múltiplos gateways em ordem de prioridade
                                const accessibleUrl = await getAccessibleIpfsUrl(event.image_url);
                                processedImageUrl = accessibleUrl;
                                
                                if (accessibleUrl !== event.image_url) {
                                    console.log(`   ✅ Imagem otimizada: ${event.image_url} -> ${accessibleUrl}`);
                                } else {
                                    console.log(`   ⚠️  Usando URL original (fallback não necessário): ${event.image_url}`);
                                }
                            }
                        } catch (ipfsError) {
                            console.warn(`   ⚠️  Erro no fallback IPFS: ${ipfsError.message}`);
                            // Mantém a URL original em caso de erro
                        }
                    }

                    // ✅ PROCESSAR METADADOS PARA ATUALIZAR URLS IPFS
                    let processedMetadata = event.metadata;
                    if (processedMetadata) {
                        try {
                            processedMetadata = await processIpfsUrlsInObject(processedMetadata);
                        } catch (metadataError) {
                            console.warn(`   ⚠️  Erro ao processar metadados IPFS: ${metadataError.message}`);
                        }
                    }

                    // ✅ VERIFICAR SE A IMAGEM É ACESSÍVEL
                    let finalImageUrl = processedImageUrl;
                    try {
                        const isAccessible = await checkUrlAccessibility(finalImageUrl, 3000);
                        if (!isAccessible) {
                            console.warn(`   ⚠️  Imagem não acessível: ${finalImageUrl}`);
                            // Poderíamos adicionar um fallback de imagem padrão aqui se necessário
                        }
                    } catch (accessibilityError) {
                        console.warn(`   ⚠️  Não foi possível verificar acessibilidade da imagem: ${accessibilityError.message}`);
                    }

                    return {
                        ...event,
                        image_url: finalImageUrl,
                        metadata: processedMetadata
                    };

                } catch (error) {
                    console.error(` ❌ Erro ao processar evento ${event.event_address}:`, error);
                    // Retorna o evento original em caso de erro
                    return event;
                }
            })
        );

        // Log dos eventos processados
        if (eventsWithFallbackImages.length > 0) {
            console.log(`[📊] Eventos processados com sucesso:`);
            eventsWithFallbackImages.forEach((event, index) => {
                const eventName = event.metadata?.name || 'Sem nome';
                const startDate = new Date(event.sales_start_date * 1000).toLocaleDateString('pt-BR');
                const imageSource = event.image_url !== event.image_url ? 'Fallback' : 'Original';
                console.log(`   ${index + 1}. "${eventName}" | Início: ${startDate} | Imagem: ${imageSource}`);
            });
        }

        // Formatar resposta
        const formattedEvents = eventsWithFallbackImages.map(event => ({
            publicKey: event.event_address,
            account: {
                eventId: event.event_id,
                controller: event.controller,
                salesStartDate: { toNumber: () => event.sales_start_date },
                salesEndDate: { toNumber: () => event.sales_end_date },
                maxTicketsPerWallet: event.max_tickets_per_wallet,
                royaltyBps: event.royalty_bps,
                metadataUri: event.metadata_url,
                tiers: event.tiers || [],
                totalTicketsSold: event.total_tickets_sold || 0,
                maxTotalSupply: event.max_total_supply || 0
            },
            metadata: event.metadata,
            imageUrl: event.image_url, // ✅ Já com fallback aplicado
            isActive: event.is_active,
            isCanceled: !event.is_active
        }));

        const duration = Date.now() - startTime;
        console.log(`[⚡] API ULTRA-RÁPIDA: ${formattedEvents.length} eventos ATIVOS retornados em ${duration}ms`);
        
        res.status(200).json(formattedEvents);

    } catch (error) {
        console.error("[❌] Erro na API ultra-rápida:", error);
        res.status(500).json({ 
            error: "Erro ao buscar próximos eventos",
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

export const createGaslessEvent = async (req, res) => {
    console.log('[+] Recebida requisição para criar evento gasless...');

    try {
        const { offChainData, onChainData } = req.body;
        if (!offChainData || !onChainData) {
            return res.status(400).json({ success: false, error: "Dados do formulário ausentes." });
        }
        
        const parsedOffChainData = JSON.parse(offChainData);
        const parsedOnChainData = JSON.parse(onChainData);
        const files = req.files;

        // Usar uma chave do sistema como controller
        const controllerPubkey = payerKeypair.publicKey;

        let imageUrl = parsedOffChainData.image;
        let organizerLogoUrl = parsedOffChainData.organizer.organizerLogo;

        // Uploads
        if (files.image?.[0]) {
            console.log(' -> Fazendo upload da imagem do evento...');
            imageUrl = await uploadToPinata(files.image[0]);
            console.log(` -> Imagem do evento enviada: ${imageUrl}`);
        } else {
            return res.status(400).json({ 
                success: false, 
                error: "Imagem principal do evento é obrigatória." 
            });
        }

        if (files.organizerLogo?.[0]) {
            console.log(' -> Fazendo upload do logo do organizador...');
            organizerLogoUrl = await uploadToPinata(files.organizerLogo[0]);
            console.log(` -> Logo enviado: ${organizerLogoUrl}`);
        } else {
            organizerLogoUrl = '';
        }

        // Preparar metadados
        const finalMetadata = {
            ...parsedOffChainData,
            image: imageUrl,
            organizer: { 
                ...parsedOffChainData.organizer, 
                organizerLogo: organizerLogoUrl 
            },
            properties: {
                ...parsedOffChainData.properties,
                dateTime: {
                    ...parsedOffChainData.properties.dateTime,
                    start: new Date(parsedOffChainData.properties.dateTime.start).toISOString(),
                    end: new Date(parsedOffChainData.properties.dateTime.end).toISOString(),
                }
            },
            createdAt: new Date().toISOString(),
            createdBy: controllerPubkey.toString()
        };
        
        console.log(' -> Fazendo upload do JSON de metadados...');
        const metadataUrl = await uploadJSONToPinata(finalMetadata);
        console.log(` -> Metadados enviados: ${metadataUrl}`);

        // ✅ PRIMEIRO: Criar todas as variáveis necessárias
        console.log(' -> Preparando transação on-chain...');
        const eventId = new anchor.BN(Date.now());
        
        const [whitelistPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("whitelist"), controllerPubkey.toBuffer()], 
            program.programId
        );
        const [eventPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("event"), eventId.toBuffer('le', 8)], 
            program.programId
        );
        
        const tiersInput = parsedOnChainData.tiers.map(tier => {
            const priceBRLCents = Math.round(parseFloat(tier.price) * 100);
            return {
                name: tier.name,
                priceBrlCents: new anchor.BN(priceBRLCents),
                maxTicketsSupply: new anchor.BN(parseInt(tier.maxTicketsSupply, 10)),
            };
        });

        const salesStartDate = new Date(parsedOnChainData.salesStartDate);
        const salesEndDate = new Date(parsedOnChainData.salesEndDate);
        
        if (salesStartDate >= salesEndDate) {
            return res.status(400).json({ 
                success: false, 
                error: "A data de fim das vendas deve ser posterior à data de início." 
            });
        }

        // ✅ AGORA SIM: Salvar no Supabase
        console.log(' -> Salvando dados COMPLETOS no Supabase para performance...');

        const eventDataForSupabase = {
            eventAddress: eventPda.toString(),
            eventId: eventId.toString(),
            metadata: finalMetadata,
            imageUrl: imageUrl,
            createdBy: controllerPubkey.toString(),
            controller: controllerPubkey.toString(),
            salesStartDate: Math.floor(salesStartDate.getTime() / 1000),
            salesEndDate: Math.floor(salesEndDate.getTime() / 1000),
            maxTicketsPerWallet: parseInt(parsedOnChainData.maxTicketsPerWallet, 10),
            royaltyBps: parseInt(parsedOnChainData.royaltyBps, 10),
            tiers: tiersInput
        };

        saveCompleteEventToSupabase(eventDataForSupabase)
            .then(() => console.log(' ✅ Dados salvos no Supabase com sucesso!'))
            .catch(err => console.warn(' ⚠️  Erro ao salvar no Supabase (não crítico):', err.message));

        // Continuar com transação gasless...
        console.log(' -> Enviando transação gasless...');
        
        const signature = await program.methods
            .createEvent(
                eventId, 
                metadataUrl, 
                new anchor.BN(Math.floor(salesStartDate.getTime() / 1000)), 
                new anchor.BN(Math.floor(salesEndDate.getTime() / 1000)), 
                parseInt(parsedOnChainData.royaltyBps, 10), 
                parseInt(parsedOnChainData.maxTicketsPerWallet, 10), 
                tiersInput
            )
            .accounts({
                whitelistAccount: whitelistPda,
                eventAccount: eventPda,
                controller: controllerPubkey,
                payer: payerKeypair.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .rpc({
                commitment: 'confirmed',
                skipPreflight: false
            });

        console.log(`[✔] Evento gasless criado com sucesso! Assinatura: ${signature}`);

        res.status(200).json({ 
            success: true, 
            signature, 
            eventAddress: eventPda.toString(),
            eventId: eventId.toString(),
            metadataUrl: metadataUrl,
            controller: controllerPubkey.toString(),
            message: "Evento criado com sucesso sem necessidade de carteira!" 
        });

    } catch (error) {
        console.error("❌ Erro no processo de criação gasless do evento:", error);
        
        if (error.logs) {
            console.error('Logs da transação:', error.logs);
        }
        
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Ocorreu um erro interno no servidor.',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};
// controllers/eventController.js - FUNÇÃO createFullEvent CORRIGIDA

export const createFullEvent = async (req, res) => {
    console.log('[+] Recebida requisição para criar evento completo.');

    try {
        const { offChainData, onChainData, controller, userLoginData } = req.body;

        if (!offChainData || !onChainData || !controller) {
            return res.status(400).json({
                success: false,
                error: "Dados do formulário e controlador são obrigatórios."
            });
        }

        const parsedOffChainData = JSON.parse(offChainData);
        const parsedOnChainData = JSON.parse(onChainData);
        const controllerPubkey = new PublicKey(controller);
        const files = req.files;

        let userKeypair;
        let userPublicKey;

        // ✅ DECISÃO: Se for adapter, NÃO derivar keypair - usar apenas a publicKey
        if (userLoginData) {
            const parsedUserLoginData = JSON.parse(userLoginData);

            if (parsedUserLoginData.loginType === 'adapter') {
                console.log('🎯 Modo adapter: usando apenas publicKey fornecida');
                userPublicKey = controllerPubkey;

                if (!userPublicKey) {
                    throw new Error("Public key inválida fornecida pelo adapter");
                }

                console.log(` ✅ Usando publicKey do adapter: ${userPublicKey.toString()}`);

            } else {
                console.log('🔐 Modo local: derivando keypair do usuário...');
                userKeypair = await deriveUserKeypair(parsedUserLoginData);
                userPublicKey = userKeypair.publicKey;

                const derivedPublicKey = userPublicKey.toString();
                const requestedPublicKey = controllerPubkey.toString();

                if (derivedPublicKey !== requestedPublicKey) {
                    console.error(` ❌ Public key mismatch: ${derivedPublicKey} vs ${requestedPublicKey}`);
                    return res.status(400).json({
                        success: false,
                        error: "A chave pública derivada não corresponde ao controlador fornecido."
                    });
                }
                console.log(` ✅ Keypair do usuário derivado: ${derivedPublicKey}`);
            }
        } else {
            console.log('🎯 Sem userLoginData: usando modo adapter');
            userPublicKey = controllerPubkey;
        }

        // Processar uploads de arquivos
        let imageUrl = parsedOffChainData.image;
        let organizerLogoUrl = parsedOffChainData.organizer.organizerLogo;

        if (files.image?.[0]) {
            console.log(' -> Fazendo upload da imagem do evento...');
            imageUrl = await uploadToPinata(files.image[0]);
            console.log(` -> Imagem do evento enviada: ${imageUrl}`);
        } else {
            return res.status(400).json({
                success: false,
                error: "Imagem principal do evento é obrigatória."
            });
        }

        if (files.organizerLogo?.[0]) {
            console.log(' -> Fazendo upload do logo do organizador...');
            organizerLogoUrl = await uploadToPinata(files.organizerLogo[0]);
            console.log(` -> Logo enviado: ${organizerLogoUrl}`);
        } else {
            organizerLogoUrl = '';
        }

        // Preparar metadados finais
        const finalMetadata = {
            ...parsedOffChainData,
            image: imageUrl,
            organizer: {
                ...parsedOffChainData.organizer,
                organizerLogo: organizerLogoUrl
            },
            properties: {
                ...parsedOffChainData.properties,
                dateTime: {
                    ...parsedOffChainData.properties.dateTime,
                    start: new Date(parsedOffChainData.properties.dateTime.start).toISOString(),
                    end: new Date(parsedOffChainData.properties.dateTime.end).toISOString(),
                }
            },
            createdAt: new Date().toISOString(),
            createdBy: userPublicKey.toString()
        };

        console.log(' -> Fazendo upload do JSON de metadados...');
        const metadataUrl = await uploadJSONToPinata(finalMetadata);
        console.log(` -> Metadados enviados: ${metadataUrl}`);

        // ✅ MOVER: Primeiro criar todas as variáveis necessárias
        console.log(' -> Preparando transação on-chain...');

        const eventId = new anchor.BN(Date.now());

        // Encontrar PDAs - usar a chave do usuário como authority
        const [whitelistPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("whitelist"), userPublicKey.toBuffer()],
            program.programId
        );
        const [eventPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("event"), eventId.toBuffer('le', 8)],
            program.programId
        );

        // Preparar tiers
        const tiersInput = parsedOnChainData.tiers.map(tier => {
            const priceBRLCents = Math.round(parseFloat(tier.price) * 100);
            return {
                name: tier.name,
                priceBrlCents: new anchor.BN(priceBRLCents),
                maxTicketsSupply: new anchor.BN(parseInt(tier.maxTicketsSupply, 10)),
            };
        });

        // Validar datas
        const salesStartDate = new Date(parsedOnChainData.salesStartDate);
        const salesEndDate = new Date(parsedOnChainData.salesEndDate);

        if (salesStartDate >= salesEndDate) {
            return res.status(400).json({
                success: false,
                error: "A data de fim das vendas deve ser posterior à data de início."
            });
        }

        // ✅ AGORA SIM: Salvar no Supabase (depois de todas as variáveis estarem definidas)
        console.log(' -> Salvando dados COMPLETOS no Supabase para performance...');

        // Preparar os dados para o Supabase
        const eventDataForSupabase = {
            eventAddress: eventPda.toString(),
            eventId: eventId.toString(),
            metadata: finalMetadata, // ✅ JSON COMPLETO com nome, descrição, organizer, etc
            imageUrl: imageUrl,
            createdBy: userPublicKey.toString(),
            controller: userPublicKey.toString(),
            salesStartDate: Math.floor(salesStartDate.getTime() / 1000),
            salesEndDate: Math.floor(salesEndDate.getTime() / 1000),
            maxTicketsPerWallet: parseInt(parsedOnChainData.maxTicketsPerWallet, 10),
            royaltyBps: parseInt(parsedOnChainData.royaltyBps, 10),
            tiers: tiersInput
        };

        // Salvar no Supabase (não-blocking para não atrasar a resposta)
        saveCompleteEventToSupabase(eventDataForSupabase)
            .then(() => console.log(' ✅ Dados salvos no Supabase com sucesso!'))
            .catch(err => console.warn(' ⚠️  Erro ao salvar no Supabase (não crítico):', err.message));

        // Continuar com o processo normal da blockchain...
        console.log(' -> Construindo transação...');
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        // Construir a transação
        const tx = await program.methods
            .createEvent(
                eventId,
                metadataUrl,
                new anchor.BN(Math.floor(salesStartDate.getTime() / 1000)),
                new anchor.BN(Math.floor(salesEndDate.getTime() / 1000)),
                parseInt(parsedOnChainData.royaltyBps, 10),
                parseInt(parsedOnChainData.maxTicketsPerWallet, 10),
                tiersInput
            )
            .accounts({
                whitelistAccount: whitelistPda,
                eventAccount: eventPda,
                controller: userPublicKey,
                payer: payerKeypair.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .transaction();

        // Resto do código permanece igual...
        tx.recentBlockhash = blockhash;
        tx.feePayer = payerKeypair.publicKey;

        console.log(' -> Assinando transação...');

        if (userKeypair) {
            console.log('🔐 Assinando com userKeypair (login local)...');
            tx.sign(userKeypair, payerKeypair);
        } else {
            console.log('🎯 Assinando apenas com payer (adapter - usuário assina no frontend)...');
            tx.sign(payerKeypair);

            const serializedTx = tx.serialize({ requireAllSignatures: false });
            const transactionBase64 = serializedTx.toString('base64');

            console.log('📤 Retornando transação para assinatura no frontend...');

            return res.status(200).json({
                success: true,
                transaction: transactionBase64,
                message: "Transação pronta para assinatura",
                eventPda: eventPda.toString(),
                eventId: eventId.toString(),
                metadataUrl: metadataUrl
            });
        }

        console.log(' -> Enviando transação para a blockchain...');

        const serializedTx = tx.serialize();
        const signature = await connection.sendRawTransaction(serializedTx, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
        });

        console.log(` -> Transação enviada: ${signature}`);
        console.log(' -> Aguardando confirmação...');

        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log(`[✔] Evento criado com sucesso! Assinatura: ${signature}`);
        console.log(`[🎉] Authority do evento: ${userPublicKey.toString()}`);
        console.log(`[🎉] Evento criado em: ${eventPda.toString()}`);

        res.status(200).json({
            success: true,
            signature,
            eventAddress: eventPda.toString(),
            eventId: eventId.toString(),
            metadataUrl: metadataUrl,
            authority: userPublicKey.toString(),
            message: "Evento criado automaticamente com sucesso!"
        });

    } catch (error) {
        console.error("❌ Erro no processo de criação completo do evento:", error);

        if (error.logs) {
            console.error('Logs da transação:', error.logs);
        }

        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            error: error.message || 'Ocorreu um erro interno no servidor.',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};
export const sendSignedTransaction = async (req, res) => {
    console.log('[+] Recebendo transação assinada do frontend...');

    try {
        const { signedTransaction } = req.body;

        if (!signedTransaction) {
            return res.status(400).json({
                success: false,
                error: "Transação assinada é obrigatória."
            });
        }

        console.log(' -> Desserializando transação assinada...');
        const transaction = Transaction.from(Buffer.from(signedTransaction, 'base64'));

        console.log(' -> Enviando transação para a blockchain...');
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
        });

        console.log(` -> Transação enviada: ${signature}`);

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        console.log(' -> Aguardando confirmação...');
        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log(`[✔] Transação assinada pelo frontend confirmada! Assinatura: ${signature}`);

        res.status(200).json({
            success: true,
            signature,
            message: "Transação assinada e confirmada com sucesso!"
        });

    } catch (error) {
        console.error("❌ Erro ao processar transação assinada:", error);

        res.status(500).json({
            success: false,
            error: error.message || 'Erro ao processar transação assinada.'
        });
    }
};
// controllers/eventController.js - FUNÇÃO ATUALIZADA
// controllers/eventController.js - ADICIONAR ESTAS FUNÇÕES

export const addValidatorGasless = async (req, res) => {
    console.log('[+] Recebida requisição para adicionar validador (gasless)...');

    try {
        const { eventAddress, validatorAddress, userLoginData } = req.body;

        if (!eventAddress || !validatorAddress || !userLoginData) {
            return res.status(400).json({
                success: false,
                error: "Endereço do evento, validador e dados de login são obrigatórios."
            });
        }

        console.log(` -> Evento: ${eventAddress}`);
        console.log(` -> Validador: ${validatorAddress}`);

        // ✅ Derivar keypair do usuário a partir dos dados de login
        const parsedUserLoginData = JSON.parse(userLoginData);
        const userKeypair = await deriveUserKeypair(parsedUserLoginData);
        const userPublicKey = userKeypair.publicKey;

        console.log(` -> Usuário autenticado: ${userPublicKey.toString()}`);

        // ✅ Buscar dados do evento para verificar permissões
        const eventPubkey = new PublicKey(eventAddress);
        let eventAccount;
        try {
            eventAccount = await program.account.event.fetch(eventPubkey);
            console.log(' ✅ Conta do evento encontrada');
        } catch (error) {
            console.error(' ❌ Erro ao buscar evento:', error);
            return res.status(404).json({
                success: false,
                error: "Evento não encontrado na blockchain."
            });
        }

        // ✅ Verificar se o usuário é o controller do evento
        if (!eventAccount.controller.equals(userPublicKey)) {
            console.log(` ❌ Permissão negada: ${eventAccount.controller.toString()} vs ${userPublicKey.toString()}`);
            return res.status(403).json({
                success: false,
                error: "Você não é o criador deste evento. Apenas o criador pode adicionar validadores."
            });
        }
        console.log(' ✅ Permissão concedida - usuário é o controller');

        // ✅ Validar endereço do validador
        let validatorPubkey;
        try {
            validatorPubkey = new PublicKey(validatorAddress);
            console.log(` ✅ Endereço do validador válido: ${validatorPubkey.toString()}`);
        } catch (error) {
            console.error(' ❌ Endereço do validador inválido:', error);
            return res.status(400).json({
                success: false,
                error: "Endereço do validador inválido."
            });
        }

        // ✅ Verificar se o validador já existe
        const existingValidators = eventAccount.validators || [];
        const isAlreadyValidator = existingValidators.some(v => v.equals(validatorPubkey));

        if (isAlreadyValidator) {
            console.log(' ⚠️  Validador já existe na lista');
            return res.status(400).json({
                success: false,
                error: "Este validador já está na lista de validadores do evento."
            });
        }

        console.log(' -> Preparando transação para adicionar validador...');

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        // ✅ Construir transação
        const tx = await program.methods
            .addValidator(validatorPubkey)
            .accounts({
                event: eventPubkey,
                controller: userPublicKey,
            })
            .transaction();

        // ✅ Configurar transação
        tx.recentBlockhash = blockhash;
        tx.feePayer = payerKeypair.publicKey;

        console.log(' -> Assinando transação...');

        // ✅ Assinar com userKeypair (derivado) e payer do sistema
        tx.sign(userKeypair, payerKeypair);

        console.log(' -> Enviando transação para a blockchain...');

        const serializedTx = tx.serialize();
        const signature = await connection.sendRawTransaction(serializedTx, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
        });

        console.log(` -> Transação enviada: ${signature}`);
        console.log(' -> Aguardando confirmação...');

        // ✅ Aguardar confirmação
        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log(`[✔] Validador adicionado com sucesso! Assinatura: ${signature}`);

        res.status(200).json({
            success: true,
            signature,
            validatorAddress: validatorPubkey.toString(),
            message: "Validador adicionado com sucesso via API!"
        });

    } catch (error) {
        console.error("❌ Erro no processo de adicionar validador:", error);

        if (error.logs) {
            console.error('Logs da transação:', error.logs);
        }

        res.status(500).json({
            success: false,
            error: error.message || 'Erro interno ao adicionar validador.',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};
export const getActiveEventsFast = async (req, res) => {
  console.log('[⚡] API RÁPIDA: Buscando eventos ativos (Supabase + Blockchain)...');
  const startTime = Date.now();

  try {
    // ✅ 1. BUSCAR EVENTOS ATIVOS APENAS DO SUPABASE (MAIS RÁPIDO)
    console.log('[⚡] Buscando eventos ativos APENAS do Supabase...');
    
    const { data: supabaseEvents, error } = await supabase
      .from('events')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Erro ao buscar eventos no Supabase:', error);
      return res.status(500).json({
        success: false,
        error: 'Erro ao buscar eventos'
      });
    }

    console.log(`[⚡] ${supabaseEvents?.length || 0} eventos ATIVOS carregados do Supabase em ${Date.now() - startTime}ms`);

    if (!supabaseEvents || supabaseEvents.length === 0) {
      return res.status(200).json([]);
    }

    console.log(`[⚡] Encontrados ${supabaseEvents.length} eventos ativos no Supabase`);

    // ✅ 2. PROCESSAR CADA EVENTO COM FALLBACK DE IMAGEM MELHORADO
    const processedEvents = await Promise.all(
      supabaseEvents.map(async (event) => {
        try {
          let finalMetadata = event.metadata || {};
          let finalImageUrl = event.image_url || '';
          let finalOrganizerLogo = finalMetadata.organizer?.organizerLogo || '';

          // ✅ 3. SE NÃO TEM METADADOS OU IMAGEM, TENTAR DA BLOCKCHAIN COMO FALLBACK
          if ((!finalMetadata.name || finalMetadata.name === 'Evento Sem Nome') && event.event_address) {
            console.log(` 🔄 Buscando dados da blockchain para fallback: ${event.event_address}`);
            try {
              const eventPubkey = new PublicKey(event.event_address);
              const blockchainAccount = await program.account.event.fetch(eventPubkey);
              
              if (blockchainAccount.metadataUri) {
                const ipfsMetadata = await fetchMetadataOptimized(blockchainAccount.metadataUri);
                if (ipfsMetadata) {
                  finalMetadata = { ...finalMetadata, ...ipfsMetadata };
                  finalImageUrl = finalImageUrl || ipfsMetadata.image || '';
                  finalOrganizerLogo = finalOrganizerLogo || ipfsMetadata.organizer?.organizerLogo || '';
                }
              }
            } catch (blockchainError) {
              console.warn(` ⚠️  Não foi possível buscar dados da blockchain para ${event.event_address}:`, blockchainError.message);
            }
          }

          // ✅ 4. APLICAR FALLBACK DE METADADOS SE NECESSÁRIO
          if (!finalMetadata.name || finalMetadata.name === 'Evento Sem Nome') {
            finalMetadata = {
              ...finalMetadata,
              name: event.event_name || "Evento em Andamento",
              description: finalMetadata.description || "Estamos preparando as informações deste evento. Volte em breve para mais detalhes.",
              category: finalMetadata.category || "Geral",
              properties: finalMetadata.properties || {
                dateTime: {
                  start: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                  end: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
                  timezone: "America/Sao_Paulo"
                },
                location: {
                  type: "Physical",
                  venueName: "Local a ser definido",
                  address: {
                    city: "São Paulo",
                    state: "SP",
                    country: "BR"
                  }
                }
              },
              organizer: finalMetadata.organizer || {
                name: "Organizador",
                contactEmail: "contato@evento.com",
                website: ""
              },
              additionalInfo: finalMetadata.additionalInfo || {
                ageRestriction: "Livre",
                accessibility: "Acessível",
                complementaryHours: 0
              }
            };
          }

          // ✅ 5. PROCESSAR IMAGENS COM FALLBACK MELHORADO
          try {
            const { eventImageUrl, organizerLogoUrl } = await getImagesWithFallback({
              image_url: finalImageUrl,
              metadata: finalMetadata
            });
            
            finalImageUrl = eventImageUrl;
            finalOrganizerLogo = organizerLogoUrl;
          } catch (imageError) {
            console.warn(` ⚠️  Erro ao processar imagens para ${event.event_address}:`, imageError.message);
          }

          // ✅ 6. ESTRUTURA FINAL DO EVENTO
          return {
            publicKey: event.event_address,
            account: {
              eventId: event.event_id,
              controller: event.controller,
              salesStartDate: { toNumber: () => event.sales_start_date },
              salesEndDate: { toNumber: () => event.sales_end_date },
              maxTicketsPerWallet: event.max_tickets_per_wallet || 1,
              royaltyBps: event.royalty_bps || 0,
              metadataUri: event.metadata_url,
              tiers: event.tiers || [],
              totalTicketsSold: event.total_tickets_sold || 0,
              maxTotalSupply: event.max_total_supply || 0,
              revenue: event.revenue || 0,
              isActive: event.is_active ?? true,
              canceled: event.canceled ?? false,
              state: 1
            },
            metadata: finalMetadata,
            imageUrl: finalImageUrl,
            organizerLogo: finalOrganizerLogo,
          };

        } catch (error) {
          console.error(`❌ Erro ao processar evento ${event.event_address}:`, error);
          return null;
        }
      })
    );

    // ✅ 7. FILTRAR EVENTOS VÁLIDOS
    const validEvents = processedEvents.filter(event => event !== null);
    
    const totalDuration = Date.now() - startTime;
    console.log(`[⚡] API RÁPIDA: ${validEvents.length} eventos processados em ${totalDuration}ms`);

    res.status(200).json(validEvents);

  } catch (error) {
    console.error('[❌] Erro crítico na API rápida de eventos:', error);
    
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor ao buscar eventos',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.ipfs.io/ipfs/',
  'https://cf-ipfs.com/ipfs/',
  'https://dweb.link/ipfs/',
  'https://ipfs.fleek.co/ipfs/',
  'https://gateway.pinata.cloud/ipfs/' // Menor prioridade - movido para o final
];

// Gateways públicos confiáveis que geralmente funcionam melhor
const PUBLIC_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.ipfs.io/ipfs/',
  'https://cf-ipfs.com/ipfs/'
];

// Timeout reduzido para gateways mais rápidos
const FAST_TIMEOUT = 2000;
const SLOW_TIMEOUT = 4000;

/**
 * Extrai o CID de uma URL IPFS - versão melhorada
 */
function extractCID(ipfsUrl) {
  if (!ipfsUrl) return null;
  
  // Remove query parameters e fragments
  const cleanUrl = ipfsUrl.split('?')[0].split('#')[0];
  
  // Padrões comuns de URLs IPFS
  const patterns = [
    /\/ipfs\/([a-zA-Z0-9]+)/, // URL com gateway: https://gateway.pinata.cloud/ipfs/Qm...
    /^(Qm[1-9A-HJ-NP-Za-km-z]{44})/, // CID direto: Qm...
    /^bafybei[a-zA-Z0-9]+/, // CID v1: bafybei...
    /ipfs\/([a-zA-Z0-9]+)/, // Padrão alternativo
  ];

  for (const pattern of patterns) {
    const match = cleanUrl.match(pattern);
    if (match) {
      return match[1] || match[0];
    }
  }

  return null;
}

/**
 * Verifica se uma URL é acessível - versão melhorada com retry
 */
async function checkUrlAccessibility(url, timeout = FAST_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    // Usamos HEAD para ser mais rápido, mas se falhar tentamos GET
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IPFS-Gateway-Check/1.0)'
      }
    });
    
    clearTimeout(timeoutId);
    
    // Aceita 200, 206 (partial content), 304 (not modified)
    if (response.ok || response.status === 206 || response.status === 304) {
      return true;
    }
    
    // Se HEAD não é suportado, tentamos GET com range
    if (response.status === 405) {
      return await checkWithGet(url, timeout);
    }
    
    return false;
  } catch (error) {
    clearTimeout(timeoutId);
    return false;
  }
}

/**
 * Verifica com método GET como fallback
 */
async function checkWithGet(url, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Range': 'bytes=0-0', // Pega apenas os primeiros bytes
        'User-Agent': 'Mozilla/5.0 (compatible; IPFS-Gateway-Check/1.0)'
      }
    });
    
    clearTimeout(timeoutId);
    return response.ok || response.status === 206;
  } catch (error) {
    clearTimeout(timeoutId);
    return false;
  }
}

/**
 * Tenta acessar uma imagem IPFS através de múltiplos gateways - versão melhorada
 */
async function getAccessibleIpfsUrl(ipfsUrl) {
  if (!ipfsUrl) return ipfsUrl;

  const cid = extractCID(ipfsUrl);
  if (!cid) {
    console.log(` ⚠️  Não é uma URL IPFS válida: ${ipfsUrl}`);
    return ipfsUrl;
  }

  console.log(` 🔍 Buscando CID: ${cid}`);

  // Primeiro: tenta gateways públicos rápidos
  for (const gateway of PUBLIC_GATEWAYS) {
    const gatewayUrl = `${gateway}${cid}`;
    
    // Pula se for o mesmo da URL original
    if (gatewayUrl === ipfsUrl) continue;
    
    try {
      console.log(` 🚀 Tentando gateway rápido: ${gateway}`);
      
      if (await checkUrlAccessibility(gatewayUrl, FAST_TIMEOUT)) {
        console.log(` ✅ Gateway rápido funcionando: ${gateway}`);
        return gatewayUrl;
      }
    } catch (error) {
      console.log(` ❌ Gateway rápido falhou: ${gateway}`);
    }
  }

  // Segundo: tenta a URL original (pode ser um gateway específico)
  try {
    console.log(` 🔄 Tentando URL original: ${ipfsUrl}`);
    
    if (await checkUrlAccessibility(ipfsUrl, SLOW_TIMEOUT)) {
      console.log(` ✅ URL original funcionando: ${ipfsUrl}`);
      return ipfsUrl;
    }
  } catch (error) {
    console.log(` ❌ URL original falhou: ${ipfsUrl}`);
  }

  // Terceiro: tenta gateways restantes com timeout maior
  const remainingGateways = IPFS_GATEWAYS.filter(g => 
    !PUBLIC_GATEWAYS.includes(g) && `${g}${cid}` !== ipfsUrl
  );

  for (const gateway of remainingGateways) {
    const gatewayUrl = `${gateway}${cid}`;
    
    try {
      console.log(` 🐌 Tentando gateway lento: ${gateway}`);
      
      if (await checkUrlAccessibility(gatewayUrl, SLOW_TIMEOUT)) {
        console.log(` ✅ Gateway lento funcionando: ${gateway}`);
        return gatewayUrl;
      }
    } catch (error) {
      console.log(` ❌ Gateway lento falhou: ${gateway}`);
    }
  }

  // Se nenhum gateway funcionou, retorna a URL original
  console.log(` ⚠️  Todos os gateways falharam para CID: ${cid}`);
  return ipfsUrl;
}

/**
 * Processa URLs IPFS com cache e fallback inteligente
 */
async function processIpfsUrlsInObject(obj, processedUrls = new Map()) {
  if (!obj || typeof obj !== 'object') return obj;

  const result = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && 
        (value.includes('ipfs') || value.includes('Qm') || value.includes('bafybei'))) {
      
      // Verifica se já processamos esta URL
      if (processedUrls.has(value)) {
        result[key] = processedUrls.get(value);
      } else {
        try {
          const processedUrl = await getAccessibleIpfsUrl(value);
          result[key] = processedUrl;
          processedUrls.set(value, processedUrl);
          
          // Log apenas se a URL foi alterada
          if (processedUrl !== value) {
            console.log(` 🔄 URL otimizada: ${value} -> ${processedUrl}`);
          }
        } catch (error) {
          console.warn(` ❌ Erro ao processar URL: ${value}`, error.message);
          result[key] = value; // Mantém original em caso de erro
          processedUrls.set(value, value);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      result[key] = await processIpfsUrlsInObject(value, processedUrls);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Função principal: Substitui URLs IPFS por URLs acessíveis - versão melhorada
 */
async function getImagesWithFallback(supabaseEvent) {
  console.log(' 🖼️  Processando URLs IPFS com fallback inteligente...');
  
  if (!supabaseEvent) {
    return {
      eventImageUrl: '',
      organizerLogoUrl: ''
    };
  }

  try {
    // Cria uma cópia profunda para não modificar o original
    const processedEvent = JSON.parse(JSON.stringify(supabaseEvent));
    const processedUrls = new Map();
    
    // Processa image_url direto primeiro
    if (processedEvent.image_url) {
      processedEvent.image_url = await getAccessibleIpfsUrl(processedEvent.image_url);
      processedUrls.set(supabaseEvent.image_url, processedEvent.image_url);
    }

    // Processa metadados recursivamente
    if (processedEvent.metadata) {
      processedEvent.metadata = await processIpfsUrlsInObject(processedEvent.metadata, processedUrls);
    }

    // Extrai as URLs finais
    const eventImageUrl = processedEvent.image_url || 
                         (processedEvent.metadata?.image || '');
    
    const organizerLogoUrl = processedEvent.metadata?.organizer?.organizerLogo || '';

    console.log(' ✅ URLs IPFS processadas com sucesso');
    console.log(`   - Event Image: ${eventImageUrl}`);
    console.log(`   - Organizer Logo: ${organizerLogoUrl || 'Não disponível'}`);
    console.log(`   - Total de URLs processadas: ${processedUrls.size}`);

    return {
      eventImageUrl,
      organizerLogoUrl,
      processedEvent // Opcional: retorna o evento completo processado
    };

  } catch (error) {
    console.error(' ❌ Erro ao processar URLs IPFS:', error);
    
    // Fallback: retorna URLs originais em caso de erro
    return {
      eventImageUrl: supabaseEvent.image_url || 
                    (supabaseEvent.metadata?.image || ''),
      organizerLogoUrl: supabaseEvent.metadata?.organizer?.organizerLogo || ''
    };
  }
}

export const getEventDetailsFast = async (req, res) => {
  const { eventAddress } = req.params;
  
  if (!eventAddress) {
    return res.status(400).json({ 
      success: false, 
      error: 'O endereço do evento é obrigatório.' 
    });
  }

  console.log(`[🔍] BUSCA ULTRA-RÁPIDA: ${eventAddress}`);
  const startTime = Date.now();

  try {
    const eventPubkey = new PublicKey(eventAddress);
    
    // ✅ 1. PRIMEIRO: Buscar do Supabase (mais rápido)
    console.log(' -> Buscando dados do Supabase...');
    let supabaseEvent = null;
    let finalMetadata = {};
    let finalImageUrl = '';
    let finalOrganizerLogo = '';

    try {
      const { data: event, error } = await supabase
        .from('events')
        .select('*')
        .eq('event_address', eventAddress)
        .single();

      if (!error && event) {
        supabaseEvent = event;
        console.log(` ✅ Evento encontrado no Supabase: "${event.metadata?.name || 'Sem nome'}"`);
        
        // ✅ EXTRAIR DADOS REAIS DO SUPABASE
        finalMetadata = event.metadata || {};
        finalImageUrl = event.image_url || '';
        finalOrganizerLogo = event.metadata?.organizer?.organizerLogo || '';
        
        console.log(' 📊 Dados extraídos do Supabase:', {
          name: finalMetadata.name,
          hasDescription: !!finalMetadata.description,
          hasLocation: !!finalMetadata.properties?.location,
          hasDateTime: !!finalMetadata.properties?.dateTime,
          hasOrganizer: !!finalMetadata.organizer,
          tiersCount: event.tiers?.length || 0
        });
      } else {
        console.warn(' ⚠️  Evento não encontrado no Supabase:', error?.message);
      }
    } catch (supabaseError) {
      console.warn(' ⚠️  Erro ao buscar do Supabase:', supabaseError.message);
    }

    // ✅ 2. BUSCAR DADOS DA BLOCKCHAIN PARA TICKETS E TIERS
    console.log(' -> Buscando dados completos da blockchain...');
    let blockchainAccount = null;
    let blockchainTiers = [];
    let totalTicketsSold = 0;
    let maxTotalSupply = 0;

    try {
      blockchainAccount = await program.account.event.fetch(eventPubkey);
      console.log(' ✅ Dados da blockchain recebidos');

      // ✅ PROCESSAR TIERS DA BLOCKCHAIN CORRETAMENTE
      if (blockchainAccount.tiers && blockchainAccount.tiers.length > 0) {
        console.log(` -> Processando ${blockchainAccount.tiers.length} tiers da blockchain...`);
        
        blockchainTiers = blockchainAccount.tiers.map((tier, index) => {
          // ✅ EXTRAIR VALORES CORRETAMENTE DOS BN (BigNumber)
          let priceBrlCents = 0;
          let maxTicketsSupply = 0;
          let ticketsSold = 0;

          try {
            // Preço em centavos
            if (tier.priceBrlCents) {
              priceBrlCents = typeof tier.priceBrlCents.toNumber === 'function' 
                ? tier.priceBrlCents.toNumber() 
                : Number(tier.priceBrlCents);
            }

            // Supply máximo
            if (tier.maxTicketsSupply) {
              maxTicketsSupply = typeof tier.maxTicketsSupply.toNumber === 'function'
                ? tier.maxTicketsSupply.toNumber()
                : Number(tier.maxTicketsSupply);
            }

            // Tickets vendidos
            if (tier.ticketsSold) {
              ticketsSold = typeof tier.ticketsSold.toNumber === 'function'
                ? tier.ticketsSold.toNumber()
                : Number(tier.ticketsSold);
            }
          } catch (error) {
            console.warn(` ❌ Erro ao processar tier ${index}:`, error.message);
          }

          const ticketsRemaining = maxTicketsSupply - ticketsSold;
          
          return {
            name: tier.name || `Tier ${index + 1}`,
            priceBrlCents: priceBrlCents,
            priceBrl: (priceBrlCents / 100).toFixed(2),
            maxTicketsSupply: maxTicketsSupply,
            ticketsSold: ticketsSold,
            ticketsRemaining: ticketsRemaining,
            isSoldOut: ticketsRemaining <= 0
          };
        });

        // ✅ CALCULAR TOTAIS DOS TIERS
        totalTicketsSold = blockchainTiers.reduce((sum, tier) => sum + tier.ticketsSold, 0);
        maxTotalSupply = blockchainTiers.reduce((sum, tier) => sum + tier.maxTicketsSupply, 0);

        console.log(` ✅ Tiers processados: ${blockchainTiers.length} tiers, ${totalTicketsSold}/${maxTotalSupply} tickets`);
      }

      // ✅ TENTAR USAR total_tickets_sold DA CONTA SE DISPONÍVEL
      if (blockchainAccount.totalTicketsSold) {
        try {
          const accountTotalSold = typeof blockchainAccount.totalTicketsSold.toNumber === 'function'
            ? blockchainAccount.totalTicketsSold.toNumber()
            : Number(blockchainAccount.totalTicketsSold);
          
          if (accountTotalSold > totalTicketsSold) {
            console.log(` 🔄 Usando totalTicketsSold da conta: ${accountTotalSold}`);
            totalTicketsSold = accountTotalSold;
          }
        } catch (error) {
          console.warn(' ❌ Erro ao processar totalTicketsSold da conta:', error.message);
        }
      }

      // ✅ BUSCAR METADADOS DO IPFS COM MÚLTIPLOS FALLBACKS (IGUAL AO getActiveEventsFast)
      if (!supabaseEvent && blockchainAccount.metadataUri) {
        try {
          console.log(' -> Buscando metadados do IPFS com múltiplos fallbacks...');
          const ipfsMetadata = await fetchMetadataWithMultipleFallbacks(blockchainAccount.metadataUri);
          
          if (ipfsMetadata) {
            finalMetadata = ipfsMetadata;
            finalImageUrl = ipfsMetadata.image || '';
            finalOrganizerLogo = ipfsMetadata.organizer?.organizerLogo || '';
            console.log(' ✅ Metadados carregados do IPFS com fallbacks');
          } else {
            console.warn(' ⚠️  Não foi possível carregar metadados do IPFS mesmo com fallbacks');
          }
        } catch (ipfsError) {
          console.warn(' ⚠️  Erro ao buscar metadados do IPFS:', ipfsError.message);
        }
      }

    } catch (blockchainError) {
      console.error(' ❌ Erro ao buscar evento na blockchain:', blockchainError);
      // Não retornamos erro aqui, pois podemos usar dados do Supabase
    }

    // ✅ 3. SE NÃO ENCONTROU METADADOS, TENTAR FALLBACKS ADICIONAIS (IGUAL AO getActiveEventsFast)
    if ((!finalMetadata.name || finalMetadata.name === 'Evento Sem Nome') && eventAddress) {
      console.log(` 🔄 Tentando fallbacks adicionais para: ${eventAddress}`);
      
      // ✅ ESTRATÉGIA: Buscar dados da blockchain para fallback (se não tentou antes)
      if (!blockchainAccount) {
        try {
          console.log(' -> Buscando dados da blockchain como fallback...');
          const fallbackBlockchainAccount = await program.account.event.fetch(eventPubkey);
          
          if (fallbackBlockchainAccount.metadataUri) {
            console.log(' -> Tentando IPFS novamente com fallback...');
            const ipfsMetadata = await fetchMetadataWithMultipleFallbacks(fallbackBlockchainAccount.metadataUri);
            if (ipfsMetadata) {
              finalMetadata = { ...finalMetadata, ...ipfsMetadata };
              finalImageUrl = finalImageUrl || ipfsMetadata.image || '';
              finalOrganizerLogo = finalOrganizerLogo || ipfsMetadata.organizer?.organizerLogo || '';
              console.log(' ✅ Metadados carregados via fallback da blockchain');
            }
          }
        } catch (fallbackError) {
          console.warn(` ⚠️  Não foi possível buscar dados da blockchain como fallback:`, fallbackError.message);
        }
      }
    }

    // ✅ 4. APLICAR FALLBACK DE METADADOS SE NECESSÁRIO (IGUAL AO getActiveEventsFast)
    if (!finalMetadata.name || finalMetadata.name === 'Evento Sem Nome') {
      console.warn(' ⚠️  Usando metadados fallback aprimorados');
      finalMetadata = {
        ...finalMetadata,
        name: "Evento em Andamento",
        description: finalMetadata.description || "Estamos preparando as informações deste evento. Volte em breve para mais detalhes.",
        category: finalMetadata.category || "Geral",
        properties: finalMetadata.properties || {
          dateTime: {
            start: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            end: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
            timezone: "America/Sao_Paulo"
          },
          location: {
            type: "Physical",
            venueName: "Local a ser definido",
            address: {
              city: "São Paulo",
              state: "SP",
              country: "BR"
            }
          }
        },
        organizer: finalMetadata.organizer || {
          name: "Organizador",
          contactEmail: "contato@evento.com",
          website: ""
        },
        additionalInfo: finalMetadata.additionalInfo || {
          ageRestriction: "Livre",
          accessibility: "Acessível",
          complementaryHours: 0
        }
      };
    }

    // ✅ 5. PROCESSAR IMAGENS COM FALLBACK MELHORADO (IGUAL AO getActiveEventsFast)
    try {
      console.log(' -> Processando imagens com múltiplos fallbacks...');
      
      // ✅ PRIMEIRO: Tentar processar com getImagesWithFallback
      const { eventImageUrl, organizerLogoUrl } = await getImagesWithFallback({
        image_url: finalImageUrl,
        metadata: finalMetadata
      });
      
      finalImageUrl = eventImageUrl;
      finalOrganizerLogo = organizerLogoUrl;
      console.log(' ✅ Imagens processadas com fallback principal');
      
    } catch (imageError) {
      console.warn(' ⚠️  Erro ao processar imagens com fallback principal:', imageError.message);
      
      // ✅ SEGUNDO: Fallback manual para imagens IPFS
      try {
        if (finalImageUrl && (finalImageUrl.includes('ipfs') || finalImageUrl.includes('pinata'))) {
          console.log(' -> Aplicando fallback manual para imagem IPFS...');
          const accessibleImageUrl = await getAccessibleIpfsUrl(finalImageUrl);
          if (accessibleImageUrl && accessibleImageUrl !== finalImageUrl) {
            finalImageUrl = accessibleImageUrl;
            console.log(' ✅ Imagem IPFS otimizada com fallback manual');
          }
        }
        
        if (finalOrganizerLogo && (finalOrganizerLogo.includes('ipfs') || finalOrganizerLogo.includes('pinata'))) {
          console.log(' -> Aplicando fallback manual para logo do organizador...');
          const accessibleLogoUrl = await getAccessibleIpfsUrl(finalOrganizerLogo);
          if (accessibleLogoUrl && accessibleLogoUrl !== finalOrganizerLogo) {
            finalOrganizerLogo = accessibleLogoUrl;
            console.log(' ✅ Logo do organizador otimizado com fallback manual');
          }
        }
      } catch (manualFallbackError) {
        console.warn(' ⚠️  Erro no fallback manual de imagens:', manualFallbackError.message);
      }
    }

    // ✅ 6. USAR TIERS DA BLOCKCHAIN (PREFERÊNCIA) OU DO SUPABASE
    let formattedTiers = blockchainTiers;
    
    // Se não tem tiers da blockchain, tentar do Supabase
    if (formattedTiers.length === 0 && supabaseEvent?.tiers) {
      console.log(' -> Usando tiers do Supabase como fallback...');
      formattedTiers = (supabaseEvent.tiers || []).map((tier, index) => {
        const maxTicketsSupply = Number(tier.maxTicketsSupply || tier.max_tickets_supply || 0);
        const ticketsSold = Number(tier.ticketsSold || tier.tickets_sold || 0);
        const priceBrlCents = Number(tier.priceBrlCents || tier.price_brl_cents || 0);
        
        return {
          name: tier.name || `Tier ${index + 1}`,
          priceBrlCents: priceBrlCents,
          priceBrl: (priceBrlCents / 100).toFixed(2),
          maxTicketsSupply: maxTicketsSupply,
          ticketsSold: ticketsSold,
          ticketsRemaining: maxTicketsSupply - ticketsSold,
          isSoldOut: (maxTicketsSupply - ticketsSold) <= 0
        };
      });

      // Recalcular totais se usando tiers do Supabase
      if (totalTicketsSold === 0) {
        totalTicketsSold = formattedTiers.reduce((sum, tier) => sum + tier.ticketsSold, 0);
      }
      if (maxTotalSupply === 0) {
        maxTotalSupply = formattedTiers.reduce((sum, tier) => sum + tier.maxTicketsSupply, 0);
      }
    }

    // ✅ 7. ESTRUTURA FINAL COMPLETA DO EVENTO
    const eventData = {
      publicKey: eventAddress,
      account: {
        // Dados básicos do evento
        eventId: blockchainAccount?.eventId || supabaseEvent?.event_id,
        controller: blockchainAccount?.controller?.toString() || supabaseEvent?.controller,
        salesStartDate: blockchainAccount?.salesStartDate || { toNumber: () => supabaseEvent?.sales_start_date },
        salesEndDate: blockchainAccount?.salesEndDate || { toNumber: () => supabaseEvent?.sales_end_date },
        maxTicketsPerWallet: blockchainAccount?.maxTicketsPerWallet?.toNumber?.() || supabaseEvent?.max_tickets_per_wallet || 1,
        royaltyBps: blockchainAccount?.royaltyBps?.toNumber?.() || supabaseEvent?.royalty_bps || 0,
        metadataUri: blockchainAccount?.metadataUri || supabaseEvent?.metadata_url,
        
        // ✅ TIERS PROCESSADOS COM DADOS DE TICKETS
        tiers: formattedTiers,
        
        // ✅ DADOS DE TICKETS VENDIDOS (AGORA CORRETOS)
        totalTicketsSold: totalTicketsSold,
        maxTotalSupply: maxTotalSupply,
        
        // Outros dados
        revenue: blockchainAccount?.revenue?.toNumber?.() || 0,
        isActive: blockchainAccount?.isActive ?? true,
        canceled: blockchainAccount?.canceled ?? false,
        validators: (blockchainAccount?.validators || []).map(v => v.toString()),
        state: blockchainAccount?.state || 1
      },
      metadata: finalMetadata,
      imageUrl: finalImageUrl,
      organizerLogo: finalOrganizerLogo,
      
      // ✅ ESTATÍSTICAS ADICIONAIS
      stats: {
        progressPercentage: maxTotalSupply > 0 ? Math.round((totalTicketsSold / maxTotalSupply) * 100) : 0,
        soldOutTiers: formattedTiers.filter(tier => tier.isSoldOut).length,
        availableTiers: formattedTiers.filter(tier => !tier.isSoldOut && tier.ticketsRemaining > 0).length
      }
    };

    const duration = Date.now() - startTime;
    console.log(`[✅] DETALHES CARREGADOS EM ${duration}ms`);
    console.log(` 📊 RESUMO DO EVENTO:`);
    console.log(`   - Nome: ${finalMetadata.name}`);
    console.log(`   - Tiers: ${formattedTiers.length}`);
    console.log(`   - Ingressos: ${totalTicketsSold}/${maxTotalSupply} vendidos (${eventData.stats.progressPercentage}%)`);
    console.log(`   - Tiers esgotados: ${eventData.stats.soldOutTiers}`);
    console.log(`   - Fonte: ${supabaseEvent ? 'Supabase' : blockchainAccount ? 'Blockchain' : 'Fallback'}`);
    console.log(`   - Imagem: ${finalImageUrl ? '✓' : '✗'}`);
    console.log(`   - Logo Organizador: ${finalOrganizerLogo ? '✓' : '✗'}`);

    res.status(200).json({
      success: true,
      event: eventData,
      dataSources: {
        blockchain: !!blockchainAccount,
        supabase: !!supabaseEvent,
        ipfsFallback: true,
        usedFallback: !supabaseEvent && !blockchainAccount,
        imageSource: finalImageUrl ? 'processed' : 'fallback',
        metadataSource: supabaseEvent ? 'supabase' : blockchainAccount ? 'blockchain+ipfs' : 'fallback'
      },
      performance: {
        duration: duration,
        source: supabaseEvent ? 'supabase' : blockchainAccount ? 'blockchain' : 'fallback'
      }
    });

  } catch (error) {
    console.error("[❌] Erro crítico ao buscar detalhes do evento:", error);

    if (error.message.includes('Invalid public key')) {
      return res.status(400).json({
        success: false,
        error: 'O endereço do evento fornecido é inválido.'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Ocorreu um erro no servidor ao buscar os dados do evento.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ✅ FUNÇÃO AUXILIAR: Buscar metadados com múltiplos fallbacks (igual ao getActiveEventsFast)
const fetchMetadataWithMultipleFallbacks = async (metadataUri) => {
  if (!metadataUri) return null;

  console.log(`   🔄 Tentando múltiplos fallbacks para: ${metadataUri}`);
  
  const strategies = [
    // Estratégia 1: fetchMetadataOptimized (já tem fallbacks internos)
    async () => {
      try {
        console.log('     🚀 Tentando fetchMetadataOptimized...');
        const result = await fetchMetadataOptimized(metadataUri);
        if (result) {
          console.log('     ✅ Sucesso com fetchMetadataOptimized');
          return result;
        }
      } catch (error) {
        console.log('     ❌ fetchMetadataOptimized falhou:', error.message);
      }
      return null;
    },
    
    // Estratégia 2: Tentar gateways alternativos manualmente
    async () => {
      try {
        console.log('     🌐 Tentando gateways alternativos manualmente...');
        const gateways = [
          metadataUri.replace('https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/'),
          metadataUri.replace('https://gateway.pinata.cloud/ipfs/', 'https://cloudflare-ipfs.com/ipfs/'),
          metadataUri.replace('https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'),
          metadataUri.replace('https://gateway.pinata.cloud/ipfs/', 'https://gateway.ipfs.io/ipfs/'),
        ];

        for (const gateway of gateways) {
          if (gateway === metadataUri) continue; // Pular se for o mesmo
          
          try {
            console.log(`       🔄 Tentando gateway: ${new URL(gateway).hostname}`);
            const response = await fetch(gateway, { timeout: 5000 });
            if (response.ok) {
              const metadata = await response.json();
              console.log(`       ✅ Sucesso com gateway: ${new URL(gateway).hostname}`);
              return metadata;
            }
          } catch (gatewayError) {
            console.log(`       ❌ Gateway falhou: ${new URL(gateway).hostname}`);
          }
        }
      } catch (error) {
        console.log('     ❌ Gateways alternativos falharam:', error.message);
      }
      return null;
    },
    
    // Estratégia 3: Tentar com timeout mais longo
    async () => {
      try {
        console.log('     ⏱️  Tentando com timeout estendido...');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10 segundos
        
        const response = await fetch(metadataUri, { 
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; EventApp/1.0)'
          }
        });
        
        clearTimeout(timeout);
        
        if (response.ok) {
          const metadata = await response.json();
          console.log('     ✅ Sucesso com timeout estendido');
          return metadata;
        }
      } catch (error) {
        console.log('     ❌ Timeout estendido falhou:', error.message);
      }
      return null;
    }
  ];

  // Executar todas as estratégias em sequência
  for (const strategy of strategies) {
    const result = await strategy();
    if (result) {
      return result;
    }
  }

  console.log('   ❌ Todos os fallbacks de metadados falharam');
  return null;
};

// ✅ FUNÇÃO AUXILIAR PARA ATUALIZAR SUPABASE COM DADOS DE TICKETS
export const updateEventTicketsInSupabase = async (eventAddress, tiers, totalTicketsSold, maxTotalSupply) => {
  try {
    console.log(`[🔄] Atualizando dados de tickets no Supabase: ${eventAddress}`);
    
    const { error } = await supabase
      .from('events')
      .update({
        tiers: tiers,
        total_tickets_sold: totalTicketsSold,
        max_total_supply: maxTotalSupply,
        updated_at: new Date().toISOString()
      })
      .eq('event_address', eventAddress);

    if (error) {
      console.warn(' ⚠️  Erro ao atualizar tickets no Supabase:', error.message);
      return false;
    }

    console.log(' ✅ Dados de tickets atualizados no Supabase');
    return true;
  } catch (error) {
    console.warn(' ⚠️  Erro ao atualizar Supabase:', error.message);
    return false;
  }
};

// ✅ API PARA SINCRONIZAR DADOS DE TICKETS MANUALMENTE
export const syncEventTickets = async (req, res) => {
  const { eventAddress } = req.params;

  console.log(`[🔄] SINCRONIZANDO TICKETS: ${eventAddress}`);
  
  try {
    const eventPubkey = new PublicKey(eventAddress);
    
    // Buscar dados atualizados da blockchain
    const blockchainAccount = await program.account.event.fetch(eventPubkey);
    
    let totalTicketsSold = 0;
    let maxTotalSupply = 0;
    const formattedTiers = [];

    if (blockchainAccount.tiers && blockchainAccount.tiers.length > 0) {
      blockchainAccount.tiers.forEach((tier, index) => {
        let priceBrlCents = 0;
        let maxTicketsSupply = 0;
        let ticketsSold = 0;

        try {
          if (tier.priceBrlCents) {
            priceBrlCents = typeof tier.priceBrlCents.toNumber === 'function' 
              ? tier.priceBrlCents.toNumber() 
              : Number(tier.priceBrlCents);
          }
          if (tier.maxTicketsSupply) {
            maxTicketsSupply = typeof tier.maxTicketsSupply.toNumber === 'function'
              ? tier.maxTicketsSupply.toNumber()
              : Number(tier.maxTicketsSupply);
          }
          if (tier.ticketsSold) {
            ticketsSold = typeof tier.ticketsSold.toNumber === 'function'
              ? tier.ticketsSold.toNumber()
              : Number(tier.ticketsSold);
          }
        } catch (error) {
          console.warn(` ❌ Erro ao processar tier ${index}:`, error.message);
        }

        formattedTiers.push({
          name: tier.name || `Tier ${index + 1}`,
          priceBrlCents: priceBrlCents,
          maxTicketsSupply: maxTicketsSupply,
          ticketsSold: ticketsSold,
          ticketsRemaining: maxTicketsSupply - ticketsSold,
          isSoldOut: (maxTicketsSupply - ticketsSold) <= 0
        });

        totalTicketsSold += ticketsSold;
        maxTotalSupply += maxTicketsSupply;
      });
    }

    // Atualizar no Supabase
    const updateSuccess = await updateEventTicketsInSupabase(
      eventAddress,
      formattedTiers,
      totalTicketsSold,
      maxTotalSupply
    );

    res.status(200).json({
      success: true,
      updated: updateSuccess,
      stats: {
        totalTicketsSold,
        maxTotalSupply,
        tiersCount: formattedTiers.length
      }
    });

  } catch (error) {
    console.error('[❌] Erro ao sincronizar tickets:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao sincronizar dados de tickets'
    });
  }
};

// Busca eventos para gestão - APENAS do Supabase
export const getEventsForManagementFast = async (req, res) => {
    const { userPublicKey } = req.params;

    console.log(`[⚡] API RÁPIDA: Buscando eventos para gestão de ${userPublicKey}...`);
    const startTime = Date.now();

    try {
        const events = await getEventsByCreator(userPublicKey);

        const formattedEvents = events.map(event => ({
            publicKey: event.event_address,
            account: {
                eventId: event.event_id,
                controller: event.controller,
                salesStartDate: { toNumber: () => event.sales_start_date },
                salesEndDate: { toNumber: () => event.sales_end_date },
                maxTicketsPerWallet: event.max_tickets_per_wallet,
                royaltyBps: event.royalty_bps,
                tiers: event.tiers || []
            },
            metadata: event.metadata, // ✅ TODOS os dados já aqui
            imageUrl: event.image_url,
            created_at: event.created_at
        }));

        const duration = Date.now() - startTime;
        console.log(`[⚡] API RÁPIDA: ${formattedEvents.length} eventos de gestão em ${duration}ms`);

        res.status(200).json({
            success: true,
            events: formattedEvents
        });

    } catch (error) {
        console.error("[❌] Erro na API rápida de gestão:", error);
        res.status(500).json({
            success: false,
            error: "Erro interno do servidor"
        });
    }
};
export const cancelEventGasless = async (req, res) => {
    console.log('[+] Recebida requisição para cancelar evento (gasless)...');

    try {
        // ✅ VERIFICAR DADOS DA REQUISIÇÃO
        console.log('📨 Body recebido:', req.body);
        console.log('📍 Parâmetros da URL:', req.params);

        const { eventAddress, userLoginData } = req.body;

        // ✅ VALIDAÇÃO MAIS ROBUSTA
        if (!eventAddress || !userLoginData) {
            console.log('❌ Dados faltando:', {
                eventAddress: !!eventAddress,
                userLoginData: !!userLoginData
            });

            return res.status(400).json({
                success: false,
                error: "Endereço do evento e dados de login são obrigatórios.",
                received: {
                    eventAddress: !!eventAddress,
                    userLoginData: !!userLoginData
                }
            });
        }

        console.log(` -> Evento a ser cancelado: ${eventAddress}`);

        // ✅ TRY-CATCH PARA PARSING DO userLoginData
        let parsedUserLoginData;
        try {
            parsedUserLoginData = JSON.parse(userLoginData);
            console.log('✅ userLoginData parseado com sucesso:', parsedUserLoginData);
        } catch (parseError) {
            console.error('❌ Erro ao fazer parse do userLoginData:', parseError);
            return res.status(400).json({
                success: false,
                error: "Formato inválido dos dados de login.",
                details: parseError.message
            });
        }

        // ✅ VERIFICAR SE OS DADOS DE LOGIN SÃO VÁLIDOS
        if (!parsedUserLoginData.loginType || !parsedUserLoginData.username) {
            console.error('❌ Dados de login incompletos:', parsedUserLoginData);
            return res.status(400).json({
                success: false,
                error: "Dados de login incompletos."
            });
        }

        console.log(` -> Tentando derivar keypair para: ${parsedUserLoginData.username}`);

        // ✅ DERIVAR KEYPAIR COM TRY-CATCH
        let userKeypair;
        try {
            userKeypair = await deriveUserKeypair(parsedUserLoginData);

            if (!userKeypair || !userKeypair.publicKey) {
                throw new Error("Falha ao derivar keypair do usuário");
            }

            const userPublicKey = userKeypair.publicKey;
            console.log(` ✅ Keypair derivado: ${userPublicKey.toString()}`);

            // ✅ BUSCAR DADOS DO EVENTO
            const eventPubkey = new PublicKey(eventAddress);
            let eventAccount;
            try {
                eventAccount = await program.account.event.fetch(eventPubkey);
                console.log(' ✅ Conta do evento encontrada');
            } catch (error) {
                console.error(' ❌ Erro ao buscar evento:', error);
                return res.status(404).json({
                    success: false,
                    error: "Evento não encontrado na blockchain."
                });
            }

            // ✅ VERIFICAR PERMISSÕES
            if (!eventAccount.controller.equals(userPublicKey)) {
                console.log(` ❌ Permissão negada: ${eventAccount.controller.toString()} vs ${userPublicKey.toString()}`);
                return res.status(403).json({
                    success: false,
                    error: "Você não é o criador deste evento. Apenas o criador pode cancelar o evento."
                });
            }

            // ✅ VERIFICAR SE JÁ ESTÁ CANCELADO
            if (eventAccount.canceled) {
                console.log(' ⚠️  Evento já está cancelado');
                return res.status(400).json({
                    success: false,
                    error: "Este evento já foi cancelado."
                });
            }

            console.log(' ✅ Permissão concedida - usuário pode cancelar o evento');

            // ✅ PREPARAR TRANSAÇÃO
            console.log(' -> Preparando transação para cancelar evento...');
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

            const tx = await program.methods
                .cancelEvent()
                .accounts({
                    event: eventPubkey,
                    controller: userPublicKey,
                })
                .transaction();

            // ✅ CONFIGURAR TRANSAÇÃO
            tx.recentBlockhash = blockhash;
            tx.feePayer = payerKeypair.publicKey;

            console.log(' -> Assinando transação...');

            // ✅ ASSINAR TRANSAÇÃO
            tx.sign(userKeypair, payerKeypair);

            console.log(' -> Enviando transação para a blockchain...');

            const serializedTx = tx.serialize();
            const signature = await connection.sendRawTransaction(serializedTx, {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
                maxRetries: 3
            });

            console.log(` -> Transação enviada: ${signature}`);
            console.log(' -> Aguardando confirmação...');

            // ✅ AGUARDAR CONFIRMAÇÃO
            const confirmation = await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight,
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`Transação falhou: ${JSON.stringify(confirmation.value.err)}`);
            }

            console.log(`[✔] Evento cancelado com sucesso! Assinatura: ${signature}`);

            res.status(200).json({
                success: true,
                signature,
                message: "Evento cancelado com sucesso via API!"
            });

        } catch (derivationError) {
            console.error('❌ Erro ao derivar keypair:', derivationError);
            return res.status(400).json({
                success: false,
                error: "Falha na autenticação. Verifique suas credenciais.",
                details: derivationError.message
            });
        }

    } catch (error) {
        console.error("❌ Erro no processo de cancelar evento:", error);

        if (error.logs) {
            console.error('Logs da transação:', error.logs);
        }

        res.status(500).json({
            success: false,
            error: error.message || 'Erro interno ao cancelar evento.',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

export const removeValidatorGasless = async (req, res) => {
    console.log('[+] Recebida requisição para remover validador (gasless)...');

    try {
        const { eventAddress, validatorAddress, userLoginData } = req.body;

        if (!eventAddress || !validatorAddress || !userLoginData) {
            return res.status(400).json({
                success: false,
                error: "Endereço do evento, validador e dados de login são obrigatórios."
            });
        }

        console.log(` -> Evento: ${eventAddress}`);
        console.log(` -> Validador a remover: ${validatorAddress}`);

        // ✅ Derivar keypair do usuário
        const parsedUserLoginData = JSON.parse(userLoginData);
        const userKeypair = await deriveUserKeypair(parsedUserLoginData);
        const userPublicKey = userKeypair.publicKey;

        console.log(` -> Usuário autenticado: ${userPublicKey.toString()}`);

        // ✅ Buscar dados do evento para verificar permissões
        const eventPubkey = new PublicKey(eventAddress);
        let eventAccount;
        try {
            eventAccount = await program.account.event.fetch(eventPubkey);
            console.log(' ✅ Conta do evento encontrada');
        } catch (error) {
            console.error(' ❌ Erro ao buscar evento:', error);
            return res.status(404).json({
                success: false,
                error: "Evento não encontrado na blockchain."
            });
        }

        // ✅ Verificar se o usuário é o controller do evento
        if (!eventAccount.controller.equals(userPublicKey)) {
            console.log(` ❌ Permissão negada: ${eventAccount.controller.toString()} vs ${userPublicKey.toString()}`);
            return res.status(403).json({
                success: false,
                error: "Você não é o criador deste evento. Apenas o criador pode remover validadores."
            });
        }
        console.log(' ✅ Permissão concedida');

        // ✅ Validar endereço do validador
        let validatorPubkey;
        try {
            validatorPubkey = new PublicKey(validatorAddress);
            console.log(` ✅ Endereço do validador válido: ${validatorPubkey.toString()}`);
        } catch (error) {
            console.error(' ❌ Endereço do validador inválido:', error);
            return res.status(400).json({
                success: false,
                error: "Endereço do validador inválido."
            });
        }

        // ✅ Verificar se o validador existe na lista
        const existingValidators = eventAccount.validators || [];
        const validatorExists = existingValidators.some(v => v.equals(validatorPubkey));

        if (!validatorExists) {
            console.log(' ⚠️  Validador não encontrado na lista');
            return res.status(400).json({
                success: false,
                error: "Este validador não está na lista de validadores do evento."
            });
        }

        console.log(' -> Preparando transação para remover validador...');

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        // ✅ Construir transação
        const tx = await program.methods
            .removeValidator(validatorPubkey)
            .accounts({
                event: eventPubkey,
                controller: userPublicKey,
            })
            .transaction();

        // ✅ Configurar transação
        tx.recentBlockhash = blockhash;
        tx.feePayer = payerKeypair.publicKey;

        console.log(' -> Assinando transação...');

        // ✅ Assinar com userKeypair (derivado) e payer do sistema
        tx.sign(userKeypair, payerKeypair);

        console.log(' -> Enviando transação para a blockchain...');

        const serializedTx = tx.serialize();
        const signature = await connection.sendRawTransaction(serializedTx, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
        });

        console.log(` -> Transação enviada: ${signature}`);
        console.log(' -> Aguardando confirmação...');

        // ✅ Aguardar confirmação
        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log(`[✔] Validador removido com sucesso! Assinatura: ${signature}`);

        res.status(200).json({
            success: true,
            signature,
            validatorAddress: validatorPubkey.toString(),
            message: "Validador removido com sucesso via API!"
        });

    } catch (error) {
        console.error("❌ Erro no processo de remover validador:", error);

        if (error.logs) {
            console.error('Logs da transação:', error.logs);
        }

        res.status(500).json({
            success: false,
            error: error.message || 'Erro interno ao remover validador.',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};
export const getEventForManagement = async (req, res) => {
    const { eventAddress, userPublicKey } = req.params;

    console.log(`[+] Buscando evento para gestão (OTIMIZADO): ${eventAddress}`);
    const startTime = Date.now();

    try {
        if (!eventAddress || !userPublicKey) {
            return res.status(400).json({
                success: false,
                error: "Endereço do evento e chave pública do usuário são obrigatórios."
            });
        }

        // Validar e criar PublicKeys
        const eventPubkey = new PublicKey(eventAddress);
        const userPubkey = new PublicKey(userPublicKey);

        // ✅ BUSCAR CONTA DO EVENTO PRIMEIRO
        console.log(' -> Buscando conta do evento...');
        let eventAccount;
        try {
            eventAccount = await program.account.event.fetch(eventPubkey);
            console.log(' ✅ Conta do evento encontrada');
        } catch (error) {
            console.error(' ❌ Erro ao buscar conta do evento:', error);
            return res.status(404).json({
                success: false,
                error: "Evento não encontrado na blockchain."
            });
        }

        // ✅ VERIFICAR PERMISSÕES ANTES DE CONTINUAR
        const isController = eventAccount.controller.equals(userPubkey);
        if (!isController) {
            console.log(` ❌ Permissão negada: ${eventAccount.controller.toString()} vs ${userPubkey.toString()}`);
            return res.status(403).json({
                success: false,
                error: "Você não é o criador deste evento."
            });
        }
        console.log(' ✅ Permissão concedida - usuário é o controller');

        // ✅ BUSCAR DADOS EM PARALELO COM TRATAMENTO DE ERRO ROBUSTO
        console.log(' -> Buscando dados adicionais em paralelo...');
        const [reserveBalance, metadata] = await Promise.all([
            // ✅ BUSCAR SALDO DA RESERVA
            (async () => {
                try {
                    const [refundReservePda] = PublicKey.findProgramAddressSync(
                        [Buffer.from("refund_reserve"), eventPubkey.toBuffer()],
                        program.programId
                    );
                    const balance = await connection.getBalance(refundReservePda);
                    console.log(` ✅ Saldo da reserve: ${balance} lamports`);
                    return balance;
                } catch (error) {
                    console.warn(' ⚠️  Não foi possível obter saldo da reserve:', error.message);
                    return 0;
                }
            })(),
            
            // ✅ BUSCAR METADADOS COM FALLBACK ROBUSTO
            (async () => {
                try {
                    if (!eventAccount.metadataUri) {
                        console.warn(' ⚠️  metadataUri não disponível na conta do evento');
                        return getFallbackMetadata();
                    }

                    console.log(` -> Buscando metadados: ${eventAccount.metadataUri}`);
                    const metadata = await fetchMetadataOptimized(eventAccount.metadataUri);
                    
                    if (!metadata) {
                        console.warn(' ⚠️  fetchMetadataOptimized retornou undefined');
                        return getFallbackMetadata();
                    }

                    console.log(' ✅ Metadados carregados com sucesso');
                    return metadata;
                } catch (error) {
                    console.warn(' ⚠️  Erro ao carregar metadados:', error.message);
                    return getFallbackMetadata();
                }
            })()
        ]);

        // ✅ FUNÇÃO AUXILIAR PARA METADADOS FALLBACK
        function getFallbackMetadata() {
            return {
                name: "Evento Sem Nome",
                description: "Descrição não disponível",
                properties: {},
                organizer: {},
                additionalInfo: {}
            };
        }

        // ✅ FORMATAR DADOS COM VALIDAÇÃO
        const formatBN = (bnValue) => {
            if (!bnValue && bnValue !== 0) return 0;
            
            try {
                if (typeof bnValue === 'object' && bnValue.toNumber && typeof bnValue.toNumber === 'function') {
                    return bnValue.toNumber();
                }
                return Number(bnValue) || 0;
            } catch (error) {
                console.warn(' ❌ Erro ao formatar BN:', error.message);
                return 0;
            }
        };

        // ✅ PROCESSAR TIERS COM VALIDAÇÃO
        const formattedTiers = (eventAccount.tiers || []).map((tier, index) => {
            const name = tier.name || `Tier ${index + 1}`;
            const priceBrlCents = formatBN(tier.priceBrlCents);
            const maxTicketsSupply = formatBN(tier.maxTicketsSupply);
            const ticketsSold = formatBN(tier.ticketsSold);

            console.log(`   Tier ${index}: "${name}" - ${ticketsSold}/${maxTicketsSupply} - R$ ${(priceBrlCents / 100).toFixed(2)}`);

            return {
                name: name,
                priceBrlCents: priceBrlCents,
                priceBrl: (priceBrlCents / 100).toFixed(2),
                maxTicketsSupply: maxTicketsSupply,
                ticketsSold: ticketsSold,
                ticketsRemaining: maxTicketsSupply - ticketsSold,
                isSoldOut: maxTicketsSupply - ticketsSold <= 0
            };
        });

        // ✅ CALCULAR TOTAIS DE TICKETS
        const totalTicketsSold = formattedTiers.reduce((sum, tier) => sum + tier.ticketsSold, 0);
        const maxTotalSupply = formattedTiers.reduce((sum, tier) => sum + tier.maxTicketsSupply, 0);

        // ✅ PROCESSAR VALIDADORES
        const formattedValidators = (eventAccount.validators || []).map(validator => {
            try {
                return validator.toString ? validator.toString() : String(validator);
            } catch (error) {
                console.warn(' ❌ Erro ao formatar validador:', error);
                return 'Invalid Validator';
            }
        });

        // ✅ ESTRUTURA FINAL DOS DADOS
        const eventData = {
            publicKey: eventAddress,
            account: {
                eventId: formatBN(eventAccount.eventId),
                controller: eventAccount.controller.toString(),
                canceled: Boolean(eventAccount.canceled),
                state: formatBN(eventAccount.state) || 0,
                salesStartDate: formatBN(eventAccount.salesStartDate),
                salesEndDate: formatBN(eventAccount.salesEndDate),
                totalTicketsSold: totalTicketsSold,
                maxTotalSupply: maxTotalSupply,
                tiers: formattedTiers,
                maxTicketsPerWallet: formatBN(eventAccount.maxTicketsPerWallet) || 1,
                resaleAllowed: Boolean(eventAccount.resaleAllowed),
                transferFeeBps: formatBN(eventAccount.transferFeeBps) || 500,
                royaltyBps: formatBN(eventAccount.royaltyBps) || 0,
                metadataUri: eventAccount.metadataUri || '',
                refundReserve: eventAccount.refundReserve ? eventAccount.refundReserve.toString() : '',
                validators: formattedValidators
            },
            metadata: metadata,
            reserveBalance: reserveBalance,
            isController: true
        };

        const duration = Date.now() - startTime;
        
        // ✅ LOG SEGURO - NUNCA ACESSA PROPRIEDADES DE UNDEFINED
        const eventName = metadata?.name || 'Evento Sem Nome';
        console.log(`[✔] Evento preparado para gestão em ${duration}ms: ${eventName}`);
        console.log(` 📊 Estatísticas: ${totalTicketsSold}/${maxTotalSupply} ingressos, ${formattedTiers.length} tiers`);

        res.status(200).json({
            success: true,
            event: eventData,
            performance: {
                duration: duration,
                tiersCount: formattedTiers.length,
                validatorsCount: formattedValidators.length
            }
        });

    } catch (error) {
        console.error("❌ Erro ao buscar evento para gestão:", error);

        // ✅ DETECTAR TIPOS ESPECÍFICOS DE ERRO
        if (error.message?.includes('Account does not exist') || 
            error.message?.includes('could not find account')) {
            return res.status(404).json({
                success: false,
                error: "Evento não encontrado na blockchain."
            });
        }

        if (error.message?.includes('Invalid public key')) {
            return res.status(400).json({
                success: false,
                error: "Endereço do evento inválido."
            });
        }

        res.status(500).json({
            success: false,
            error: "Erro interno do servidor ao buscar dados do evento.",
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}; const metadataCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos


const fetchMetadataOptimizedSafe = async (uri) => {
    try {
        const metadata = await fetchMetadataOptimized(uri);
        
        if (!metadata) {
            console.warn(' ⚠️  fetchMetadataOptimized retornou undefined/null');
            return {
                name: "Evento Sem Nome",
                description: "Descrição não disponível",
                properties: {},
                organizer: {},
                additionalInfo: {}
            };
        }
        
        return metadata;
    } catch (error) {
        console.warn(' ⚠️  fetchMetadataOptimizedSafe - Erro:', error.message);
        return {
            name: "Evento Sem Nome",
            description: "Descrição não disponível",
            properties: {},
            organizer: {},
            additionalInfo: {}
        };
    }
};

// Buscar múltiplos metadados em paralelo com limite de concorrência
const fetchMultipleMetadata = async (events, concurrencyLimit = 5) => {
    const results = [];

    // Processar em lotes para não sobrecarregar
    for (let i = 0; i < events.length; i += concurrencyLimit) {
        const batch = events.slice(i, i + concurrencyLimit);
        const batchPromises = batch.map(async (event, index) => {
            try {
                const metadata = await fetchMetadataOptimized(event.account.metadataUri);
                return {
                    publicKey: event.publicKey.toString(),
                    account: event.account,
                    metadata: metadata || {
                        name: "Evento - Metadados Indisponíveis",
                        description: "Não foi possível carregar informações detalhadas"
                    },
                };
            } catch (error) {
                console.warn(` -> Erro nos metadados do evento ${event.publicKey.toString()}: ${error.message}`);
                return {
                    publicKey: event.publicKey.toString(),
                    account: event.account,
                    metadata: {
                        name: "Evento - Metadados Indisponíveis",
                        description: "Erro ao carregar informações detalhadas"
                    },
                };
            }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Pequena pausa entre lotes para não sobrecarregar
        if (i + concurrencyLimit < events.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    return results;
};
    export const getActiveEvents = async (req, res) => {
        console.log('[+] Fetching active events (OTIMIZADO)...');
        const startTime = Date.now();

        try {
            // Buscar eventos on-chain (mantém igual)
            const allEvents = await program.account.event.all();
            console.log(` -> Found ${allEvents.length} total events on-chain (${Date.now() - startTime}ms)`);

            const nowInSeconds = Math.floor(Date.now() / 1000);

            // Filtrar eventos ativos
            const fullyActiveEvents = allEvents.filter(event => {
                const acc = event.account;
                const isStateActive = acc.state === 1;
                const isNotCanceled = !acc.canceled;
                const isInSalesPeriod = nowInSeconds >= acc.salesStartDate.toNumber() &&
                    nowInSeconds <= acc.salesEndDate.toNumber();

                return isStateActive && isNotCanceled && isInSalesPeriod;
            });

            console.log(` -> Found ${fullyActiveEvents.length} active events (${Date.now() - startTime}ms)`);

            // Buscar metadados em paralelo com concorrência controlada
            console.log(' -> Fetching metadata in parallel...');
            const eventsWithMetadata = await fetchMultipleMetadata(fullyActiveEvents, 6);

            // Ordenar por data de início
            const validEvents = eventsWithMetadata
                .sort((a, b) => a.account.salesStartDate.toNumber() - b.account.salesStartDate.toNumber());

            const totalTime = Date.now() - startTime;
            console.log(`[✔] Successfully processed ${validEvents.length} active events in ${totalTime}ms`);

            res.status(200).json(validEvents);

        } catch (error) {
            console.error("[✘] Error fetching active events:", error);
            res.status(500).json({
                error: "Server error fetching events.",
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    };

export const getEventDetails = async (req, res) => {
    const { eventAddress } = req.params;
    if (!eventAddress) {
        return res.status(400).json({ success: false, error: 'O endereço do evento é obrigatório.' });
    }

    console.log(`\n🎯 [DETALHES EVENTO] Iniciando busca: ${eventAddress}`);
    const startTime = Date.now();

    try {
        const eventPubkey = new PublicKey(eventAddress);

        // ✅ PRIMEIRO: Buscar dados on-chain
        console.log('📡 Buscando dados on-chain da blockchain...');
        const account = await program.account.event.fetch(eventPubkey);
        
        console.log('✅ DADOS ON-CHAIN CARREGADOS:');
        console.log('   - Event ID:', account.event_id?.toString());
        console.log('   - Controller:', account.controller?.toString());
        console.log('   - Canceled:', account.canceled);
        console.log('   - State:', account.state);
        console.log('   - Total Tickets Sold:', account.total_tickets_sold?.toString());
        console.log('   - Sales Start:', new Date(account.sales_start_date * 1000).toISOString());
        console.log('   - Sales End:', new Date(account.sales_end_date * 1000).toISOString());
        console.log('   - Tiers Count:', account.tiers?.length);

        // ✅ LOG DETALHADO DOS TIERS
        console.log('🎫 DETALHES DOS TIERS:');
        if (account.tiers && account.tiers.length > 0) {
            account.tiers.forEach((tier, index) => {
                console.log(`   Tier ${index}:`);
                console.log(`     - Nome: "${tier.name}"`);
                console.log(`     - Preço: ${tier.price_brl_cents} centavos`);
                console.log(`     - Max Supply: ${tier.max_tickets_supply}`);
                console.log(`     - Sold: ${tier.tickets_sold}`);
                console.log(`     - Disponível: ${tier.max_tickets_supply - tier.tickets_sold}`);
            });
        } else {
            console.log('   ⚠️  Nenhum tier encontrado');
        }

        // ✅ SEGUNDO: Buscar metadados off-chain
        let metadata = {};
        if (account.metadata_uri) {
            try {
                console.log('🌐 Buscando metadados off-chain...');
                console.log('   - Metadata URI:', account.metadata_uri);
                metadata = await fetchMetadataOptimized(account.metadata_uri);
                console.log('✅ Metadados carregados:', {
                    name: metadata.name,
                    hasImage: !!metadata.image,
                    hasProperties: !!metadata.properties
                });
            } catch (error) {
                console.warn('❌ Falha nos metadados:', error.message);
                metadata = {
                    name: "Evento Sem Nome",
                    description: "Descrição não disponível",
                    image: "",
                    properties: {}
                };
            }
        } else {
            console.warn('⚠️  Nenhum metadata_uri encontrado na account');
        }

        // ✅ TERCEIRO: Processar tiers para calcular totais
        console.log('🧮 Calculando estatísticas de ingressos...');
        let totalSupply = 0;
        let totalSoldFromTiers = 0;
        
        const processedTiers = account.tiers.map((tier, index) => {
            const maxSupply = tier.max_tickets_supply || 0;
            const sold = tier.tickets_sold || 0;
            
            totalSupply += maxSupply;
            totalSoldFromTiers += sold;

            return {
                name: tier.name || `Tier ${index + 1}`,
                priceBrlCents: tier.price_brl_cents || 0,
                maxTicketsSupply: maxSupply,
                ticketsSold: sold,
                ticketsRemaining: maxSupply - sold,
                isSoldOut: sold >= maxSupply
            };
        });

        // ✅ QUARTO: Validar consistência dos dados
        const totalSoldFromAccount = account.total_tickets_sold || 0;
        
        // Prioridade: usar total da account, fallback para soma dos tiers
        const totalSold = totalSoldFromAccount > 0 ? totalSoldFromAccount : totalSoldFromTiers;

        console.log('📊 RESUMO FINAL:');
        console.log('   - Total Supply (soma tiers):', totalSupply);
        console.log('   - Total Sold (account):', totalSoldFromAccount);
        console.log('   - Total Sold (soma tiers):', totalSoldFromTiers);
        console.log('   - Total Sold (final):', totalSold);
        console.log('   - Progresso:', totalSupply > 0 ? ((totalSold / totalSupply) * 100).toFixed(2) + '%' : '0%');
        console.log('   - Tiers processados:', processedTiers.length);

        const duration = Date.now() - startTime;
        console.log(`✅ [DETALHES EVENTO] Concluído em ${duration}ms\n`);

        // ✅ ESTRUTURA DA RESPOSTA
        const responseData = {
            success: true,
            event: {
                publicKey: eventAddress,
                account: {
                    // Dados on-chain originais
                    eventId: account.event_id,
                    controller: account.controller.toString(),
                    canceled: account.canceled,
                    state: account.state,
                    salesStartDate: account.sales_start_date,
                    salesEndDate: account.sales_end_date,
                    totalTicketsSold: totalSold, // ✅ VALOR CORRETO
                    tiers: processedTiers, // ✅ TIERS PROCESSADOS
                    maxTicketsPerWallet: account.max_tickets_per_wallet,
                    resaleAllowed: account.resale_allowed,
                    transferFeeBps: account.transfer_fee_bps,
                    royaltyBps: account.royalty_bps,
                    metadataUri: account.metadata_uri,
                    refundReserve: account.refund_reserve.toString(),
                    validators: account.validators.map(v => v.toString()),
                    
                    // Dados calculados
                    maxTotalSupply: totalSupply,
                },
                metadata: metadata,
                stats: {
                    totalSupply,
                    totalSold,
                    progress: totalSupply > 0 ? (totalSold / totalSupply) * 100 : 0,
                    tiersCount: processedTiers.length,
                    soldOutTiers: processedTiers.filter(t => t.isSoldOut).length
                }
            },
        };

        console.log('📤 Enviando resposta para frontend...');
        res.status(200).json(responseData);

    } catch (error) {
        console.error("\n❌ [DETALHES EVENTO] Erro crítico:", error);

        if (error.message.includes('Account does not exist') ||
            error.message.includes('could not find account')) {
            console.log('⚠️  Evento não encontrado na blockchain');
            return res.status(404).json({
                success: false,
                error: 'Evento não encontrado na blockchain.'
            });
        }

        if (error.message.includes('Invalid public key')) {
            console.log('⚠️  Public key inválida');
            return res.status(400).json({
                success: false,
                error: 'O endereço do evento fornecido é inválido.'
            });
        }

        console.error('💥 Erro interno do servidor:', error.message);
        res.status(500).json({
            success: false,
            error: 'Ocorreu um erro no servidor ao buscar os dados do evento.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};
setInterval(() => {
    const now = Date.now();
    let clearedCount = 0;

    for (const [key, value] of metadataCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            metadataCache.delete(key);
            clearedCount++;
        }
    }

    if (clearedCount > 0) {
        console.log(`[🧹] Cache limpo: ${clearedCount} entradas removidas`);
    }
}, 10 * 60 * 1000);
