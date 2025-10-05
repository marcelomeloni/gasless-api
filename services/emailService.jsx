import { Resend } from 'resend';
import React from 'react';
import QRCode from 'qrcode';
import { renderToBuffer } from '@react-pdf/renderer';
import { TicketPDF } from '../emails/TicketPDF.jsx'; // Verifique se o caminho está correto
import { TicketEmail } from '../emails/TicketEmail.jsx'; // Verifique se o caminho está correto
import { render } from '@react-email/render';

const resend = new Resend(process.env.RESEND_API_KEY);

const BRAND_LOGO_URL = 'https://red-obedient-stingray-854.mypinata.cloud/ipfs/bafkreih7ofsa246z5vnjvrol6xk5tpj4zys42tcaotxq7tp7ptgraalrya';

/**
 * Gera a imagem de um QR Code como uma string Data URL.
 * @param {string} dataForQr - O dado a ser codificado no QR Code (agora o registrationId).
 * @returns {Promise<string>} A imagem do QR Code como Data URL (base64).
 */
async function createQrCodeImage(dataForQr) {
    try {
        console.log(` -> Gerando QR Code para: ${dataForQr}`);
        const qrCodeDataUrl = await QRCode.toDataURL(dataForQr, {
            width: 150,
            margin: 1,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        console.log('✅ QR Code gerado com sucesso');
        return qrCodeDataUrl;
    } catch (error) {
        console.error('❌ Erro ao gerar QR Code:', error);
        throw error;
    }
}

/**
 * Gera o buffer de um PDF para o ingresso.
 * @param {object} ticketData - Os dados completos do ingresso, incluindo registrationId.
 * @returns {Promise<Buffer>} O buffer do PDF gerado.
 */
async function generateTicketPDF(ticketData) {
    try {
        // ✨ ATUALIZAÇÃO PRINCIPAL AQUI ✨
        // Agora usamos o 'registrationId' para gerar o QR Code.
        console.log(` -> Gerando QR Code para o PDF com o ID: ${ticketData.registrationId}`);
        const qrCodeImage = await createQrCodeImage(ticketData.registrationId);

        console.log(' -> Renderizando componente PDF para buffer...');
        
        const pdfBuffer = await renderToBuffer(
            <TicketPDF
                ticketData={ticketData} // ticketData já contém o registrationId
                qrCodeImage={qrCodeImage}
                brandLogoImage={BRAND_LOGO_URL}
            />
        );

        console.log('✅ PDF gerado com sucesso');
        return pdfBuffer;

    } catch (error) {
        console.error('❌ Erro ao gerar PDF:', error);
        throw error;
    }
}

/**
 * Envia o e-mail com o ingresso em PDF anexado.
 * @param {object} userData - Dados do usuário (nome, email).
 * @param {object} ticketData - Dados completos do ingresso e do evento.
 */
export async function sendTicketEmail(userData, ticketData) {
    const { name: userName, email: userEmail } = userData;
    const { eventName } = ticketData;

    if (!userEmail) {
        console.warn("❌ Usuário sem e-mail cadastrado. Pulando envio de ingresso.");
        return { success: false, error: "No email provided" };
    }
    
    // Validação básica de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(userEmail)) {
        console.warn(`❌ E-mail inválido: ${userEmail}`);
        return { success: false, error: "Invalid email format" };
    }
    
    try {
        console.log(`📧 Iniciando processo de e-mail para: ${userEmail}`);
        
        if (!process.env.RESEND_API_KEY) {
            throw new Error("RESEND_API_KEY está faltando");
        }

        // 1. Gerar PDF
        console.log(`📄 Gerando PDF para o evento: ${eventName}`);
        const pdfBuffer = await generateTicketPDF(ticketData);

        // 2. Renderizar template de e-mail HTML
        console.log("🎨 Renderizando template de e-mail...");
        const emailHtml = await render(
            <TicketEmail 
                userName={userName}
                eventName={eventName}
                eventDate={ticketData.eventDate}
                eventLocation={ticketData.eventLocation?.address ? `${ticketData.eventLocation.venueName}, ${ticketData.eventLocation.address.city}` : 'Online'}
                eventImage={ticketData.eventImage}
                organizerName={ticketData.organizerName}
            />
        );

        // 3. Enviar e-mail com o PDF anexado
        console.log(`🚀 Enviando e-mail para: ${userEmail}`);
        
        const fromAddress = 'Ticketfy <onboarding@resend.dev>';
        
        const { data, error } = await resend.emails.send({
            from: fromAddress,
            to: [userEmail],
            subject: `🎟️ Seu ingresso para: ${eventName}`,
            html: emailHtml,
            attachments: [{
                filename: `Ingresso_${eventName.replace(/\s/g, '_')}.pdf`,
                content: pdfBuffer,
            }],
        });

        if (error) {
            console.error("❌ Erro retornado pela API da Resend:", error);
            return { success: false, error };
        }

        console.log("✅ E-mail enviado com sucesso! ID:", data.id);
        return { success: true, data };

    } catch (error) {
        console.error("❌ Erro detalhado no processo de envio do e-mail:", {
            message: error.message,
            userEmail,
            eventName
        });
        return { success: false, error };
    }
}
