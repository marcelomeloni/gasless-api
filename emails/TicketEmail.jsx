import * as React from 'react';
import { Html, Head, Body, Container, Heading, Text, Img, Section, Hr, Button } from '@react-email/components';

// Este é um componente React que define a aparência do seu e-mail.
// Este é um componente React que define a aparência do seu e-mail.
export function TicketEmail({ userName, eventName, eventDate, eventLocation, eventImage, organizerName, organizerLogo }) {
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
          <Img
            src="https://red-obedient-stingray-854.mypinata.cloud/ipfs/bafkreigpqj7473y2mly3dn6rjnnm3ww4cngbz6kjkgeagt7ifxe2d2g53u"
            width="120"
            alt="Ticketfy Logo"
            style={logo}
          />
          <Heading style={h1}>Seu ingresso chegou!</Heading>
          <Text style={text}>
            Olá, <strong>{userName}</strong>!
          </Text>
          <Text style={text}>
            Obrigado por garantir sua presença. Seu ingresso para o evento <strong>{eventName}</strong> está anexado a este e-mail.
          </Text>
          
          {/* Nova Imagem do Evento */}
          {eventImage && (
            <Img
              src={eventImage}
              width="100%"
              alt={`Imagem do evento: ${eventName}`}
              style={eventImageStyle}
            />
          )}

          <Section style={ticketDetails}>
            <Text style={detailLabel}>Evento:</Text>
            <Text style={detailValue}>{eventName}</Text>
            <Hr style={hr} />
            <Text style={detailLabel}>Data:</Text>
            <Text style={detailValue}>{formattedDate}</Text>
            <Hr style={hr} />
            <Text style={detailLabel}>Local:</Text>
            <Text style={detailValue}>{eventLocation}</Text>
          </Section>

          {/* Nova Seção do Organizador */}
          <Section style={organizerSection}>
            <Text style={organizerLabel}>Realização:</Text>
            <Container style={organizerContainer}>
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
            </Container>
          </Section>

          {/* Novo Botão de Ação (CTA) */}
          <Section style={ctaSection}>
            <Button href="https://sua-url-de-detalhes.com" style={buttonStyle}>
              Ver Detalhes do Evento
            </Button>
          </Section>

          <Text style={text}>
            Nos vemos lá!
          </Text>
          <Text style={footer}>
            Equipe Ticketfy
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

// Adicione esses novos estilos ao seu objeto de estilos existente
const eventImageStyle = {
  margin: '20px 0',
  borderRadius: '8px',
};

const organizerSection = {
  margin: '20px 30px',
  padding: '16px',
  backgroundColor: '#f8fafc',
  borderRadius: '8px',
};

const organizerLabel = {
  color: '#64748b',
  fontSize: '12px',
  textTransform: 'uppercase',
  marginBottom: '8px',
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
  color: '#1d2333',
  fontSize: '16px',
  fontWeight: 'bold',
};

const ctaSection = {
  textAlign: 'center',
  margin: '30px',
};

const buttonStyle = {
  backgroundColor: '#6366f1',
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '6px',
  textDecoration: 'none',
  fontWeight: 'bold',
};
