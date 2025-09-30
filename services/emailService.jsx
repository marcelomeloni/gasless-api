import { Resend } from 'resend';
import React from 'react';
import QRCode from 'qrcode';
import { renderToBuffer } from '@react-pdf/renderer';
import { TicketPDF } from '../emails/TicketPDF.jsx';
import { TicketEmail } from '../emails/TicketEmail.jsx';
import { render } from '@react-email/render';

const resend = new Resend(process.env.RESEND_API_KEY);

// CONSTANTE ATUALIZADA - Agora é uma URL válida
const BRAND_LOGO_BASE64 = 'https://red-obedient-stingray-854.mypinata.cloud/ipfs/bafkreih7ofsa246z5vnjvrol6xk5tpj4zys42tcaotxq7tp7ptgraalrya';

// Função auxiliar para gerar QR Code (mantida)
async function createQrCodeImage(mintAddress) {
    try {
        console.log(` -> Gerando QR Code para: ${mintAddress}`);
        const qrCodeDataUrl = await QRCode.toDataURL(mintAddress, {
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

// Função auxiliar de formatação de endereço (mantida)
const formatFullAddress = (location) => {
    if (!location || typeof location !== 'object') {
        return "Local a definir";
    }
    try {
        if (location.type !== 'Physical' || !location.address) {
            return "Local a definir";
        }
        const { venueName, address } = location;
        const line1 = `${address.street || ''}${address.number ? `, ${address.number}` : ''}`.trim();
        const line2 = `${address.neighborhood ? `${address.neighborhood}, ` : ''}${address.city || ''}${address.state ? ` - ${address.state}` : ''}`.trim();
        return `${venueName || 'Local'}\n${line1}\n${line2}`.trim();
    } catch (error) {
        console.error("Error formatting address:", error);
        return "Local a definir";
    }
};

// Função de geração de PDF (atualizada para receber novos dados)
async function generateTicketPDF(ticketData) {
    try {
        console.log(' -> Gerando QR Code para o novo PDF...');
        const qrCodeImage = await createQrCodeImage(ticketData.mintAddress);

        console.log(' -> Renderizando componente PDF para buffer...');
        
        const pdfBuffer = await renderToBuffer(
            <TicketPDF
                ticketData={ticketData}
                qrCodeImage={qrCodeImage}
                brandLogoImage={BRAND_LOGO_BASE64}
                // ✨ NOVAS PROPS ADICIONADAS ✨
                eventImage={ticketData.eventImage}
                organizerName={ticketData.organizerName}
                organizerLogo={ticketData.organizerLogo}
                eventDescription={ticketData.eventDescription}
            />
        );

        console.log('✅ PDF gerado com sucesso');
        return pdfBuffer;

    } catch (error) {
        console.error('❌ Erro ao gerar PDF:', error);
        throw error;
    }
}

// FUNÇÃO PRINCIPAL COMPLETAMENTE ATUALIZADA
export async function sendTicketEmail(userData, ticketData) {
    const { name: userName, email: userEmail } = userData;
    const { eventName, eventImage, organizerName, organizerLogo, eventDescription } = ticketData;

    if (!userEmail) {
        console.warn("❌ Usuário sem e-mail cadastrado. Pulando envio de ingresso.");
        return;
    }
    
    try {
        console.log(`📧 Iniciando processo de e-mail para: ${userEmail}`);
        
        if (!process.env.RESEND_API_KEY) {
            throw new Error("RESEND_API_KEY está faltando");
        }
        console.log("✅ Variáveis de ambiente verificadas");

        // 1. Gerar PDF (agora com dados completos)
        console.log(`📄 Gerando PDF para o evento: ${eventName}`);
        const pdfBuffer = await generateTicketPDF(ticketData);

        // 2. Renderizar template de e-mail (ATUALIZADO COM NOVOS DADOS)
        console.log("🎨 Renderizando template de e-mail...");
        const emailHtml = await render(
            <TicketEmail 
                userName={userName}
                eventName={eventName}
                eventDate={ticketData.eventDate}
                eventLocation={formatFullAddress(ticketData.eventLocation).replace(/\n/g, ', ')}
                // ✨ NOVAS PROPS ADICIONADAS ✨
                eventImage={eventImage}
                organizerName={organizerName}
                organizerLogo={organizerLogo}
                eventDescription={eventDescription}
            />
        );

        // 3. Enviar e-mail
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
            throw error;
        }

        console.log("✅ E-mail enviado com sucesso! ID:", data.id);
        return { data, error };

    } catch (error) {
        console.error("❌ Erro detalhado no envio do e-mail:", {
            message: error.message,
            stack: error.stack,
            userEmail,
            eventName
        });
        throw error;
    }
}
