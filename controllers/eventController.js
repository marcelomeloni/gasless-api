import { program, payerKeypair, SystemProgram, PublicKey } from '../services/solanaService.js';
import { uploadToPinata, uploadJSONToPinata } from '../services/pinataService.js';
import anchor from '@coral-xyz/anchor';
import axios from 'axios';
import FormData from 'form-data';

export const createFullEvent = async (req, res) => {
    console.log('[+] Recebida requisição para criar evento completo.');

    try {
        const { offChainData, onChainData, controller } = req.body;
        if (!offChainData || !onChainData || !controller) {
            return res.status(400).json({ success: false, error: "Dados do formulário ou do controlador ausentes." });
        }
        
        const parsedOffChainData = JSON.parse(offChainData);
        const parsedOnChainData = JSON.parse(onChainData);
        const controllerPubkey = new PublicKey(controller);
        const files = req.files;

        let imageUrl = parsedOffChainData.image;
        let organizerLogoUrl = parsedOffChainData.organizer.organizerLogo;

        if (files.image?.[0]) {
            console.log(' -> Fazendo upload da imagem do evento...');
            imageUrl = await uploadToPinata(files.image[0]);
            console.log(` -> Imagem do evento enviada: ${imageUrl}`);
        } else {
            console.error('❌ Nenhuma imagem foi recebida no upload');
            return res.status(400).json({ 
                success: false, 
                error: "Imagem principal do evento é obrigatória." 
            });
        }

        if (files.organizerLogo?.[0]) {
            console.log(' -> Fazendo upload do logo do organizador...');
            organizerLogoUrl = await uploadToPinata(files.organizerLogo[0]);
            console.log(` -> Logo enviado: ${organizerLogoUrl}`);
        } else if (!organizerLogoUrl || organizerLogoUrl.startsWith('[Arquivo:')) {
            organizerLogoUrl = '';
        }

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

        console.log(' -> Construindo transação...');
        
        // Obter o blockhash mais recente
        const { blockhash, lastValidBlockHeight } = await program.provider.connection.getLatestBlockhash('confirmed');

        // Criar a transação usando o método do Anchor
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
                controller: controllerPubkey,
                payer: payerKeypair.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .transaction();

        // Definir o blockhash e fee payer
        tx.recentBlockhash = blockhash;
        tx.feePayer = payerKeypair.publicKey;

        console.log(' -> Assinando transação com a carteira da API...');
        
        // Assinar a transação
        tx.sign(payerKeypair);

        console.log(' -> Enviando transação para a blockchain...');
        
        // Serializar e enviar a transação
        const serializedTx = tx.serialize();
        const signature = await program.provider.connection.sendRawTransaction(
            serializedTx,
            {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
                maxRetries: 3
            }
        );

        console.log(` -> Transação enviada: ${signature}`);
        console.log(' -> Aguardando confirmação...');

        // Aguardar confirmação
        const confirmation = await program.provider.connection.confirmTransaction(
            {
                signature,
                blockhash,
                lastValidBlockHeight,
            },
            'confirmed'
        );

        if (confirmation.value.err) {
            throw new Error(`Transação falhou: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log(`[✔] Evento criado com sucesso! Assinatura: ${signature}`);
        console.log(`[🎉] Transação confirmada! Evento criado em: ${eventPda.toString()}`);

        res.status(200).json({ 
            success: true, 
            signature, 
            eventAddress: eventPda.toString(),
            eventId: eventId.toString(),
            metadataUrl: metadataUrl,
            message: "Evento criado automaticamente com sucesso!" 
        });

    } catch (error) {
        console.error("❌ Erro no processo de criação completo do evento:", error);
        
        if (error.logs) {
            console.error('Logs da transação:', error.logs);
        }
        
        // Log mais detalhado para debugging
        console.error('Stack trace:', error.stack);
        
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Ocorreu um erro interno no servidor.',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
