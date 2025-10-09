import * as React from 'react';
import { Html, Head, Body, Container, Heading, Text, Img, Section, Hr } from '@react-email/components';

export function TicketEmail({ 
  userName, 
  eventName, 
  eventDate, 
  eventLocation,  // ✅ JÁ DEVE VIR FORMATADO COMO STRING
  eventImage,
  organizerName,
  organizerLogo
}) {
  // ✅ CORREÇÃO CRÍTICA: Formatação segura da data
  const formatDateSafely = (dateString) => {
    if (!dateString || dateString === "Data a ser definida") {
      return "Data a ser definida";
    }
    
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) {
        return "Data a ser definida";
      }
      
      return date.toLocaleString('pt-BR', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'America/Sao_Paulo',
      });
    } catch (error) {
      return "Data a ser definida";
    }
  };

  const formattedDate = formatDateSafely(eventDate);

  // ✅ DEBUG CRÍTICO - Remover após corrigir
  console.log('🔍 DADOS NO EMAIL COMPONENT:', {
    eventName,
    eventDate,
    eventLocation, // Deve ser string "a\na, a\na\na - a\nCEP: a"
    formattedDate,
    organizerName
  });

  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          {/* BANNER EM DESTAQUE - OCUPA LARGURA TOTAL */}
          {eventImage && (
            <Section style={bannerSection}>
              <Img
                src={eventImage}
                width="100%"
                alt={`Banner do evento: ${eventName}`}
                style={bannerImage}
              />
            </Section>
          )}
          
          <Section style={contentSection}>
            <Heading style={h1}>SEU INGRESSO CHEGOU! 🎉</Heading>
            
            <Text style={text}>
              Olá, <strong style={highlight}>{userName}</strong>!
            </Text>
            
            <Text style={text}>
              Você garantiu seu lugar no <strong style={highlight}>{eventName}</strong>
            </Text>

            {/* DETALHES DO EVENTO */}
            <Section style={detailsSection}>
              <Text style={detailLabel}>📅 DATA E HORA</Text>
              <Text style={detailValue}>{formattedDate}</Text>
              
              <Hr style={hr} />
              
              <Text style={detailLabel}>📍 LOCAL</Text>
              {/* ✅ CORREÇÃO CRÍTICA: Manter quebras de linha */}
              <Text style={{...detailValue, whiteSpace: 'pre-line'}}>
                {eventLocation || "Local a ser definido"}
              </Text>
            </Section>

            {/* ORGANIZADOR */}
            {organizerName && organizerName !== "Organizador" && (
              <Section style={organizerSection}>
                <Text style={organizerLabel}>Realização:</Text>
                <Section style={organizerContainer}>
                  {organizerLogo && (
                    <Img
                      src={organizerLogo}
                      width="40"
                      height="40"
                      alt={`Logo do organizador: ${organizerName}`}
                      style={organizerLogoStyle}
                    />
                  )}
                  <Text style={organizerName}>{organizerName}</Text>
                </Section>
              </Section>
            )}

            <Text style={footer}>
              Seu ingresso em PDF está anexado a este e-mail. Nos vemos no evento! 🎊
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// ESTILOS ATUALIZADOS
const main = {
  backgroundColor: '#0f0f0f',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  padding: '20px 0',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  maxWidth: '700px',
  borderRadius: '12px',
  overflow: 'hidden',
  boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
};

const bannerSection = {
  margin: '0',
};

const bannerImage = {
  width: '100%',
  height: '250px',
  objectFit: 'cover',
  display: 'block',
};

const contentSection = {
  padding: '30px',
};

const h1 = {
  color: '#1d2333',
  fontSize: '28px',
  fontWeight: 'bold',
  textAlign: 'center',
  margin: '0 0 20px 0',
};

const text = {
  color: '#3c414a',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '0 0 16px 0',
};

const highlight = {
  color: '#6366f1',
};

const detailsSection = {
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  padding: '20px',
  margin: '20px 0',
};

const detailLabel = {
  color: '#64748b',
  fontSize: '12px',
  textTransform: 'uppercase',
  fontWeight: 'bold',
  margin: '0 0 4px 0',
};

const detailValue = {
  color: '#1d2333',
  fontSize: '16px',
  fontWeight: 'bold',
  margin: '0 0 12px 0',
};

const hr = {
  borderColor: '#e2e8f0',
  margin: '12px 0',
};

const organizerSection = {
  padding: '16px',
  backgroundColor: '#f8fafc',
  borderRadius: '8px',
  margin: '20px 0',
};

const organizerLabel = {
  color: '#64748b',
  fontSize: '12px',
  textTransform: 'uppercase',
  margin: '0 0 8px 0',
};

const organizerContainer = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
};

const organizerLogoStyle = {
  borderRadius: '4px',
};

const organizerName = {
  color: '#1e293b',
  fontSize: '16px',
  fontWeight: 'bold',
};

const footer = {
  color: '#64748b',
  fontSize: '14px',
  textAlign: 'center',
  margin: '20px 0 0 0',
};
