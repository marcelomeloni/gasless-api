import { program, payerKeypair, SystemProgram, PublicKey, connection } from '../services/solanaService.js';
import { uploadToPinata, uploadJSONToPinata } from '../services/pinataService.js';
import anchor from '@coral-xyz/anchor';
import { createClient } from '@supabase/supabase-js';
import { saveCompleteEventToSupabase, getActiveEventsFromSupabase, getEventsByCreator, getEventFromSupabase, supabase  } from '../services/supabaseService.js';
import axios from 'axios';
import { Transaction } from '@solana/web3.js';
import FormData from 'form-data';
import { deriveUserKeypair } from '../services/walletDerivationService.js';

export const getNextFourEvents = async (req, res) => {
    console.log('[⚡] API ULTRA-RÁPIDA: Buscando 4 próximos eventos do Supabase...');
    const startTime = Date.now();
    
    try {
        const nowInSeconds = Math.floor(Date.now() / 1000);
        
        // Buscar apenas 4 eventos mais próximos do Supabase
        const { data, error } = await supabase
            .from('events')
            .select('*')
            .gte('sales_end_date', nowInSeconds) // Eventos que ainda não terminaram
            .order('sales_start_date', { ascending: true })
            .limit(4);

        if (error) {
            console.error(' ❌ Erro ao buscar próximos eventos:', error);
            throw error;
        }

        // Formatar resposta
        const formattedEvents = (data || []).map(event => ({
            publicKey: event.event_address,
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
            metadata: event.metadata, // ✅ TODOS os dados já aqui
            imageUrl: event.image_url
        }));

        const duration = Date.now() - startTime;
        console.log(`[⚡] API ULTRA-RÁPIDA: ${formattedEvents.length} eventos retornados em ${duration}ms`);
        
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
    console.log('[⚡] API RÁPIDA: Buscando eventos ativos do Supabase...');
    const startTime = Date.now();

    try {
        const events = await getActiveEventsFromSupabase();

        // Formatar resposta (já tem todos os dados no metadata)
        const formattedEvents = events.map(event => ({
            publicKey: event.event_address,
            account: {
                eventId: event.event_id,
                controller: event.controller,
                salesStartDate: { toNumber: () => event.sales_start_date },
                salesEndDate: { toNumber: () => event.sales_end_date },
                maxTicketsPerWallet: event.max_tickets_per_wallet,
                royaltyBps: event.royalty_bps,
                metadataUri: event.metadata_url, // Ainda mantemos por compatibilidade
                tiers: event.tiers || []
            },
            metadata: event.metadata, // ✅ JÁ TEM TODOS OS DADOS: nome, descrição, imagem, etc
            imageUrl: event.image_url
        }));

        const duration = Date.now() - startTime;
        console.log(`[⚡] API RÁPIDA: ${formattedEvents.length} eventos retornados em ${duration}ms`);

        res.status(200).json(formattedEvents);

    } catch (error) {
        console.error("[❌] Erro na API rápida de eventos:", error);
        res.status(500).json({
            error: "Erro ao buscar eventos",
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

export const getEventDetailsFast = async (req, res) => {
    const { eventAddress } = req.params;
    
    if (!eventAddress) {
      return res.status(400).json({ 
        success: false, 
        error: 'O endereço do evento é obrigatório.' 
      });
    }
  
    console.log(`[🔍] BUSCA DIRETA NA BLOCKCHAIN: ${eventAddress}`);
    const startTime = Date.now();
  
    try {
      const eventPubkey = new PublicKey(eventAddress);
      
      // ✅ BUSCA DIRETA NA BLOCKCHAIN - SEM CACHE
      console.log(' -> Buscando dados diretamente da blockchain...');
      let blockchainAccount;
      try {
        blockchainAccount = await program.account.event.fetch(eventPubkey);
        console.log(' ✅ Dados brutos da blockchain recebidos');
        
        // ✅ DEBUG: Log da estrutura completa
        console.log('🔍 ESTRUTURA DO EVENTO NA BLOCKCHAIN:');
        console.log('- eventId:', blockchainAccount.eventId?.toString());
        console.log('- controller:', blockchainAccount.controller?.toString());
        console.log('- totalTicketsSold:', blockchainAccount.totalTicketsSold?.toString());
        console.log('- tiers count:', blockchainAccount.tiers?.length || 0);
        
        if (blockchainAccount.tiers && blockchainAccount.tiers.length > 0) {
          blockchainAccount.tiers.forEach((tier, index) => {
            console.log(`🎫 Tier ${index}:`);
            console.log('   - name:', tier.name);
            console.log('   - priceBrlCents:', tier.priceBrlCents?.toString());
            console.log('   - maxTicketsSupply:', tier.maxTicketsSupply?.toString());
            console.log('   - ticketsSold:', tier.ticketsSold?.toString());
          });
        }
      } catch (error) {
        console.error(' ❌ Erro ao buscar evento na blockchain:', error);
        return res.status(404).json({
          success: false,
          error: "Evento não encontrado na blockchain."
        });
      }
  
      // ✅ Buscar metadados do Supabase apenas para display
      let finalMetadata = {};
      let finalImageUrl = '';
  
      try {
        const supabaseEvent = await getEventFromSupabase(eventAddress);
        finalMetadata = supabaseEvent.metadata || {};
        finalImageUrl = supabaseEvent.image_url || '';
        console.log(' ✅ Metadados do Supabase carregados (apenas para display)');
      } catch (error) {
        console.warn(' ⚠️  Supabase não disponível, usando metadados fallback');
        finalMetadata = {
          name: "Evento Sem Nome",
          description: "Descrição não disponível",
          properties: {}
        };
      }
  
      // ✅ CORREÇÃO CRÍTICA: Processar tiers DIRETAMENTE da blockchain
      const formattedTiers = (blockchainAccount.tiers || []).map((tier, index) => {
        // ✅ EXTRAÇÃO DIRETA DOS VALORES - SEM ASSUNÇÕES
        let priceBrlCents = 0;
        let maxTicketsSupply = 0;
        let ticketsSold = 0;
  
        // Tentar diferentes formas de extrair os valores
        try {
          // Método 1: Se for BN object
          if (tier.priceBrlCents && typeof tier.priceBrlCents.toNumber === 'function') {
            priceBrlCents = tier.priceBrlCents.toNumber();
          } else if (tier.priceBrlCents !== undefined && tier.priceBrlCents !== null) {
            // Método 2: Se já for número
            priceBrlCents = Number(tier.priceBrlCents);
          }
  
          if (tier.maxTicketsSupply && typeof tier.maxTicketsSupply.toNumber === 'function') {
            maxTicketsSupply = tier.maxTicketsSupply.toNumber();
          } else if (tier.maxTicketsSupply !== undefined && tier.maxTicketsSupply !== null) {
            maxTicketsSupply = Number(tier.maxTicketsSupply);
          }
  
          if (tier.ticketsSold && typeof tier.ticketsSold.toNumber === 'function') {
            ticketsSold = tier.ticketsSold.toNumber();
          } else if (tier.ticketsSold !== undefined && tier.ticketsSold !== null) {
            ticketsSold = Number(tier.ticketsSold);
          }
        } catch (error) {
          console.warn(` ❌ Erro ao processar tier ${index}:`, error.message);
        }
  
        const ticketsRemaining = maxTicketsSupply - ticketsSold;
        
        console.log(`🎫 Tier ${index} processado:`, {
          name: tier.name,
          priceBrlCents,
          maxTicketsSupply,
          ticketsSold,
          ticketsRemaining
        });
  
        return {
          name: tier.name || `Tier ${index + 1}`,
          priceBrlCents: priceBrlCents,
          maxTicketsSupply: maxTicketsSupply,
          ticketsSold: ticketsSold,
          ticketsRemaining: ticketsRemaining,
          isSoldOut: ticketsSold >= maxTicketsSupply
        };
      });
  
      // ✅ Calcular totais baseados nos tiers processados
      const totalTicketsSold = formattedTiers.reduce((sum, tier) => sum + tier.ticketsSold, 0);
      const maxTotalSupply = formattedTiers.reduce((sum, tier) => sum + tier.maxTicketsSupply, 0);
  
      // ✅ ESTRUTURA FINAL DO EVENTO
      const eventData = {
        publicKey: eventAddress,
        account: {
          // Dados básicos do evento
          eventId: blockchainAccount.eventId,
          controller: blockchainAccount.controller.toString(),
          salesStartDate: blockchainAccount.salesStartDate,
          salesEndDate: blockchainAccount.salesEndDate,
          maxTicketsPerWallet: blockchainAccount.maxTicketsPerWallet?.toNumber?.() || 1,
          royaltyBps: blockchainAccount.royaltyBps?.toNumber?.() || 0,
          metadataUri: blockchainAccount.metadataUri,
          
          // ✅ TIERS PROCESSADOS DA BLOCKCHAIN
          tiers: formattedTiers,
          
          // Dados dinâmicos
          totalTicketsSold: totalTicketsSold,
          maxTotalSupply: maxTotalSupply,
          revenue: blockchainAccount.revenue?.toNumber?.() || 0,
          isActive: blockchainAccount.isActive,
          canceled: blockchainAccount.canceled,
          validators: (blockchainAccount.validators || []).map(v => v.toString()),
          state: blockchainAccount.state
        },
        metadata: finalMetadata,
        imageUrl: finalImageUrl,
      };
  
      const duration = Date.now() - startTime;
      console.log(`[✅] DETALHES CARREGADOS EM ${duration}ms`);
      console.log(` -> Tiers processados: ${formattedTiers.length}`);
      console.log(` -> Ingressos totais: ${totalTicketsSold}/${maxTotalSupply} vendidos`);
      
      // ✅ LOG FINAL PARA CONFIRMAÇÃO
      formattedTiers.forEach((tier, index) => {
        console.log(`   Tier "${tier.name}": ${tier.ticketsSold}/${tier.maxTicketsSupply} vendidos`);
      });
  
      res.status(200).json({
        success: true,
        event: eventData,
        dataSources: {
          blockchain: true,
          tiersSource: 'blockchain-diret',
          metadataSource: 'supabase'
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

        // Buscar dados em paralelo
        const [eventAccount, reserveBalance, metadata] = await Promise.all([
            program.account.event.fetch(eventPubkey),
            (async () => {
                try {
                    const [refundReservePda] = PublicKey.findProgramAddressSync(
                        [Buffer.from("refund_reserve"), eventPubkey.toBuffer()],
                        program.programId
                    );
                    return await connection.getBalance(refundReservePda);
                } catch (error) {
                    console.warn(' ⚠️  Não foi possível obter saldo da reserve:', error.message);
                    return 0;
                }
            })(),
            (async () => {
                try {
                    const eventAccount = await program.account.event.fetch(eventPubkey);
                    return await fetchMetadataOptimized(eventAccount.metadataUri);
                } catch (error) {
                    console.warn(' ⚠️  Não foi possível carregar metadados:', error.message);
                    return {
                        name: "Evento Sem Nome",
                        description: "Descrição não disponível",
                        properties: {}
                    };
                }
            })()
        ]);

        // Verificar permissões
        const isController = eventAccount.controller.equals(userPubkey);
        if (!isController) {
            return res.status(403).json({
                success: false,
                error: "Você não é o criador deste evento."
            });
        }

        // Formatar dados (código mantido igual)
        const formatBN = (bnValue) => {
            if (!bnValue) return 0;
            return typeof bnValue === 'object' && bnValue.toNumber ? bnValue.toNumber() : bnValue;
        };

        const formattedTiers = (eventAccount.tiers || []).map(tier => ({
            name: tier.name || 'Sem nome',
            priceBrlCents: formatBN(tier.priceBrlCents),
            maxTicketsSupply: formatBN(tier.maxTicketsSupply),
            ticketsSold: formatBN(tier.ticketsSold) || 0
        }));

        const formattedValidators = (eventAccount.validators || []).map(validator =>
            validator.toString ? validator.toString() : String(validator)
        );

        const eventData = {
            publicKey: eventAddress,
            account: {
                eventId: formatBN(eventAccount.eventId),
                controller: eventAccount.controller.toString(),
                canceled: Boolean(eventAccount.canceled),
                state: formatBN(eventAccount.state) || 0,
                salesStartDate: formatBN(eventAccount.salesStartDate),
                salesEndDate: formatBN(eventAccount.salesEndDate),
                totalTicketsSold: formatBN(eventAccount.totalTicketsSold) || 0,
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

        console.log(`[✔] Evento preparado para gestão em ${Date.now() - startTime}ms: ${metadata.name}`);

        res.status(200).json({
            success: true,
            event: eventData
        });

    } catch (error) {
        console.error("❌ Erro ao buscar evento para gestão:", error);

        if (error.message?.includes('Account does not exist')) {
            return res.status(404).json({
                success: false,
                error: "Evento não encontrado na blockchain."
            });
        }

        res.status(500).json({
            success: false,
            error: "Erro interno do servidor.",
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}; const metadataCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Função auxiliar para fetch com timeout e retry
const fetchWithTimeoutAndRetry = async (url, timeout = 5000, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; EventApp/1.0)'
                }
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            if (i === retries) throw error;
            // Espera um pouco antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
};

// Função otimizada para buscar metadados
const fetchMetadataOptimized = async (uri) => {
    if (!uri) return null;

    // Verificar cache primeiro
    const cached = metadataCache.get(uri);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        console.log(` -> Cache hit para: ${uri}`);
        return cached.data;
    }

    const gateways = [
        // Gateways públicos rápidos primeiro
        uri.replace('https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/'),
        uri.replace('https://gateway.pinata.cloud/ipfs/', 'https://cloudflare-ipfs.com/ipfs/'),
        uri.replace('https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'),
        uri.replace('https://gateway.pinata.cloud/ipfs/', 'https://gateway.ipfs.io/ipfs/'),
        // Gateway original por último
        uri
    ];

    // Tentar todos os gateways em paralelo e pegar o primeiro que responder
    const promises = gateways.map(async (gateway) => {
        try {
            const metadata = await fetchWithTimeoutAndRetry(gateway, 3000, 1);
            console.log(` -> Sucesso via: ${new URL(gateway).hostname}`);

            // Armazenar no cache
            metadataCache.set(uri, {
                data: metadata,
                timestamp: Date.now()
            });

            return metadata;
        } catch (error) {
            return null;
        }
    });

    // Esperar pelo primeiro sucesso
    const results = await Promise.allSettled(promises);
    const successfulResult = results.find(result =>
        result.status === 'fulfilled' && result.value !== null
    );

    if (successfulResult) {
        return successfulResult.value;
    }

    throw new Error(`Todos os gateways falharam para: ${uri}`);
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

    console.log(`[+] Buscando detalhes para o evento: ${eventAddress}`);
    const startTime = Date.now();

    try {
        const eventPubkey = new PublicKey(eventAddress);

        // Buscar dados on-chain e metadados em paralelo
        const [account, metadata] = await Promise.all([
            program.account.event.fetch(eventPubkey),
            (async () => {
                try {
                    // Buscar metadados primeiro para não esperar desnecessariamente
                    return await fetchMetadataOptimized(account.metadataUri);
                } catch (error) {
                    console.warn(' -> Falha nos metadados, usando padrão:', error.message);
                    return {
                        name: "Evento Sem Nome",
                        description: "Descrição não disponível",
                        image: "",
                        properties: {}
                    };
                }
            })()
        ]);

        console.log(` -> Dados carregados em ${Date.now() - startTime}ms`);

        res.status(200).json({
            success: true,
            event: {
                account: account,
                metadata: metadata,
            },
        });

    } catch (error) {
        console.error("[✘] Erro ao buscar detalhes do evento:", error);

        if (error.message.includes('Account does not exist') ||
            error.message.includes('could not find account')) {
            return res.status(404).json({
                success: false,
                error: 'Evento não encontrado na blockchain.'
            });
        }

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
