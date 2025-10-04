import React from 'react';
import { Page, Text, View, Document, StyleSheet, Image, Link } from '@react-pdf/renderer';

// --- Estilos ---
const styles = StyleSheet.create({
  document: {
    fontFamily: 'Helvetica',
  },
  
  // Página 1: Ingresso Principal
  page: {
    padding: 0,
    backgroundColor: '#FFFFFF',
  },
  
  header: {
    backgroundColor: '#4F46E5',
    paddingVertical: 15,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 80,
  },
  
  // ✅ Layout do header mais robusto com larguras definidas
  brandContainer: {
    width: '60%',
  },
  
  brandSection: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 5,
  },
  
  brandLogo: {
    width: 28,
    height: 28,
    marginRight: 8,
  },
  
  brandTitle: {
    fontSize: 16,
    color: '#FFFFFF',
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.3,
  },
  
  ticketType: {
    fontSize: 8,
    color: '#E0E7FF',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom: 2,
  },
  
  eventName: {
    fontSize: 14,
    color: '#FFFFFF',
    fontFamily: 'Helvetica-Bold',
    lineHeight: 1.2,
  },
  
  eventImageContainer: {
    width: '35%',
    alignItems: 'flex-end',
  },
  
  // ✅ Estilo da imagem final: sem borda para evitar riscos caso algo falhe
  eventImage: {
    maxWidth: 120,
    maxHeight: 60,
    objectFit: 'contain', // Garante que a imagem caiba inteira
  },

  // Corpo do ingresso
  ticketBody: {
    padding: 22,
  },
  
  infoGrid: {
    flexDirection: 'row',
    marginBottom: 14,
  },
  
  infoColumn: {
    flex: 1,
  },
  
  infoBlock: {
    marginBottom: 11,
  },
  
  infoLabel: {
    fontSize: 8,
    color: '#64748B',
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom: 2.5,
  },
  
  infoValue: {
    fontSize: 10,
    color: '#1E293B',
    lineHeight: 1.25,
  },
  
  qrSection: {
    alignItems: 'center',
    marginVertical: 14,
    padding: 18,
    backgroundColor: '#F8FAFC',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  
  qrCodeImage: {
    width: 110,
    height: 110,
    marginBottom: 10,
  },
  
  qrLabel: {
    fontSize: 9,
    color: '#64748B',
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom: 5,
  },
  
  mintAddress: {
    fontSize: 7,
    color: '#94A3B8',
    fontFamily: 'Courier',
    textAlign: 'center',
    lineHeight: 1.15,
  },
  
  footer: {
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  
  securityNotice: {
    fontSize: 8,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 1.25,
    marginBottom: 9,
  },
  
  certificateLink: {
    fontSize: 9,
    color: '#4F46E5',
    textAlign: 'center',
    textDecoration: 'none',
    fontFamily: 'Helvetica-Bold',
  },
  
  // Página 2: Segurança
  securityPage: {
    padding: 30,
    backgroundColor: '#FFFFFF',
  },
  
  securityHeader: {
    backgroundColor: '#4F46E5',
    padding: 20,
    marginBottom: 20,
    borderRadius: 8,
  },
  
  securityTitle: {
    fontSize: 16,
    color: '#FFFFFF',
    fontFamily: 'Helvetica-Bold',
    textAlign: 'center',
    marginBottom: 6,
  },
  
  securitySubtitle: {
    fontSize: 10,
    color: '#E0E7FF',
    textAlign: 'center',
    lineHeight: 1.3,
  },
  
  warningBox: {
    backgroundColor: '#FEF2F2',
    borderLeftWidth: 4,
    borderLeftColor: '#DC2626',
    padding: 15,
    marginBottom: 20,
    borderRadius: 6,
  },
  
  warningTitle: {
    fontSize: 11,
    color: '#DC2626',
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
  },
  
  warningText: {
    fontSize: 9,
    color: '#991B1B',
    lineHeight: 1.4,
  },
  
  seedSection: {
    marginBottom: 20,
  },
  
  sectionTitle: {
    fontSize: 12,
    color: '#1E293B',
    fontFamily: 'Helvetica-Bold',
    marginBottom: 12,
    paddingBottom: 6,
    borderBottomWidth: 2,
    borderBottomColor: '#4F46E5',
  },
  
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 6,
    padding: 12,
  },
  
  seedWordBox: {
    width: '33.33%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  
  seedNumber: {
    fontSize: 8,
    color: '#64748B',
    fontFamily: 'Courier',
    width: 16,
  },
  
  seedWord: {
    fontSize: 9,
    color: '#1E293B',
    fontFamily: 'Helvetica-Bold',
  },
  
  privateKeySection: {
    marginBottom: 15,
  },
  
  privateKeyBox: {
    backgroundColor: '#1E293B',
    borderRadius: 6,
    padding: 15,
  },
  
  privateKeyLabel: {
    fontSize: 9,
    color: '#94A3B8',
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  
  privateKeyText: {
    fontSize: 7,
    color: '#E2E8F0',
    fontFamily: 'Courier',
    lineHeight: 1.3,
    wordBreak: 'break-all',
  },
  
  finalNotice: {
    backgroundColor: '#F0FDF4',
    padding: 15,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#BBF7D0',
  },
  
  finalNoticeText: {
    fontSize: 9,
    color: '#166534',
    textAlign: 'center',
    lineHeight: 1.3,
    fontFamily: 'Helvetica-Bold',
  },
});

// --- COMPONENTE PRINCIPAL ---

export const TicketPDF = ({ ticketData, qrCodeImage, brandLogoImage }) => {
  // A `eventImage` agora é uma string Base64 (Data URI) passada pelo TicketSuccessModal
  const { eventName, eventDate, eventLocation, mintAddress, seedPhrase, privateKey, eventImage, registrationId  } = ticketData;

  const formatFullAddress = (location) => {
    if (!location || location.type !== 'Physical' || !location.address) { 
      return "Local a definir"; 
    }
    const { venueName, address } = location;
    const line1 = `${address.street}${address.number ? `, ${address.number}` : ''}`;
    const line2 = `${address.neighborhood ? `${address.neighborhood}, ` : ''}${address.city} - ${address.state}`;
    return `${venueName}\n${line1}\n${line2}`;
  };

  const formatDisplayDate = (dateString) => {
    if (!dateString) return 'Data a definir';
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  };

  const formatDisplayTime = (dateString) => {
    if (!dateString) return 'Horário a definir';
    return new Date(dateString).toLocaleTimeString('pt-BR', { 
      timeStyle: 'short', 
      timeZone: 'America/Sao_Paulo' 
    });
  };

  return (
    <Document style={styles.document} author="Ticketfy" title={`Ingresso - ${eventName}`}>
      {/* PÁGINA 1: INGRESSO PRINCIPAL */}
      <Page size="A5" style={styles.page}>
                <View style={styles.header}>
                    <View style={styles.brandContainer}>
                        <View style={styles.brandSection}><Image style={styles.brandLogo} src={brandLogoImage} /><Text style={styles.brandTitle}>TICKETFY</Text></View>
                        <Text style={styles.ticketType}>Ingresso Digital NFT</Text>
                        <Text style={styles.eventName}>{eventName}</Text>
                    </View>
                    <View style={styles.eventImageContainer}>{eventImage && (<Image style={styles.eventImage} src={eventImage} />)}</View>
                </View>
                <View style={styles.ticketBody}>
                    <View style={styles.infoGrid}>
                        <View style={styles.infoColumn}>
                            <View style={styles.infoBlock}><Text style={styles.infoLabel}>Data do Evento</Text><Text style={styles.infoValue}>{formatDisplayDate(eventDate)}</Text></View>
                            <View style={styles.infoBlock}><Text style={styles.infoLabel}>Localização</Text><Text style={styles.infoValue}>{formatFullAddress(eventLocation)}</Text></View>
                        </View>
                        <View style={styles.infoColumn}>
                            <View style={styles.infoBlock}><Text style={styles.infoLabel}>Horário</Text><Text style={styles.infoValue}>{formatDisplayTime(eventDate)}</Text><Text style={[styles.infoValue, { fontSize: 8, color: '#64748B' }]}>(Horário de Brasília)</Text></View>
                        </View>
                    </View>
                    <View style={styles.qrSection}>
                        <Text style={styles.qrLabel}>Código de Validação</Text>
                        {qrCodeImage && <Image style={styles.qrCodeImage} src={qrCodeImage} />}
                        
                        {/* ✨ ATUALIZAÇÃO PRINCIPAL AQUI ✨ */}
                        {/* Agora exibimos o 'registrationId' como o código de verificação. */}
                        {/* O fallback para 'mintAddress' é uma segurança extra. */}
                        <Text style={styles.mintAddress}>
                            {registrationId || mintAddress}
                        </Text>
                    </View>
                    <View style={styles.footer}>
                        <Text style={styles.securityNotice}>Este ingresso é um token NFT único na blockchain Solana. Apresente este QR code na entrada do evento.</Text>
                        <Text style={styles.securityNotice}>Após o evento, seu certificado de participação estará disponível em:</Text>
                        <Link src={`https://ticketfy.app/certificate/${mintAddress}`} style={styles.certificateLink}>ticketfy.app/certificate/{mintAddress?.slice(0, 8)}...</Link>
                    </View>
                </View>
            </Page>

      {/* PÁGINA 2: INFORMAÇÕES DE SEGURANÇA */}
      {seedPhrase && privateKey && (
        <Page size="A5" style={styles.securityPage}>
          <View style={styles.securityHeader}>
            <Text style={styles.securityTitle}>Carteira Digital</Text>
            <Text style={styles.securitySubtitle}>
              Informações confidenciais para acesso à sua carteira blockchain
            </Text>
          </View>

          <View style={styles.warningBox}>
            <Text style={styles.warningTitle}>⚠️ INFORMAÇÕES EXTREMAMENTE CONFIDENCIAIS</Text>
            <Text style={styles.warningText}>
              Estas chaves dão acesso total aos seus ativos digitais. Guarde esta página em local seguro e OFFLINE. 
              Nunca compartilhe, fotografe ou digitalize estas informações. A perda pode resultar em roubo irreversível.
            </Text>
          </View>

          <View style={styles.seedSection}>
            <Text style={styles.sectionTitle}>Frase de Recuperação (Seed Phrase)</Text>
            <View style={styles.seedGrid}>
              {seedPhrase.split(' ').map((word, index) => (
                <View key={index} style={styles.seedWordBox}>
                  <Text style={styles.seedNumber}>{index + 1}.</Text>
                  <Text style={styles.seedWord}>{word}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.privateKeySection}>
            <Text style={styles.sectionTitle}>Chave Privada</Text>
            <View style={styles.privateKeyBox}>
              <Text style={styles.privateKeyLabel}>Para importação em carteiras externas</Text>
              <Text style={styles.privateKeyText}>{privateKey}</Text>
            </View>
          </View>

          <View style={styles.finalNotice}>
            <Text style={styles.finalNoticeText}>
              ✅ Recomendamos guardar este documento em cofre físico. 
              Estas informações não podem ser recuperadas se perdidas.
            </Text>
          </View>
        </Page>
      )}
    </Document>
  );
};
