import { program, payerKeypair, SystemProgram, PublicKey, connection } from '../services/solanaService.js';
import { uploadToPinata, uploadJSONToPinata } from '../services/pinataService.js';
import anchor from '@coral-xyz/anchor';
import axios from 'axios';
import FormData from 'form-data';
import { deriveUserKeypair } from '../services/walletDerivationService.js';
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

        // Uploads (mesmo código anterior)
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

        console.log(' -> Enviando transação gasless...');
        
        // Usar .rpc() para assinatura automática pelo payer do sistema
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
export const createFullEvent = async (req, res) => {
    console.log('[+] Recebida requisição para criar evento completo.');

    try {
        const { offChainData, onChainData, controller, userLoginData } = req.body;
        
        if (!offChainData || !onChainData || !controller || !userLoginData) {
            return res.status(400).json({ 
                success: false, 
                error: "Dados do formulário, controlador ou credenciais de login ausentes." 
            });
        }
        
        const parsedOffChainData = JSON.parse(offChainData);
        const parsedOnChainData = JSON.parse(onChainData);
        const parsedUserLoginData = JSON.parse(userLoginData);
        const controllerPubkey = new PublicKey(controller);
        const files = req.files;

        console.log(' -> Derivando keypair do usuário no backend...');
        
        // Derivar a keypair do usuário no backend usando os mesmos dados de login
        const userKeypair = await deriveUserKeypair(parsedUserLoginData);
        
        // Verificar se o publicKey derivado bate com o controller
        const derivedPublicKey = userKeypair.publicKey.toString();
        const requestedPublicKey = controllerPubkey.toString();
        
        if (derivedPublicKey !== requestedPublicKey) {
            console.error(` ❌ Public key mismatch: ${derivedPublicKey} vs ${requestedPublicKey}`);
            return res.status(400).json({
                success: false,
                error: "A chave pública derivada não corresponde ao controlador fornecido."
            });
        }

        console.log(` ✅ Keypair do usuário derivado: ${derivedPublicKey}`);

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
            createdBy: derivedPublicKey // Usar a chave derivada
        };
        
        console.log(' -> Fazendo upload do JSON de metadados...');
        const metadataUrl = await uploadJSONToPinata(finalMetadata);
        console.log(` -> Metadados enviados: ${metadataUrl}`);

        console.log(' -> Preparando transação on-chain...');
        const eventId = new anchor.BN(Date.now());
        
        // Encontrar PDAs - IMPORTANTE: usar a chave do usuário como authority
        const [whitelistPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("whitelist"), userKeypair.publicKey.toBuffer()], 
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
                controller: userKeypair.publicKey, // ← Authority é o usuário!
                payer: payerKeypair.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .transaction();

        // Configurar transação
        tx.recentBlockhash = blockhash;
        tx.feePayer = payerKeypair.publicKey;

        console.log(' -> Assinando transação com o USUÁRIO (authority) e PAYER (taxas)...');
        
        // **ASSINAR COM AMBAS: usuário (authority do evento) e payer (para taxas)**
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

        // Aguardar confirmação
        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log(`[✔] Evento criado com sucesso! Assinatura: ${signature}`);
        console.log(`[🎉] Authority do evento: ${userKeypair.publicKey.toString()}`);
        console.log(`[🎉] Evento criado em: ${eventPda.toString()}`);

        res.status(200).json({ 
            success: true, 
            signature, 
            eventAddress: eventPda.toString(),
            eventId: eventId.toString(),
            metadataUrl: metadataUrl,
            authority: userKeypair.publicKey.toString(), // ← Authority REAL é o usuário!
            message: "Evento criado automaticamente com sucesso!" 
        });

    } catch (error) {
        console.error("❌ Erro no processo de criação completo do evento:", error);
        
        if (error.logs) {
            console.error('Logs da transação:', error.logs);
        }
        
        // Log mais detalhado
        console.error('Stack trace:', error.stack);
        
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Ocorreu um erro interno no servidor.',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};
// controllers/eventController.js - FUNÇÃO ATUALIZADA

export const getEventForManagement = async (req, res) => {
    const { eventAddress, userPublicKey } = req.params;
    
    console.log(`[+] Buscando evento para gestão: ${eventAddress}`);
    console.log(`[+] Usuário solicitante: ${userPublicKey}`);

    try {
        if (!eventAddress || !userPublicKey) {
            return res.status(400).json({ 
                success: false, 
                error: "Endereço do evento e chave pública do usuário são obrigatórios." 
            });
        }

        // Validar e criar PublicKeys
        let eventPubkey, userPubkey;
        try {
            eventPubkey = new PublicKey(eventAddress);
            userPubkey = new PublicKey(userPublicKey);
        } catch (error) {
            console.error("❌ Erro ao criar PublicKey:", error);
            return res.status(400).json({ 
                success: false, 
                error: "Endereço de evento ou usuário inválido." 
            });
        }

        // Buscar dados do evento
        console.log(' -> Buscando conta do evento on-chain...');
        let eventAccount;
        try {
            eventAccount = await program.account.event.fetch(eventPubkey);
            console.log(' ✅ Conta do evento encontrada');
        } catch (error) {
            console.error(' ❌ Erro ao buscar conta do evento:', error.message);
            
            if (error.message.includes('Account does not exist') || 
                error.message.includes('could not find account')) {
                return res.status(404).json({ 
                    success: false, 
                    error: "Evento não encontrado na blockchain." 
                });
            }
            throw error;
        }

        // Verificar se o usuário é o controller do evento
        console.log(' -> Verificando permissões...');
        const isController = eventAccount.controller.equals(userPubkey);
        
        if (!isController) {
            console.log(` ❌ Permissão negada: ${eventAccount.controller.toString()} vs ${userPubkey.toString()}`);
            return res.status(403).json({ 
                success: false, 
                error: "Você não é o criador deste evento. Apenas o criador pode gerenciá-lo." 
            });
        }
        console.log(' ✅ Permissão concedida');

        // Buscar metadados off-chain
        console.log(' -> Buscando metadados off-chain...');
        let metadata = { 
            name: "Evento Sem Nome",
            description: "Descrição não disponível",
            properties: {}
        };
        
        try {
            if (eventAccount.metadataUri && eventAccount.metadataUri !== '') {
                console.log(` -> Fetching metadata from: ${eventAccount.metadataUri}`);
                const response = await fetch(eventAccount.metadataUri);
                if (response.ok) {
                    const fetchedMetadata = await response.json();
                    metadata = { ...metadata, ...fetchedMetadata };
                    console.log(' ✅ Metadados carregados com sucesso');
                } else {
                    console.warn(' ⚠️  Falha ao buscar metadados, status:', response.status);
                }
            } else {
                console.warn(' ⚠️  MetadataUri vazio ou não definido');
            }
        } catch (metadataError) {
            console.warn(' ⚠️  Não foi possível carregar metadados:', metadataError.message);
        }

        // Calcular saldo da reserve account
        console.log(' -> Calculando saldo da reserve account...');
        let reserveBalance = 0;
        try {
            const [refundReservePda] = PublicKey.findProgramAddressSync(
                [Buffer.from("refund_reserve"), eventPubkey.toBuffer()],
                program.programId
            );
            
            reserveBalance = await connection.getBalance(refundReservePda);
            console.log(` ✅ Saldo da reserve: ${reserveBalance} lamports`);
        } catch (balanceError) {
            console.warn(' ⚠️  Não foi possível obter saldo da reserve:', balanceError.message);
        }

        // Converter dados BN para números para o frontend
        const formatBN = (bnValue) => {
            if (!bnValue) return 0;
            return typeof bnValue === 'object' && bnValue.toNumber ? bnValue.toNumber() : bnValue;
        };

        // Formatar tiers
        const formattedTiers = (eventAccount.tiers || []).map(tier => ({
            name: tier.name || 'Sem nome',
            priceBrlCents: formatBN(tier.priceBrlCents),
            maxTicketsSupply: formatBN(tier.maxTicketsSupply),
            ticketsSold: formatBN(tier.ticketsSold) || 0
        }));

        // Formatar validators
        const formattedValidators = (eventAccount.validators || []).map(validator => 
            validator.toString ? validator.toString() : String(validator)
        );

        // Formatar dados para o frontend
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

        console.log(`[✔] Evento preparado para gestão: ${metadata.name}`);
        console.log(`[✔] Tiers: ${formattedTiers.length}, Validadores: ${formattedValidators.length}`);

        res.status(200).json({
            success: true,
            event: eventData
        });

    } catch (error) {
        console.error("❌ Erro crítico ao buscar evento para gestão:", error);
        
        // Log detalhado para debugging
        console.error("Stack trace:", error.stack);
        console.error("Error name:", error.name);
        console.error("Error message:", error.message);

        if (error.message?.includes('Account does not exist') || 
            error.message?.includes('could not find account') ||
            error.message?.includes('Account not found')) {
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
};
export const getActiveEvents = async (req, res) => {
    console.log('[+] Fetching active events...');
    try {
        const allEvents = await program.account.event.all();
        console.log(` -> Found ${allEvents.length} total events on-chain`);
        
        const nowInSeconds = Math.floor(Date.now() / 1000);
        console.log(` -> Current timestamp: ${nowInSeconds}`);
        
        const fullyActiveEvents = allEvents.filter(event => {
            const acc = event.account;
            const isStateActive = acc.state === 1;
            const isNotCanceled = !acc.canceled;
            const isInSalesPeriod = nowInSeconds >= acc.salesStartDate.toNumber() && 
                                  nowInSeconds <= acc.salesEndDate.toNumber();
            
            return isStateActive && isNotCanceled && isInSalesPeriod;
        });
        
        console.log(` -> Found ${fullyActiveEvents.length} events that are fully active.`);

        const eventsWithMetadata = await Promise.all(
            fullyActiveEvents.map(async (event) => {
                try {
                    console.log(` -> Fetching metadata from: ${event.account.metadataUri}`);
                    const response = await fetch(event.account.metadataUri);
                    if (!response.ok) {
                        console.warn(` -> Failed to fetch metadata for event ${event.publicKey.toString()}`);
                        return null;
                    }
                    const metadata = await response.json();
                    console.log(` -> Successfully fetched metadata: ${metadata.name}`);
                    return {
                        publicKey: event.publicKey.toString(),
                        account: event.account,
                        metadata: metadata,
                    };
                } catch (e) {
                    console.error(` -> Error fetching metadata for ${event.account.metadataUri}`, e);
                    return null;
                }
            })
        );
        
        const validEvents = eventsWithMetadata
            .filter(e => e !== null)
            .sort((a, b) => a.account.salesStartDate.toNumber() - b.account.salesStartDate.toNumber());

        console.log(`[✔] Successfully fetched and processed ${validEvents.length} active events.`);
        res.status(200).json(validEvents);

    } catch (error) {
        console.error("[✘] Error fetching active events:", error);
        res.status(500).json({ error: "Server error fetching events.", details: error.message });
    }
};

export const getEventDetails = async (req, res) => {
    const { eventAddress } = req.params;
    if (!eventAddress) {
        return res.status(400).json({ success: false, error: 'O endereço do evento é obrigatório.' });
    }
    console.log(`[+] Buscando detalhes para o evento: ${eventAddress}`);

    try {
        const eventPubkey = new PublicKey(eventAddress);
        const account = await program.account.event.fetch(eventPubkey);
        console.log(` -> Dados on-chain encontrados.`);

        const metadataResponse = await fetch(account.metadataUri);
        if (!metadataResponse.ok) {
            throw new Error(`Falha ao buscar metadados da URI: ${account.metadataUri}`);
        }
        const metadata = await metadataResponse.json();
        console.log(` -> Metadados off-chain encontrados: ${metadata.name}`);

        res.status(200).json({
            success: true,
            event: {
                account: account,
                metadata: metadata,
            },
        });

    } catch (error) {
        console.error("[✘] Erro ao buscar detalhes do evento:", error);
        
        if (error.message.includes('Account does not exist')) {
            return res.status(404).json({ success: false, error: 'Evento não encontrado.' });
        }
        if (error.message.includes('Invalid public key')) {
             return res.status(400).json({ success: false, error: 'O endereço do evento fornecido é inválido.' });
        }

        res.status(500).json({ success: false, error: 'Ocorreu um erro no servidor ao buscar os dados do evento.' });
    }
};
