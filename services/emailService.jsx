import { Resend } from 'resend';
import { render } from '@react-email/render';
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';

const resend = new Resend(process.env.RESEND_API_KEY);

// Função que gera o QR Code como uma imagem PNG - CORRIGIDA
async function createQrCodeImage(mintAddress) {
    try {
        console.log(` -> Gerando QR Code para: ${mintAddress}`);
        // ⭐ CORREÇÃO: QRCode.toString retorna uma Promise, precisamos await
        const svgString = await QRCode.toString(mintAddress, { type: 'svg' });
        // ⭐ CORREÇÃO: Converter a string SVG para Buffer
        const svgBuffer = Buffer.from(svgString);
        // Converter SVG para PNG
        const pngBuffer = await sharp(svgBuffer).png().toBuffer();
        console.log('✅ QR Code gerado com sucesso');
        return pngBuffer;
    } catch (error) {
        console.error('❌ Erro ao gerar QR Code:', error);
        throw error;
    }
}

// Função auxiliar de formatação de endereço
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

// Função que gera o PDF completo em memória - CORRIGIDA
async function generateTicketPDF(ticketData) {
    const { eventName, eventDate, eventLocation, mintAddress, seedPhrase, privateKey } = ticketData;

    const formatDisplayDate = (dateString) => {
        if (!dateString) return 'Data a definir';
        return new Date(dateString).toLocaleString('pt-BR', { 
            weekday: 'long', 
            day: '2-digit', 
            month: 'long', 
            year: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit', 
            timeZone: 'America/Sao_Paulo' 
        });
    };

    try {
        console.log(' -> Criando documento PDF...');
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a5' });
        
        // ⭐ CORREÇÃO: Aguardar a geração do QR code
        const qrCodeImageBuffer = await createQrCodeImage(mintAddress);
        
        // Página 1: Ingresso
        doc.setFontSize(16);
        doc.setFont(undefined, 'bold');
        doc.text('TICKETFY', 105, 20, { align: 'center' });
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.text('INGRESSO DIGITAL NFT', 105, 28, { align: 'center' });
        
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text(eventName, 105, 40, { align: 'center', maxWidth: 130 });
        
        // Informações do evento
        doc.setFontSize(8);
        doc.setFont(undefined, 'bold');
        doc.text('DATA DO EVENTO', 20, 60);
        doc.setFont(undefined, 'normal');
        doc.text(formatDisplayDate(eventDate), 20, 65);
        
        doc.setFont(undefined, 'bold');
        doc.text('LOCALIZAÇÃO', 20, 80);
        doc.setFont(undefined, 'normal');
        const locationLines = formatFullAddress(eventLocation).split('\n');
        locationLines.forEach((line, index) => {
            doc.text(line, 20, 85 + (index * 5));
        });
        
        // QR Code
        doc.addImage(qrCodeImageBuffer, 'PNG', 100, 55, 50, 50);
        doc.setFontSize(6);
        doc.text('CÓDIGO DE VALIDAÇÃO', 125, 108, { align: 'center' });
        doc.text(mintAddress, 125, 112, { align: 'center', maxWidth: 80 });
        
        // Footer
        doc.setFontSize(7);
        doc.text('Este ingresso é um token NFT único na blockchain Solana.', 105, 130, { align: 'center' });
        doc.text('Apresente este QR code na entrada do evento.', 105, 135, { align: 'center' });
        doc.text('Após o evento, seu certificado estará disponível em:', 105, 145, { align: 'center' });
        doc.text(`ticketfy.app/certificate/${mintAddress.slice(0, 8)}...`, 105, 150, { align: 'center' });

        // Página 2: Informações de segurança (se houver)
        if (seedPhrase && privateKey) {
            doc.addPage();
            
            doc.setFontSize(14);
            doc.setFont(undefined, 'bold');
            doc.text('CARTEIRA DIGITAL', 105, 20, { align: 'center' });
            
            doc.setFontSize(10);
            doc.setFont(undefined, 'normal');
            doc.text('Informações confidenciais para acesso à sua carteira blockchain', 105, 28, { align: 'center', maxWidth: 130 });
            
            // Aviso de segurança
            doc.setFontSize(9);
            doc.setFont(undefined, 'bold');
            doc.text('⚠️ INFORMAÇÕES EXTREMAMENTE CONFIDENCIAIS', 20, 45);
            doc.setFont(undefined, 'normal');
            doc.text('Estas chaves dão acesso total aos seus ativos digitais. Guarde esta página em', 20, 52, { maxWidth: 160 });
            doc.text('local seguro e OFFLINE. Nunca compartilhe, fotografe ou digitalize estas', 20, 57, { maxWidth: 160 });
            doc.text('informações. A perda pode resultar em roubo irreversível.', 20, 62, { maxWidth: 160 });
            
            // Seed Phrase
            doc.setFont(undefined, 'bold');
            doc.text('Frase de Recuperação (Seed Phrase)', 20, 80);
            doc.setFont(undefined, 'normal');
            const words = seedPhrase.split(' ');
            words.forEach((word, index) => {
                const row = Math.floor(index / 3);
                const col = index % 3;
                const x = 20 + (col * 60);
                const y = 87 + (row * 6);
                doc.text(`${index + 1}. ${word}`, x, y);
            });
            
            // Private Key
            doc.setFont(undefined, 'bold');
            doc.text('Chave Privada (para importação)', 20, 120);
            doc.setFont(undefined, 'normal');
            doc.setFontSize(7);
            doc.text(privateKey, 20, 127, { maxWidth: 160 });
            
            // Aviso final
            doc.setFontSize(8);
            doc.text('✅ Recomendamos guardar este documento em cofre físico.', 105, 180, { align: 'center' });
            doc.text('Estas informações não podem ser recuperadas se perdidas.', 105, 185, { align: 'center' });
        }
        
        console.log('✅ PDF gerado com sucesso');
        return Buffer.from(doc.output('arraybuffer'));
        
    } catch (error) {
        console.error('❌ Erro ao gerar PDF:', error);
        throw error;
    }
}

// Função principal que orquestra tudo e envia o e-mail - CORRIGIDA
export async function sendTicketEmail(userData, ticketData) {
    const { name: userName, email: userEmail } = userData;
    const { eventName, eventDate, eventLocation } = ticketData;

    if (!userEmail) {
        console.warn("❌ Usuário sem e-mail cadastrado. Pulando envio de ingresso.");
        return;
    }
    
    try {
        console.log(`📧 Iniciando processo de e-mail para: ${userEmail}`);
        
        // 1. Verificar configuração do Resend
        if (!process.env.RESEND_API_KEY) {
            throw new Error("RESEND_API_KEY está faltando");
        }
        if (!process.env.FROM_EMAIL) {
            throw new Error("FROM_EMAIL está faltando");
        }
        console.log("✅ Variáveis de ambiente verificadas");

        // 2. Gerar PDF
        console.log(`📄 Gerando PDF para o evento: ${eventName}`);
        const pdfBuffer = await generateTicketPDF(ticketData);
        console.log("✅ PDF gerado com sucesso");

        // 3. Renderizar template de e-mail (se você tiver um componente TicketEmail)
        console.log("🎨 Renderizando template de e-mail...");
        let emailHtml = `
            <html>
                <body>
                    <h1>Olá ${userName}!</h1>
                    <p>Seu ingresso para <strong>${eventName}</strong> está anexo a este e-mail.</p>
                    <p><strong>Data:</strong> ${new Date(eventDate).toLocaleDateString('pt-BR')}</p>
                    <p><strong>Local:</strong> ${formatFullAddress(eventLocation).replace(/\n/g, ', ')}</p>
                    <p>Apresente o QR code na entrada do evento.</p>
                    <br>
                    <p>Atenciosamente,<br>Equipe Ticketfy</p>
                </body>
            </html>
        `;

        // 4. Enviar e-mail
        console.log(`🚀 Enviando e-mail para: ${userEmail}`);
        const result = await resend.emails.send({
            from: `Ticketfy <${process.env.FROM_EMAIL}>`,
            to: [userEmail],
            subject: `🎟️ Seu ingresso para: ${eventName}`,
            html: emailHtml,
            attachments: [{
                filename: `Ingresso_${eventName.replace(/\s/g, '_')}.pdf`,
                content: pdfBuffer,
            }],
        });
        
        console.log("✅ E-mail enviado com sucesso!");
        return result;

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
