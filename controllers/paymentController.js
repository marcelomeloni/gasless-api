import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { program, PublicKey } from '../services/solanaService.js';
import { processPaidTicketForNewUser } from './ticketController.js';
import { API_URL, FRONTEND_URL, MERCADOPAGO_ACCESS_TOKEN } from '../config/index.js';

const client = new MercadoPagoConfig({ 
    accessToken: MERCADOPAGO_ACCESS_TOKEN,
    options: { timeout: 5000 }
});

export const activePaymentSessions = new Map();

export const getOrganizerFee = async (eventAddress) => {
    console.log(`[💰getOrganizerFee] Iniciando busca de taxa para evento: ${eventAddress}`);
    
    try {
        const eventPubkey = new PublicKey(eventAddress);
        console.log(`[💰getOrganizerFee] Event Pubkey convertido: ${eventPubkey.toString()}`);
        
        console.log(`[💰getOrganizerFee] Buscando conta do evento...`);
        const eventAccount = await program.account.event.fetch(eventPubkey);
        console.log(`[💰getOrganizerFee] Event account encontrado:`, {
            controller: eventAccount.controller.toString(),
            name: eventAccount.name
        });
        
        const organizerAddress = eventAccount.controller;
        console.log(`[💰getOrganizerFee] Organizador: ${organizerAddress.toString()}`);
        
        const [whitelistPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("whitelist"), organizerAddress.toBuffer()], 
            program.programId
        );
        console.log(`[💰getOrganizerFee] Whitelist PDA: ${whitelistPda.toString()}`);
        
        console.log(`[💰getOrganizerFee] Buscando conta whitelist...`);
        const whitelistAccount = await program.account.whitelist.fetch(whitelistPda);
        console.log(`[💰getOrganizerFee] Whitelist account encontrada:`, {
            platformFeeBps: whitelistAccount.platformFeeBps,
            isActive: whitelistAccount.isActive
        });
        
        const fee = whitelistAccount.platformFeeBps;
        console.log(`[💰getOrganizerFee] ✅ Taxa encontrada: ${fee} bps (${fee/100}%)`);
        return fee;
        
    } catch (error) {
        console.error(`[💰getOrganizerFee] ❌ Erro ao buscar taxa do organizador:`, {
            error: error.message,
            stack: error.stack
        });
        console.log(`[💰getOrganizerFee] 🟡 Usando taxa padrão: 150 bps (1.5%)`);
        return 150;
    }
};

export const generatePaymentQR = async (req, res) => {
    console.log(`[QR📱] === NOVA SOLICITAÇÃO DE QR CODE ===`);
    console.log(`[QR📱] Headers:`, req.headers);
    console.log(`[QR📱] Body:`, JSON.stringify(req.body, null, 2));
    
    const {
        eventAddress,
        tierIndex,
        priceBRLCents,
        userName,
        userEmail,
        tierName,
        eventName,
        formData
    } = req.body;

    try {
        console.log(`[QR📱] Iniciando geração de QR para:`, {
            eventAddress,
            tierIndex,
            priceBRLCents,
            userName,
            userEmail,
            tierName,
            eventName,
            formDataCount: Object.keys(formData || {}).length
        });

        console.log(`[QR📱] Validando dados de entrada...`);
        if (!eventAddress || !userName || !userEmail) {
            console.error(`[QR📱] ❌ Dados obrigatórios faltando:`, {
                hasEventAddress: !!eventAddress,
                hasUserName: !!userName,
                hasUserEmail: !!userEmail
            });
            return res.status(400).json({
                success: false,
                error: 'Dados obrigatórios faltando: eventAddress, userName, userEmail'
            });
        }

        console.log(`[QR📱] Buscando informações do evento na blockchain...`);
        const eventPubkey = new PublicKey(eventAddress);
        const eventAccount = await program.account.event.fetch(eventPubkey);
        console.log(`[QR📱] Event account carregado:`, {
            name: eventAccount.name,
            controller: eventAccount.controller.toString(),
            isActive: eventAccount.isActive
        });

      onsole.log(`[QR📱] Buscando taxa da plataforma...`);
const platformFeeBps = await getOrganizerFee(eventAddress);
console.log(`[QR📱] Taxa da plataforma definida: ${platformFeeBps} bps`);

const platformFeePercentage = platformFeeBps / 100;
const baseAmount = priceBRLCents / 100; //
const serviceFee = (priceBRLCents * platformFeeBps) / 10000 / 100; 
const totalAmount = baseAmount + serviceFee;

console.log('=== 🧮 DETALHES DO CÁLCULO ===');
console.log(`💰 Preço base: ${priceBRLCents} centavos = R$ ${baseAmount.toFixed(2)}`);
console.log(`📊 Taxa de serviço (${platformFeePercentage}%): R$ ${serviceFee.toFixed(2)}`);
console.log(`🎯 Total: R$ ${totalAmount.toFixed(2)}`);
console.log(`🔢 Detalhes: ${priceBRLCents} * ${platformFeeBps} / 10000 / 100 = ${serviceFee}`);
console.log('==============================');

        if (isNaN(totalAmount) || totalAmount <= 0) {
            console.error(`[QR📱] ❌ Valor do pagamento inválido:`, {
                totalAmount,
                priceBRLCents,
                baseAmount,
                serviceFee
            });
            return res.status(400).json({
                success: false,
                error: 'Valor do pagamento inválido'
            });
        }

        if (totalAmount < 0.01) {
            console.error(`[QR📱] ❌ Valor mínimo não atingido: R$ ${totalAmount.toFixed(2)}`);
            return res.status(400).json({
                success: false,
                error: 'Valor mínimo do pagamento é R$ 0,01'
            });
        }

        const description = `Ingresso: ${eventName} - ${tierName}`;
        const externalReference = `TICKET_${eventAddress}_${tierIndex}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        console.log(`[QR📱] Dados da transação:`, {
            description,
            externalReference,
            totalAmount: `R$ ${totalAmount.toFixed(2)}`
        });

        const cleanApiUrl = API_URL.replace(/\/$/, '');
        const cleanFrontendUrl = FRONTEND_URL.replace(/\/$/, '');

        console.log(`[QR📱] URLs configuradas:`, {
            apiUrl: cleanApiUrl,
            frontendUrl: cleanFrontendUrl,
            notificationUrl: `${cleanApiUrl}/webhooks/mercadopago`
        });

        console.log(`[QR📱] Criando preferência no Mercado Pago...`);
     const preferenceData = {
    items: [
        {
            id: externalReference,
            title: description,
            description: `Ingresso para ${eventName} - Comprador: ${userName} (${userEmail})`,
            unit_price: totalAmount, // Já está em reais
            quantity: 1,
            currency_id: 'BRL',
        }
    ],
    // Configuração otimizada para PIX
    payment_methods: {
        excluded_payment_types: [
            { id: 'credit_card' },
            { id: 'debit_card' },
            { id: 'ticket' },
            { id: 'bank_transfer' },
            { id: 'atm' }
        ]
    },
    point_of_interaction: {
        type: 'PIX',
        data: {
            // Forçar dados do PIX
        }
    },
    payer: {
        name: userName,
        email: userEmail,
    },
    statement_descriptor: `EVENTO${eventName.substring(0, 8).replace(/\s/g, '')}`.toUpperCase(),
    external_reference: externalReference,
    notification_url: `${cleanApiUrl}/webhooks/mercadopago`,
    expires: true,
    expiration_date_from: new Date().toISOString(),
    expiration_date_to: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    back_urls: {
        success: `${cleanFrontendUrl}/payment/success`,
        failure: `${cleanFrontendUrl}/payment/error`,
        pending: `${cleanFrontendUrl}/payment/pending`
    },
    auto_return: 'approved',
    // Adicionar configurações específicas para PIX
    processing_modes: ['aggregator'],
    binary_mode: true // Importante para PIX
};

        console.log(`[QR📱] Dados da preferência enviada:`, JSON.stringify(preferenceData, null, 2));

        const preferenceClient = new Preference(client);
        console.log(`[QR📱] Cliente Mercado Pago configurado, enviando requisição...`);
        
        const response = await preferenceClient.create({ body: preferenceData });
        console.log(`[QR📱] ✅ Resposta do Mercado Pago recebida:`, {
            preferenceId: response.id,
            hasQrCode: !!response.point_of_interaction?.transaction_data?.qr_code,
            hasQrCodeBase64: !!response.point_of_interaction?.transaction_data?.qr_code_base64,
            initPoint: !!response.init_point,
            sandboxInitPoint: !!response.sandbox_init_point
        });
        
        const qrCode = response.point_of_interaction?.transaction_data?.qr_code;
        const qrCodeBase64 = response.point_of_interaction?.transaction_data?.qr_code_base64;
        let paymentUrl = response.init_point || response.sandbox_init_point;

        if (!qrCode && !qrCodeBase64) {
            console.warn('[QR📱] ⚠️ QR Code não gerado pelo Mercado Pago. Usando URL de fallback:', paymentUrl);
        } else {
            console.log('[QR📱] ✅ QR code gerado com sucesso!');
        }

        const paymentSession = {
            eventAddress,
            tierIndex,
            priceBRLCents,
            platformFeeBps,
            formData,
            userName,
            userEmail,
            tierName,
            eventName,
            preferenceId: response.id,
            createdAt: new Date(),
            status: 'pending',
            amountDetails: {
                baseAmount,
                serviceFee,
                serviceFeeRate: platformFeePercentage,
                totalAmount
            },
            lastUpdated: new Date()
        };

        console.log(`[QR📱] Salvando sessão de pagamento: ${externalReference}`, {
            sessionData: paymentSession
        });

        activePaymentSessions.set(externalReference, paymentSession);
        console.log(`[QR📱] ✅ Sessão salva no mapa. Total de sessões ativas: ${activePaymentSessions.size}`);

        const expirationTime = 15 * 60 * 1000;
        console.log(`[QR📱] Configurando expiração em ${expirationTime/1000/60} minutos...`);
        
        setTimeout(() => {
            console.log(`[QR📱] ⏰ Verificando expiração da sessão: ${externalReference}`);
            if (activePaymentSessions.has(externalReference)) {
                const session = activePaymentSessions.get(externalReference);
                if (session.status === 'pending') {
                    session.status = 'expired';
                    session.lastUpdated = new Date();
                    activePaymentSessions.set(externalReference, session);
                    console.log(`[QR📱] 🕒 Sessão expirada: ${externalReference}`);
                } else {
                    console.log(`[QR📱] ℹ️ Sessão ${externalReference} já tem status: ${session.status}`);
                }
            } else {
                console.log(`[QR📱] ℹ️ Sessão ${externalReference} já foi removida`);
            }
        }, expirationTime);

        const responseData = {
            success: true,
            qrCode: qrCode,
            qrCodeBase64: qrCodeBase64,
            externalReference: externalReference,
            ticketUrl: paymentUrl,
            preferenceId: response.id,
            expirationDate: new Date(Date.now() + expirationTime).toISOString(),
            amountDetails: {
                baseAmount: baseAmount,
                serviceFee: serviceFee,
                serviceFeeRate: platformFeePercentage,
                totalAmount: totalAmount
            },
            paymentInfo: {
                hasQrCode: !!qrCode,
                hasQrCodeBase64: !!qrCodeBase64,
                paymentUrl: !!paymentUrl
            }
        };

        console.log(`[QR📱] ✅ Resposta final preparada para ${userName}`, {
            externalReference,
            hasQrCode: !!qrCode,
            totalAmount: `R$ ${totalAmount.toFixed(2)}`
        });

        res.status(200).json(responseData);

    } catch (error) {
        console.error('❌[QR📱] Erro crítico ao gerar QR code do Mercado Pago:', {
            error: error.message,
            stack: error.stack,
            code: error.code,
            type: error.type
        });
        
        if (error.response) {
            console.error('❌[QR📱] Resposta de erro do Mercado Pago:', {
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data
            });
        }
        
        if (error.cause) {
            console.error('❌[QR📱] Causa do erro:', error.cause);
        }
        
        res.status(500).json({
            success: false,
            error: 'Falha ao gerar QR code de pagamento',
            details: error.message,
            code: error.code || 'UNKNOWN_ERROR'
        });
    }
};

export const checkPaymentStatus = async (req, res) => {
    const { externalReference } = req.params;
    
    console.log(`[🔍checkPaymentStatus] Verificando status do pagamento: ${externalReference}`);
    console.log(`[🔍checkPaymentStatus] Sessões ativas: ${activePaymentSessions.size}`);
    console.log(`[🔍checkPaymentStatus] Sessões no mapa:`, Array.from(activePaymentSessions.keys()));

    try {
        const paymentSession = activePaymentSessions.get(externalReference);
        
        if (!paymentSession) {
            console.error(`[🔍checkPaymentStatus] ❌ Sessão não encontrada: ${externalReference}`);
            return res.status(404).json({
                success: false,
                error: 'Payment session not found',
                sessionCount: activePaymentSessions.size
            });
        }

        console.log(`[🔍checkPaymentStatus] Sessão encontrada:`, {
            externalReference,
            status: paymentSession.status,
            userName: paymentSession.userName,
            eventName: paymentSession.eventName,
            lastUpdated: paymentSession.lastUpdated
        });

        console.log(`[🔍checkPaymentStatus] Buscando pagamentos no Mercado Pago...`);
        const filters = {
            external_reference: externalReference
        };

        console.log(`[🔍checkPaymentStatus] Filtros de busca:`, filters);
        const paymentClient = new Payment(client);
        const searchResult = await paymentClient.search({
            qs: filters
        });

        console.log(`[🔍checkPaymentStatus] Resultado da busca:`, {
            totalResults: searchResult.results?.length || 0,
            hasPaging: !!searchResult.paging,
            paging: searchResult.paging
        });

        const payments = searchResult.results || [];
        
        if (payments.length === 0) {
            console.log(`[🔍checkPaymentStatus] ℹ️ Nenhum pagamento encontrado para: ${externalReference}`);
            return res.status(200).json({
                success: true,
                status: 'pending',
                paid: false,
                sessionStatus: paymentSession.status,
                lastChecked: new Date().toISOString()
            });
        }

        console.log(`[🔍checkPaymentStatus] 📊 Pagamentos encontrados: ${payments.length}`);
        payments.forEach((payment, index) => {
            console.log(`[🔍checkPaymentStatus] Pagamento ${index + 1}:`, {
                id: payment.id,
                status: payment.status,
                statusDetail: payment.status_detail,
                transactionAmount: payment.transaction_amount,
                dateCreated: payment.date_created,
                dateLastUpdated: payment.date_last_updated
            });
        });

        const payment = payments[0];
        const isPaid = payment.status === 'approved';
        
        console.log(`[🔍checkPaymentStatus] Status do primeiro pagamento:`, {
            paymentId: payment.id,
            status: payment.status,
            isPaid: isPaid,
            currentSessionStatus: paymentSession.status
        });

        if (isPaid && paymentSession.status === 'pending') {
            console.log(`[🔍checkPaymentStatus] 🎉 Pagamento aprovado! Atualizando sessão...`);
            paymentSession.status = 'paid';
            paymentSession.paymentId = payment.id;
            paymentSession.lastUpdated = new Date();
            activePaymentSessions.set(externalReference, paymentSession);
            console.log(`[🔍checkPaymentStatus] ✅ Sessão atualizada para 'paid'`);
        } else {
            console.log(`[🔍checkPaymentStatus] ℹ️ Status não mudou ou já foi processado:`, {
                isPaid,
                currentSessionStatus: paymentSession.status
            });
        }

        const responseData = {
            success: true,
            status: payment.status,
            paid: isPaid,
            paymentId: payment.id,
            transactionAmount: payment.transaction_amount,
            currency: payment.currency_id,
            lastUpdated: payment.date_last_updated,
            sessionStatus: paymentSession.status,
            amountDetails: paymentSession.amountDetails
        };

        console.log(`[🔍checkPaymentStatus] ✅ Resposta de status:`, responseData);
        res.status(200).json(responseData);

    } catch (error) {
        console.error('❌[🔍checkPaymentStatus] Erro ao verificar status do pagamento:', {
            externalReference,
            error: error.message,
            stack: error.stack
        });
        
        if (error.response) {
            console.error('❌[🔍checkPaymentStatus] Resposta de erro:', error.response.data);
        }
        
        res.status(500).json({
            success: false,
            error: 'Failed to check payment status',
            details: error.message,
            externalReference: externalReference
        });
    }
};

export const processPaidTicket = async (req, res) => {
    console.log(`[🎫processPaidTicket] === PROCESSANDO INGRESSO PAGO ===`);
    console.log(`[🎫processPaidTicket] Body:`, JSON.stringify(req.body, null, 2));
    
    const { externalReference } = req.body;

    if (!externalReference) {
        console.error(`[🎫processPaidTicket] ❌ externalReference não fornecido`);
        return res.status(400).json({
            success: false,
            error: 'externalReference é obrigatório'
        });
    }

    try {
        console.log(`[🎫processPaidTicket] Buscando sessão: ${externalReference}`);
        const paymentSession = activePaymentSessions.get(externalReference);
        
        if (!paymentSession) {
            console.error(`[🎫processPaidTicket] ❌ Sessão não encontrada: ${externalReference}`);
            console.log(`[🎫processPaidTicket] Sessões disponíveis:`, Array.from(activePaymentSessions.keys()));
            return res.status(404).json({
                success: false,
                error: 'Sessão de pagamento não encontrada',
                availableSessions: Array.from(activePaymentSessions.keys())
            });
        }

        console.log(`[🎫processPaidTicket] Sessão encontrada:`, {
            externalReference,
            status: paymentSession.status,
            userName: paymentSession.userName,
            eventName: paymentSession.eventName,
            amount: paymentSession.amountDetails?.totalAmount
        });

        console.log(`[🎫processPaidTicket] Verificando pagamentos aprovados no Mercado Pago...`);
        const filters = {
            external_reference: externalReference,
            status: 'approved'
        };

        console.log(`[🎫processPaidTicket] Filtros:`, filters);
        const paymentClient = new Payment(client);
        const searchResult = await paymentClient.search({
            qs: filters
        });

        const approvedPayments = searchResult.results || [];
        console.log(`[🎫processPaidTicket] Pagamentos aprovados encontrados: ${approvedPayments.length}`);

        if (approvedPayments.length === 0) {
            console.warn(`[🎫processPaidTicket] ⚠️ Nenhum pagamento aprovado encontrado para: ${externalReference}`);
            
            console.log(`[🎫processPaidTicket] Buscando todos os pagamentos para diagnóstico...`);
            const allPayments = await paymentClient.search({
                qs: { external_reference: externalReference }
            });
            
            console.log(`[🎫processPaidTicket] Todos os pagamentos encontrados:`, 
                allPayments.results?.map(p => ({
                    id: p.id,
                    status: p.status,
                    status_detail: p.status_detail
                }))
            );

            return res.status(400).json({
                success: false,
                error: 'Pagamento não concluído ou não verificado',
                status: 'pending',
                foundPayments: allPayments.results?.length || 0
            });
        }

        const approvedPayment = approvedPayments[0];
        console.log(`[🎫processPaidTicket] ✅ Pagamento aprovado encontrado:`, {
            paymentId: approvedPayment.id,
            transactionAmount: approvedPayment.transaction_amount,
            currency: approvedPayment.currency_id,
            dateApproved: approvedPayment.date_approved
        });

        console.log(`[🎫processPaidTicket] Atualizando sessão para 'paid'...`);
        paymentSession.status = 'paid';
        paymentSession.paymentId = approvedPayment.id;
        paymentSession.paymentDetails = {
            transactionAmount: approvedPayment.transaction_amount,
            currency: approvedPayment.currency_id,
            dateApproved: approvedPayment.date_approved,
            paymentMethod: approvedPayment.payment_method_id
        };
        paymentSession.lastUpdated = new Date();
        activePaymentSessions.set(externalReference, paymentSession);

        console.log(`[🎫processPaidTicket] 💰 Processando ingresso pago para: ${paymentSession.userName}`);
        console.log(`[🎫processPaidTicket] Detalhes do pagamento:`, {
            eventAddress: paymentSession.eventAddress,
            tierIndex: paymentSession.tierIndex,
            priceBRLCents: paymentSession.priceBRLCents,
            userEmail: paymentSession.userEmail,
            userName: paymentSession.userName,
            totalAmount: paymentSession.amountDetails?.totalAmount
        });

        const { eventAddress, tierIndex, formData, userEmail, userName } = paymentSession;
        
        console.log(`[🎫processPaidTicket] Chamando processPaidTicketForNewUser...`);
        const mintResponse = await processPaidTicketForNewUser({
            eventAddress,
            tierIndex,
            formData,
            priceBRLCents: paymentSession.priceBRLCents,
            userEmail,
            userName
        });

        console.log(`[🎫processPaidTicket] ✅ Resposta do mint:`, {
            success: mintResponse.success,
            mintAddress: mintResponse.mintAddress,
            userPublicKey: mintResponse.publicKey,
            transactionSignature: mintResponse.signature
        });

        console.log(`[🎫processPaidTicket] Removendo sessão do mapa...`);
        activePaymentSessions.delete(externalReference);
        console.log(`[🎫processPaidTicket] ✅ Sessão removida. Total de sessões ativas: ${activePaymentSessions.size}`);

        console.log(`[🎫processPaidTicket] 🎉 Ingresso pago processado com sucesso!`);

        const responseData = {
            success: true,
            message: 'Pagamento verificado e ingresso processado com sucesso',
            ticketData: mintResponse,
            paymentDetails: {
                amountPaid: paymentSession.amountDetails?.totalAmount,
                baseAmount: paymentSession.amountDetails?.baseAmount,
                serviceFee: paymentSession.amountDetails?.serviceFee,
                paymentId: approvedPayment.id
            },
            processedAt: new Date().toISOString()
        };

        res.status(200).json(responseData);

    } catch (error) {
        console.error('❌[🎫processPaidTicket] Erro ao processar ingresso pago:', {
            externalReference,
            error: error.message,
            stack: error.stack,
            sessionData: paymentSession ? {
                status: paymentSession.status,
                userName: paymentSession.userName,
                eventName: paymentSession.eventName
            } : 'NO_SESSION'
        });
        
        res.status(500).json({
            success: false,
            error: 'Falha ao processar ingresso pago',
            details: error.message,
            externalReference: externalReference,
            step: 'processing_ticket'
        });
    }
};

// Função auxiliar para debug das sessões ativas
export const getActiveSessions = async (req, res) => {
    console.log(`[🔍getActiveSessions] Solicitando sessões ativas`);
    
    const sessions = {};
    activePaymentSessions.forEach((value, key) => {
        sessions[key] = {
            ...value,
            createdAt: value.createdAt?.toISOString(),
            lastUpdated: value.lastUpdated?.toISOString()
        };
    });

    console.log(`[🔍getActiveSessions] Retornando ${Object.keys(sessions).length} sessões`);
    
    res.status(200).json({
        success: true,
        totalSessions: activePaymentSessions.size,
        sessions: sessions
    });
};
