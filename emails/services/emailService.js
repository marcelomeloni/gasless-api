import { Resend } from 'resend';
import { render } from '@react-email/render';
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import sharp from 'sharp';

import { TicketEmail } from '../emails/TicketEmail.jsx';

const resend = new Resend(process.env.RESEND_API_KEY);

// Função que gera o QR Code como uma imagem PNG
async function createQrCodeImage(mintAddress) {
    const svg = QRCode.toString(mintAddress, { type: 'svg' });
    // Usamos o Sharp para converter o SVG em um PNG Buffer, que o jsPDF entende melhor
    return sharp(Buffer.from(svg)).png().toBuffer();
}

// Função que gera o PDF completo em memória
async function generateTicketPDF(ticketData) {
    const { eventName, eventDate, eventLocation, mintAddress, seedPhrase, privateKey } = ticketData;

    // Funções auxiliares de formatação
    const formatFullAddress = (location) => {
        if (!location || location.type !== 'Physical' || !location.address) { return "Local a definir"; }
        const { venueName, address } = location;
        const line1 = `${address.street}${address.number ? `, ${address.number}` : ''}`;
        const line2 = `${address.neighborhood ? `${address.neighborhood}, ` : ''}${address.city} - ${address.state}`;
        return `${venueName}\n${line1}\n${line2}`;
    };
    const formatDisplayDate = (dateString) => {
        if (!dateString) return 'Data a definir';
        return new Date(dateString).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    };

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a5' });
    const qrCodeImageBuffer = await createQrCodeImage(mintAddress);
    
    // Cole aqui a lógica de desenho do PDF do seu componente TicketPDF, adaptada para o jsPDF
    // Exemplo simplificado:
    doc.setFontSize(20).text(eventName, 15, 20);
    doc.setFontSize(12).text(`Data: ${formatDisplayDate(eventDate)}`, 15, 30);
    doc.text(`Local: ${formatFullAddress(eventLocation)}`, 15, 40);
    doc.addImage(qrCodeImageBuffer, 'PNG', 40, 60, 65, 65);

    if (seedPhrase && privateKey) {
        doc.addPage();
        doc.setFontSize(14).text('Informação Confidencial de Segurança', 15, 20);
        doc.setFontSize(10).text('Frase Secreta:', 15, 30);
        doc.text(seedPhrase, 15, 35, { maxWidth: 148 - 30 });
        doc.text('Chave Privada:', 15, 60);
        doc.text(privateKey, 15, 65, { maxWidth: 148 - 30 });
    }
    
    return Buffer.from(doc.output('arraybuffer'));
}

// Função principal que orquestra tudo e envia o e-mail
export async function sendTicketEmail(userData, ticketData) {
    const { name: userName, email: userEmail } = userData;
    const { eventName, eventDate, eventLocation } = ticketData;

    if (!userEmail) {
        console.warn("Usuário sem e-mail cadastrado. Pulando envio de ingresso.");
        return;
    }
    
    try {
        console.log(` -> Gerando PDF para o evento ${eventName}...`);
        const pdfBuffer = await generateTicketPDF(ticketData);

        console.log(` -> Renderizando template de e-mail...`);
        const emailHtml = render(<TicketEmail 
            userName={userName}
            eventName={eventName}
            eventDate={eventDate}
            eventLocation={formatFullAddress(eventLocation)}
        />);

        console.log(` -> Enviando e-mail para ${userEmail}...`);
        await resend.emails.send({
            from: `Ticketfy <${process.env.FROM_EMAIL}>`,
            to: [userEmail],
            subject: `Seu ingresso para: ${eventName}`,
            html: emailHtml,
            attachments: [{
                filename: `Ingresso_${eventName.replace(/\s/g, '_')}.pdf`,
                content: pdfBuffer,
            }],
        });
        
        console.log(" -> E-mail enviado com sucesso!");

    } catch (error) {
        console.error(" -> Erro ao enviar e-mail do ingresso:", error);
        // Em produção, você poderia usar um serviço de logging aqui (Sentry, etc.)
    }
}
