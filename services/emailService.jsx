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
const BRAND_LOGO_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAN+SURBVGhD7ZlpyJ9hHMd/L95dhIgoKrqIuBfl4gNxcFEU1EHExVFExRFEVBSdxFGXLrpxaUfcaZTc6KJjH+CiVBwdRRRx4IBzkf+v7+n39PV9f8/3vT/de6/v93N/v+/5fh/P+zxvYWCgfwL8BwyGgqANxW2wFfxbWA17wCvYDW/Al/AWfAEvwTpwA+bBDHj+hcAGWAzL4A04BefBOmgH42ADbAXL4AV4C5bBfPj+F0A/GA+HwQ1wA1bBK/gBzoA34E74BD6DF+BOmAUL4Hj4XwB9YBAcDg/A/wQfw3d/BfSAAXB4pG9eAN8J6AF/gYVweCSt4VfgexLQAy6AgXA4pC1dwffg4xLQA16BwXA4pHX9BH4Kfi2gByyDCHA4pLV9BT+FvxnQAy6A4XA4pLV9A78W/k5ADzgEh8HhEAX6Bv6L/zOgB5yD4+BwCEv7Cv4l/s+AHnAKjsLhEAYGhv4vQA/4DI7D4RCE+gb+E/6vgB5wCA7B4RCG+gb+Y/6fgB5wDI7C4RCG+gb+Y/5/AT3gBByBwyEM9Q38p/y/A3rABTgcDoew1jfw3/J/DeiB34DD4XAIQ30D/5L/x4Ae8AMcDIdDGGsb+If8fx3QAx7D4XA4hLG+gX/I/7dAD7gEDofDISxrG/gX/L8M9IDf4XQ4HMLaBv4l/x+DHvAHnAmHwxhrG/in/H8M9IDz4Uw4HMLaBv4p/y/BXrAjfAjr4d/k/3LYA7fCmXA4hE3gH3vAdXApHIZD2AT+sQfcBYfA4RAMgc8bcBccgEMhDITZ/d7/S3AIDCETGBl2/q/gU/AnXA23w5XQDW/AHfA+/Axfw63wBXwPz4VHYBccDufCXDgjP/f/JWyF6+BGuAv+guvgTrgDboblYAlYDAfAqXBKLgVb4S74BVyBG+E+mAdL4Qo4Fq4Hq+EquAZuhevgrv8Lw0MhDAy6/jeiB0aG3f8b0YORELgU/sf/RPSgaOHz/8f8v9yPQiEsDAy6/gP+4f8i6IF/4XQ4HMLQ/j/jH/7vBD3gj3A6HA5h2G9gvz/z+93P4XAID4O+gQW/BfSAaXC4YJz+7v/jP0f0wBc4XDDO2/7w4/9u0AND4XDBuM/r3/85ogtGxu2Fw7+FwyEY/v5/4f8C9IAv4nBBPw1+APgF/gf6l9k3+iW+qQAAAABJRU5ErkJggg==';

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
