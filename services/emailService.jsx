import { Resend } from 'resend';
import React from 'react';
import QRCode from 'qrcode';

// 1. IMPORTAÇÕES ATUALIZADAS
// Removemos 'jspdf' e 'render' do @react-email/render (pois o HTML do e-mail já está em outro arquivo)
// Adicionamos as ferramentas do @react-pdf/renderer e o novo componente TicketPDF
import { renderToBuffer } from '@react-pdf/renderer';
import { TicketPDF } from '../emails/TicketPDF.jsx'; // Assumindo que o novo arquivo se chama TicketPDF.jsx
import { TicketEmail } from '../emails/TicketEmail.jsx';
import { render } from '@react-email/render';


const resend = new Resend(process.env.RESEND_API_KEY);

// 2. CONSTANTE PARA A IMAGEM DO LOGO (BASE64)
// Para evitar requisições de rede, embutimos o logo da marca como uma string Base64.
// Isso torna a geração do PDF mais rápida e confiável.
const BRAND_LOGO_BASE64 = 'https://red-obedient-stingray-854.mypinata.cloud/ipfs/bafkreih7ofsa246z5vnjvrol6xk5tpj4zys42tcaotxq7tp7ptgraalrya';

// Função auxiliar para gerar QR Code (permanece a mesma)
async function createQrCodeImage(mintAddress) {
    try {
        console.log(` -> Gerando QR Code para: ${mintAddress}`);
        const qrCodeDataUrl = await QRCode.toDataURL(mintAddress, {
            width: 150, // Um pouco maior para melhor qualidade no PDF
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

// Função auxiliar de formatação de endereço (permanece a mesma)
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


// 3. A NOVA FUNÇÃO `generateTicketPDF` USANDO @react-pdf/renderer
async function generateTicketPDF(ticketData) {
    try {
        console.log(' -> Gerando QR Code para o novo PDF...');
        const qrCodeImage = await createQrCodeImage(ticketData.mintAddress);

        console.log(' -> Renderizando componente PDF para buffer...');
        
        // `renderToBuffer` pega seu componente React e o transforma em um buffer de PDF.
        const pdfBuffer = await renderToBuffer(
            <TicketPDF
                ticketData={ticketData}
                qrCodeImage={qrCodeImage}
                brandLogoImage={BRAND_LOGO_BASE64}
            />
        );

        console.log('✅ PDF gerado com sucesso (com @react-pdf/renderer)');
        return pdfBuffer;

    } catch (error) {
        console.error('❌ Erro ao gerar PDF com @react-pdf/renderer:', error);
        throw error;
    }
}


// Função principal que orquestra tudo e envia o e-mail (agora usando a nova função de PDF)
export async function sendTicketEmail(userData, ticketData) {
    const { name: userName, email: userEmail } = userData;
    const { eventName } = ticketData;

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

        // 2. Gerar PDF (agora chama a nova função)
        console.log(`📄 Gerando PDF para o evento: ${eventName}`);
        const pdfBuffer = await generateTicketPDF(ticketData);

        // 3. Renderizar template de e-mail (permanece o mesmo)
        console.log("🎨 Renderizando template de e-mail...");
        const emailHtml = await render(
            <TicketEmail 
                userName={userName}
                eventName={eventName}
                eventDate={ticketData.eventDate}
                eventLocation={formatFullAddress(ticketData.eventLocation).replace(/\n/g, ', ')}
            />
        );

        // 4. Enviar e-mail
        console.log(`🚀 Enviando e-mail para: ${userEmail}`);
        
        // Usando o remetente de teste da Resend para validar o fluxo
        const fromAddress = 'Ticketfy <onboarding@resend.dev>';
        
        const { data, error } = await resend.emails.send({
            from: fromAddress,
            to: [userEmail],
            subject: `[TESTE] 🎟️ Seu ingresso para: ${eventName}`,
            html: emailHtml,
            attachments: [{
                filename: `Ingresso_${eventName.replace(/\s/g, '_')}.pdf`,
                content: pdfBuffer, // O buffer gerado pelo @react-pdf/renderer
            }],
        });

        if (error) {
            console.error("❌ Erro retornado pela API da Resend:", error);
            throw error;
        }

        console.log("✅ Requisição de e-mail aceita pela Resend! ID:", data.id);
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
