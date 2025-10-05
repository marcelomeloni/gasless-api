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
    try {
        const eventPubkey = new PublicKey(eventAddress);
        const eventAccount = await program.account.event.fetch(eventPubkey);
        const organizerAddress = eventAccount.controller;
        
        const [whitelistPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("whitelist"), organizerAddress.toBuffer()], 
            program.programId
        );
        
        const whitelistAccount = await program.account.whitelist.fetch(whitelistPda);
        return whitelistAccount.platformFeeBps; 
        
    } catch (error) {
        console.error("Erro ao buscar taxa do organizador, usando padrão:", error);
        return 150;
    }
};

export const generatePaymentQR = async (req, res) => {
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
        console.log(`[QR] Iniciando geração de QR para evento: ${eventAddress}`);
        const eventPubkey = new PublicKey(eventAddress);
        const eventAccount = await program.account.event.fetch(eventPubkey);
        const platformFeeBps = await getOrganizerFee(eventAddress);

        const platformFeePercentage = platformFeeBps / 100;
        const baseAmount = priceBRLCents / 100;
        const serviceFee = (priceBRLCents * platformFeeBps) / 10000;
        const totalAmount = baseAmount + serviceFee;

        console.log('=== 🧮 DETALHES DO CÁLCULO ===');
        console.log(`Preço base: R$ ${baseAmount.toFixed(2)}`);
        console.log(`Taxa de serviço (${platformFeePercentage}%): R$ ${serviceFee.toFixed(2)}`);
        console.log(`Total: R$ ${totalAmount.toFixed(2)}`);
        console.log('==============================');

        if (isNaN(totalAmount) || totalAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Valor do pagamento inválido'
            });
        }

        if (totalAmount < 0.01) {
            return res.status(400).json({
                success: false,
                error: 'Valor mínimo do pagamento é R$ 0,01'
            });
        }

        const description = `Ingresso: ${eventName} - ${tierName}`;
        const externalReference = `TICKET_${eventAddress}_${tierIndex}_${Date.now()}`;

        const cleanApiUrl = API_URL.replace(/\/$/, '');
        const cleanFrontendUrl = FRONTEND_URL.replace(/\/$/, '');

        console.log(`[QR] Criando preferência no Mercado Pago...`);
        console.log(`[QR] Valor total: R$ ${totalAmount.toFixed(2)}`);

        const preferenceData = {
            items: [
                {
                    id: externalReference,
                    title: description,
                    description: `Ingresso para ${eventName}`,
                    unit_price: totalAmount,
                    quantity: 1,
                    currency_id: 'BRL',
                }
            ],
            payment_methods: {
                excluded_payment_types: [
                    { id: 'credit_card' },
                    { id: 'debit_card' },
                    { id: 'ticket' },
                    { id: 'bank_transfer' }
                ],
                default_payment_method_id: 'pix',
                installments: 1
            },
            point_of_interaction: {
                type: 'PIX'
            },
            payer: {
                name: userName,
                email: userEmail,
            },
            statement_descriptor: `EVENTO${eventName.substring(0, 8).replace(/\s/g, '')}`,
            external_reference: externalReference,
            notification_url: `${cleanApiUrl}/webhooks/mercadopago`,
            expires: true,
            expiration_date_from: new Date().toISOString(),
            expiration_date_to: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            back_urls: {
                success: `${cleanFrontendUrl}/payment/success`,
            },
            auto_return: 'approved',
        };

        console.log('[QR] Preference data enviada ao Mercado Pago');

        const preferenceClient = new Preference(client);
        const response = await preferenceClient.create({ body: preferenceData });
        
        const qrCode = response.point_of_interaction?.transaction_data?.qr_code;
        const qrCodeBase64 = response.point_of_interaction?.transaction_data?.qr_code_base64;
        let paymentUrl = response.init_point || response.sandbox_init_point;

        if (!qrCode && !qrCodeBase64) {
            console.warn('[QR] QR Code não gerado pelo Mercado Pago. Usando URL de fallback:', paymentUrl);
        } else {
            console.log('[QR] QR code gerado com sucesso!');
        }

        activePaymentSessions.set(externalReference, {
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
            }
        });

        console.log(`[QR] Sessão de pagamento salva: ${externalReference}`);

        setTimeout(() => {
            if (activePaymentSessions.has(externalReference)) {
                const session = activePaymentSessions.get(externalReference);
                if (session.status === 'pending') {
                    session.status = 'expired';
                    activePaymentSessions.set(externalReference, session);
                    console.log(`[QR] Sessão expirada: ${externalReference}`);
                }
            }
        }, 15 * 60 * 1000);

        const responseData = {
            success: true,
            qrCode: qrCode,
            qrCodeBase64: qrCodeBase64,
            externalReference: externalReference,
            ticketUrl: paymentUrl,
            preferenceId: response.id,
            expirationDate: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
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

        console.log(`[QR] ✅ Resposta preparada para ${userName}`);
        res.status(200).json(responseData);

    } catch (error) {
        console.error('❌ Erro ao gerar QR code do Mercado Pago:', error);
        
        if (error.response) {
            console.error('❌ Resposta de erro do Mercado Pago:', error.response.data);
        }
        
        res.status(500).json({
            success: false,
            error: 'Falha ao gerar QR code de pagamento',
            details: error.message
        });
    }
};

export const checkPaymentStatus = async (req, res) => {
    const { externalReference } = req.params;

    try {
        const paymentSession = activePaymentSessions.get(externalReference);
        
        if (!paymentSession) {
            return res.status(404).json({
                success: false,
                error: 'Payment session not found'
            });
        }

        const filters = {
            external_reference: externalReference
        };

        const paymentClient = new Payment(client);
        const searchResult = await paymentClient.search({
            qs: filters
        });

        const payments = searchResult.results;
        
        if (payments.length === 0) {
            return res.status(200).json({
                success: true,
                status: 'pending',
                paid: false
            });
        }

        const payment = payments[0];
        const isPaid = payment.status === 'approved';
        
        if (isPaid && paymentSession.status === 'pending') {
            paymentSession.status = 'paid';
            paymentSession.paymentId = payment.id;
            activePaymentSessions.set(externalReference, paymentSession);
        }

        res.status(200).json({
            success: true,
            status: payment.status,
            paid: isPaid,
            paymentId: payment.id,
            transactionAmount: payment.transaction_amount,
            currency: payment.currency_id,
            lastUpdated: payment.date_last_updated
        });

    } catch (error) {
        console.error('Error checking payment status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check payment status',
            details: error.message
        });
    }
};

export const processPaidTicket = async (req, res) => {
    const { externalReference } = req.body;

    try {
        const paymentSession = activePaymentSessions.get(externalReference);
        
        if (!paymentSession) {
            return res.status(404).json({
                success: false,
                error: 'Sessão de pagamento não encontrada'
            });
        }

        const filters = {
            external_reference: externalReference,
            status: 'approved'
        };

        const payment = new Payment(client);
        const searchResult = await payment.search({
            qs: filters
        });

        const approvedPayments = searchResult.body.results;
        
        if (approvedPayments.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Pagamento não concluído ou não verificado',
                status: 'pending'
            });
        }

        paymentSession.status = 'paid';
        paymentSession.paymentId = approvedPayments[0].id;
        activePaymentSessions.set(externalReference, paymentSession);

        console.log(`[💰] Processando ingresso pago para: ${paymentSession.userName}`);
        console.log(`[💰] Valor pago: R$ ${paymentSession.amountDetails?.totalAmount || 'N/A'}`);

        const { eventAddress, tierIndex, formData, userEmail, userName } = paymentSession;
        
        const mintResponse = await processPaidTicketForNewUser({
            eventAddress,
            tierIndex,
            formData,
            priceBRLCents: paymentSession.priceBRLCents,
            userEmail,
            userName
        });

        activePaymentSessions.delete(externalReference);

        console.log(`[🎉] Ingresso pago processado com sucesso!`);
        console.log(`[🎉] NFT Mint: ${mintResponse.mintAddress}`);
        console.log(`[🎉] Carteira do usuário: ${mintResponse.publicKey}`);

        res.status(200).json({
            success: true,
            message: 'Pagamento verificado e ingresso processado com sucesso',
            ticketData: mintResponse,
            paymentDetails: {
                amountPaid: paymentSession.amountDetails?.totalAmount,
                baseAmount: paymentSession.amountDetails?.baseAmount,
                serviceFee: paymentSession.amountDetails?.serviceFee
            }
        });

    } catch (error) {
        console.error('❌ Erro ao processar ingresso pago:', error);
        res.status(500).json({
            success: false,
            error: 'Falha ao processar ingresso pago',
            details: error.message
        });
    }
};
