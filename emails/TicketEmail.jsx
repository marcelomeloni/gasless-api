import * as React from 'react';
import { Html, Head, Body, Container, Heading, Text, Img, Section, Hr, Button, Row, Column } from '@react-email/components';

export function TicketEmail({ 
  userName, 
  eventName, 
  eventDate, 
  eventLocation, 
  eventImage,
  organizerName,
  organizerLogo,
  eventDescription 
}) {
  const formattedDate = new Date(eventDate).toLocaleString('pt-BR', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  });

  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          {/* Banner do Evento em Destaque */}
          <Section style={bannerSection}>
            <Img
              src={eventImage}
              width="100%"
              alt={`Banner do evento: ${eventName}`}
              style={bannerImage}
            />
            <Section style={overlayText}>
              <Heading style={h1}>SEU INGRESSO ESTÁ PRONTO! 🎉</Heading>
              <Text style={subtitle}>Prepare-se para uma experiência incrível</Text>
            </Section>
          </Section>

          {/* Mensagem Pessoal */}
          <Section style={messageSection}>
            <Text style={text}>
              E aí, <strong style={highlight}>{userName}</strong>! 
            </Text>
            <Text style={text}>
              Você acaba de garantir seu lugar no <strong>{eventName}</strong> - 
              {eventDescription}
            </Text>
          </Section>

          {/* Grid de Informações em Destaque */}
          <Section style={gridSection}>
            <Row>
              <Column style={gridColumn}>
                <Img
                  src="https://cdn-icons-png.flaticon.com/512/833/833593.png"
                  width="40"
                  height="40"
                  alt="Ícone de calendário"
                  style={icon}
                />
                <Text style={gridLabel}>QUANDO</Text>
                <Text style={gridValue}>{formattedDate}</Text>
              </Column>
              <Column style={gridColumn}>
                <Img
                  src="https://cdn-icons-png.flaticon.com/512/684/684809.png"
                  width="40"
                  height="40"
                  alt="Ícone de localização"
                  style={icon}
                />
                <Text style={gridLabel}>ONDE</Text>
                <Text style={gridValue}>{eventLocation.replace(/\n/g, ', ')}</Text>
              </Column>
            </Row>
          </Section>

          {/* Organizador */}
          <Section style={organizerSection}>
            <Text style={organizerLabel}>Realização:</Text>
            <Section style={organizerContainer}>
              {organizerLogo && (
                <Img
                  src={organizerLogo}
                  width="50"
                  height="50"
                  alt={`Logo do organizador: ${organizerName}`}
                  style={organizerLogoStyle}
                />
              )}
              <Text style={organizerName}>{organizerName}</Text>
            </Section>
          </Section>

          {/* Call-to-Action */}
          <Section style={ctaSection}>
            <Text style={ctaText}>Seu ingresso está anexado a este e-mail em PDF!</Text>
            <Text style={ctaSubtext}>Guarde bem e nos vemos no evento! ✨</Text>
          </Section>

          {/* Footer */}
          <Section style={footerSection}>
            <Text style={footerText}>
              Equipe Ticketfy • Este ingresso é pessoal e intransferível
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Estilos atualizados para o visual moderno
const main = {
  backgroundColor: '#0f0f0f',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
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
  position: 'relative',
  margin: '0',
};

const bannerImage = {
  width: '100%',
  height: '300px',
  objectFit: 'cover',
  display: 'block',
};

const overlayText = {
  position: 'absolute',
  top: '0',
  left: '0',
  right: '0',
  bottom: '0',
  backgroundColor: 'rgba(0,0,0,0.4)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  padding: '20px',
  textAlign: 'center',
};

const h1 = {
  color: '#ffffff',
  fontSize: '36px',
  fontWeight: 'bold',
  margin: '0 0 10px 0',
  textShadow: '2px 2px 4px rgba(0,0,0,0.5)',
};

const subtitle = {
  color: '#f0f0f0',
  fontSize: '18px',
  margin: '0',
  fontWeight: 'normal',
};

const messageSection = {
  padding: '30px',
  backgroundColor: '#f8fafc',
};

const text = {
  color: '#334155',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '0 0 16px 0',
};

const highlight = {
  color: '#6366f1',
};

const gridSection = {
  padding: '30px',
  backgroundColor: '#ffffff',
};

const gridColumn = {
  padding: '20px',
  textAlign: 'center',
  verticalAlign: 'top',
  width: '50%',
};

const icon = {
  margin: '0 auto 12px auto',
};

const gridLabel = {
  color: '#64748b',
  fontSize: '12px',
  textTransform: 'uppercase',
  fontWeight: 'bold',
  margin: '0 0 8px 0',
};

const gridValue = {
  color: '#1e293b',
  fontSize: '14px',
  fontWeight: 'bold',
  lineHeight: '20px',
  margin: '0',
};

const organizerSection = {
  padding: '20px 30px',
  backgroundColor: '#f1f5f9',
  borderTop: '1px solid #e2e8f0',
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
  borderRadius: '6px',
};

const organizerName = {
  color: '#1e293b',
  fontSize: '16px',
  fontWeight: 'bold',
};

const ctaSection = {
  padding: '30px',
  backgroundColor: '#6366f1',
  textAlign: 'center',
};

const ctaText = {
  color: '#ffffff',
  fontSize: '18px',
  fontWeight: 'bold',
  margin: '0 0 8px 0',
};

const ctaSubtext = {
  color: '#e0e7ff',
  fontSize: '14px',
  margin: '0',
};

const footerSection = {
  padding: '20px 30px',
  backgroundColor: '#1e293b',
  textAlign: 'center',
};

const footerText = {
  color: '#94a3b8',
  fontSize: '12px',
  margin: '0',
};
